// Prueba local de la persistencia en Redis externo (Upstash REST).
// Usa un servidor falso de Upstash en el puerto 3201 con dos modos, porque
// la API real puede guardar el cuerpo tal cual ('raw') o interpretarlo como
// JSON ('parsed'); el código debe funcionar con los dos. También prueba que
// un valor viejo guardado con doble codificación (el bug del 2026-11-12)
// se restaure bien.
// El panel corre en el puerto 3202 con DATA_DIR temporal; el "reinicio de
// Render" se simula arrancando de nuevo con un DATA_DIR vacío.
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const MOCK_PORT = 3201;
const PANEL_PORT = 3202;
const BASE = 'http://127.0.0.1:' + PANEL_PORT;
const ADMIN = { 'x-acceso-admin': 'test123' };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function j(method, p, body, headers = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}

// Servidor falso de Upstash REST: GET /get/<key>, POST /set/<key>.
// Modo 'raw': guarda el cuerpo tal cual. Modo 'parsed': lo interpreta
// como JSON antes de guardarlo. Exige el token Bearer test-token.
function startMock(mode) {
  const kv = {};
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if ((req.headers.authorization || '') !== 'Bearer test-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const key = decodeURIComponent(u.pathname.split('/')[2] || '');
    if (req.method === 'GET' && u.pathname.startsWith('/get/')) {
      const v = kv[key];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: v === undefined ? null : v }));
    } else if (req.method === 'POST' && u.pathname.startsWith('/set/')) {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        if (mode === 'parsed') {
          try { kv[key] = JSON.parse(body); } catch { kv[key] = body; }
        } else {
          kv[key] = body;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: 'OK' }));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise(r => server.listen(MOCK_PORT, () => r({ server, kv })));
}

let child = null;
async function startPanel(dataDir) {
  child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PANEL_PORT),
      ADMIN_KEY: 'test123',
      DATA_DIR: dataDir,
      UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:' + MOCK_PORT,
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error('el servidor no arrancó');
}
async function stopPanel() {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise(r => child.once('exit', r));
  child = null;
}

// Un ciclo: registra un usuario, espera el respaldo, reinicia con disco
// vacío y verifica que el registro (y la llave del servidor) sobrevivieron.
async function roundTrip(mode, phone) {
  const mock = await startMock(mode);
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ratbani-pers-'));
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ratbani-pers-'));
  try {
    await startPanel(dir1);
    const reg = await j('POST', '/api/registration/manual', { name: 'Persistencia', email: 'pers@test.com', phone });
    if (reg.data.status !== 'approved') return { ok: false, why: 'registro no quedó aprobado: ' + reg.data.status };
    await sleep(1200); // respaldo (debounce 300 ms)
    const keyBefore = JSON.parse(fs.readFileSync(path.join(dir1, 'server-key.json'), 'utf8'));
    await stopPanel();
    // Disco nuevo: simula el borrado de Render.
    await startPanel(dir2);
    const h = await j('GET', '/health');
    const list = await j('GET', '/api/admin/registrations', null, ADMIN);
    const found = (list.data.registrations || []).some(r => r.phone === phone && r.status === 'approved');
    const keyAfter = JSON.parse(fs.readFileSync(path.join(dir2, 'server-key.json'), 'utf8'));
    const keyOk = keyAfter.privateKey === keyBefore.privateKey;
    return { ok: h.data.registrations === 1 && found && keyOk, why: 'health=' + h.data.registrations + ' encontrado=' + found + ' llave=' + keyOk };
  } finally {
    await stopPanel();
    mock.server.close();
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
}

(async () => {
  try {
    const a = await roundTrip('raw', '+529999999999');
    console.log('A. modo raw (bytes tal cual):', a.ok, '|', a.why || '');
    const b = await roundTrip('parsed', '+527777777777');
    console.log('B. modo parsed (JSON interpretado):', b.ok, '|', b.why || '');

    // C. Valor viejo con doble codificación (el bug): se siembra directo en
    // el falso Upstash y el servidor debe restaurarlo al arrancar.
    const mockC = await startMock('raw');
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ratbani-pers-'));
    try {
      const legacyStore = { registrations: [{ id: 'legado-1', name: 'Legado', email: 'legado@test.com', phone: '+528888888888', plan: 'mensual', status: 'pending', source: 'manual', createdAt: new Date().toISOString() }], devices: [], challenges: {}, otps: {}, accessLog: [] };
      mockC.kv['ratbani:store'] = JSON.stringify(JSON.stringify(legacyStore));
      await startPanel(dir3);
      const h3 = await j('GET', '/health');
      const tC = h3.data.registrations === 1;
      console.log('C. legado doble codificado:', tC, '| health=' + h3.data.registrations);
      const ok = a.ok && b.ok && tC;
      console.log(ok ? 'TODO OK' : 'FALLO ALGO');
      process.exitCode = ok ? 0 : 1;
    } finally {
      await stopPanel();
      mockC.server.close();
      fs.rmSync(dir3, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
})();
