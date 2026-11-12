// Prueba local de los planes de pago (mensual / único) y la cuenta atrás.
// Arranca su propio servidor en el puerto 3106 con un DATA_DIR temporal.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BASE = 'http://127.0.0.1:3106';
const ADMIN = { 'x-acceso-admin': 'test123' };
async function j(method, p, body, headers = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
let child = null;
async function startServer(dataDir) {
  child = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '3106', ADMIN_KEY: 'test123', DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error('el servidor no arrancó');
}
async function stopServer() {
  if (!child) return;
  child.kill('SIGTERM');
  await new Promise(r => child.once('exit', r));
  child = null;
}
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratbani-plans-'));
  const storePath = path.join(dataDir, 'store.json');
  try {
    await startServer(dataDir);

    // 1. Registro manual nuevo -> plan mensual, 30 días de vigencia.
    const reg = await j('POST', '/api/registration/manual', { name: 'Plan Mensual', email: 'mensual@test.com', phone: '+521111111111' });
    const leaseMs = Date.parse(reg.data.leaseExpiresAt || '') - Date.now();
    const t1 = reg.data.status === 'approved' && reg.data.plan === 'mensual' && leaseMs > 29 * 86400e3 && leaseMs <= 30 * 86400e3;
    console.log('1. registro mensual:', reg.data.plan, '| lease ~30d:', t1, '|', reg.data.leaseExpiresAt);
    const regId = reg.data.registrationId;

    // 2. El admin marca pago único -> sin vencimiento.
    const unico = await j('PATCH', '/api/admin/registrations/' + regId, { action: 'set-plan', plan: 'unico' }, ADMIN);
    const t2 = unico.data.registration.plan === 'unico' && unico.data.registration.leaseExpiresAt === null && unico.data.registration.status === 'approved';
    console.log('2. plan único:', unico.data.registration.plan, '| lease:', unico.data.registration.leaseExpiresAt, '|', t2);

    // 3. El admin lo pasa a mensual -> vuelve a 30 días.
    const mens = await j('PATCH', '/api/admin/registrations/' + regId, { action: 'set-plan', plan: 'mensual' }, ADMIN);
    const leaseMs3 = Date.parse(mens.data.registration.leaseExpiresAt || '') - Date.now();
    const t3 = mens.data.registration.plan === 'mensual' && leaseMs3 > 29 * 86400e3 && leaseMs3 <= 30 * 86400e3;
    console.log('3. plan mensual:', mens.data.registration.plan, '| lease ~30d:', t3);

    // 4. Estado del dispositivo antes de vencer -> permitido.
    const st1 = await j('GET', '/api/device/status?registrationId=' + regId);
    const t4 = st1.data.allowed === true && st1.data.status === 'approved';
    console.log('4. status antes de vencer: allowed=' + st1.data.allowed, '|', t4);

    // 5. Se vence la mensualidad (se pone el lease en el pasado y se reinicia) -> no permitido.
    await stopServer();
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const rec = store.registrations.find(r => r.id === regId);
    rec.leaseExpiresAt = new Date(Date.now() - 60000).toISOString();
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
    await startServer(dataDir);
    const st2 = await j('GET', '/api/device/status?registrationId=' + regId);
    const t5 = st2.data.allowed === false && st2.data.status === 'expired';
    console.log('5. status vencido: allowed=' + st2.data.allowed, '| status=' + st2.data.status, '|', t5);

    // 6. Paga otra vez (mensual) -> vigencia renovada y acceso de vuelta.
    await j('PATCH', '/api/admin/registrations/' + regId, { action: 'set-plan', plan: 'mensual' }, ADMIN);
    const st3 = await j('GET', '/api/device/status?registrationId=' + regId);
    const t6 = st3.data.allowed === true && st3.data.status === 'approved';
    console.log('6. tras pagar de nuevo: allowed=' + st3.data.allowed, '|', t6);

    const ok = t1 && t2 && t3 && t4 && t5 && t6;
    console.log(ok ? 'TODO OK' : 'FALLO ALGO');
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await stopServer();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
