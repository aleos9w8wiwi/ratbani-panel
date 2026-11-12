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

    // 1. Registro manual nuevo -> queda PENDIENTE (sin acceso automático),
    // plan mensual, sin vigencia hasta que el admin lo apruebe.
    const reg = await j('POST', '/api/registration/manual', { name: 'Plan Mensual', email: 'mensual@test.com', phone: '+521111111111' });
    const t1 = reg.data.status === 'pending' && reg.data.plan === 'mensual' && reg.data.leaseExpiresAt === null;
    console.log('1. registro pendiente:', reg.data.status, '| plan:', reg.data.plan, '| lease:', reg.data.leaseExpiresAt, '|', t1);
    const regId = reg.data.registrationId;

    // 1b. El admin lo aprueba -> aprobado con 30 días de vigencia.
    const apr = await j('PATCH', '/api/admin/registrations/' + regId, { action: 'approve' }, ADMIN);
    const leaseApr = Date.parse(apr.data.registration.leaseExpiresAt || '') - Date.now();
    const t1b = apr.data.registration.status === 'approved' && leaseApr > 29 * 86400e3 && leaseApr <= 30 * 86400e3;
    console.log('1b. admin aprueba:', apr.data.registration.status, '| lease ~30d:', t1b);

    // 2. El admin marca pago único -> sin vencimiento.
    const unico = await j('PATCH', '/api/admin/registrations/' + regId, { action: 'set-plan', plan: 'unico' }, ADMIN);
    const t2 = unico.data.registration.plan === 'unico' && unico.data.registration.leaseExpiresAt === null && unico.data.registration.status === 'approved';
    console.log('2. plan único:', unico.data.registration.plan, '| lease:', unico.data.registration.leaseExpiresAt, '|', t2);

    // 3. El admin lo pasa a mensual -> vuelve a 30 días.
    const mens = await j('PATCH', '/api/admin/registrations/' + regId, { action: 'set-plan', plan: 'mensual' }, ADMIN);
    const leaseMs3 = Date.parse(mens.data.registration.leaseExpiresAt || '') - Date.now();
    const t3 = mens.data.registration.plan === 'mensual' && leaseMs3 > 29 * 86400e3 && leaseMs3 <= 30 * 86400e3;
    console.log('3. plan mensual:', mens.data.registration.plan, '| lease ~30d:', t3);

    // 3b. Plan de 7 días -> vigencia ~7 días.
    const d7 = await j('PATCH', '/api/admin/registrations/' + regId, { action: 'set-plan', plan: '7d' }, ADMIN);
    const lease7 = Date.parse(d7.data.registration.leaseExpiresAt || '') - Date.now();
    const t3b = d7.data.registration.plan === '7d' && lease7 > 6 * 86400e3 && lease7 <= 7 * 86400e3;
    console.log('3b. plan 7 días:', d7.data.registration.plan, '| lease ~7d:', t3b);

    // 3c. Plan de 2 meses -> vigencia ~60 días.
    const d2m = await j('PATCH', '/api/admin/registrations/' + regId, { action: 'set-plan', plan: '2m' }, ADMIN);
    const lease2m = Date.parse(d2m.data.registration.leaseExpiresAt || '') - Date.now();
    const t3c = d2m.data.registration.plan === '2m' && lease2m > 59 * 86400e3 && lease2m <= 60 * 86400e3;
    console.log('3c. plan 2 meses:', d2m.data.registration.plan, '| lease ~60d:', t3c);

    // 3d. Plan de 1 día -> vigencia ~1 día.
    const d1 = await j('PATCH', '/api/admin/registrations/' + regId, { action: 'set-plan', plan: '1d' }, ADMIN);
    const lease1 = Date.parse(d1.data.registration.leaseExpiresAt || '') - Date.now();
    const t3d = d1.data.registration.plan === '1d' && lease1 > 0 && lease1 <= 1 * 86400e3;
    console.log('3d. plan 1 día:', d1.data.registration.plan, '| lease ~1d:', t3d);

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

    // 7. Rechazar libera el teléfono: la persona puede registrarse de nuevo.
    const regB = await j('POST', '/api/registration/manual', { name: 'Rechazado', email: 'rechazado@test.com', phone: '+522222222222' });
    const regBId = regB.data.registrationId;
    const rej = await j('PATCH', '/api/admin/registrations/' + regBId, { action: 'reject' }, ADMIN);
    const t7a = rej.data.registration.status === 'rejected' && rej.data.registration.archived === true;
    const stOld = await j('GET', '/api/device/status?registrationId=' + regBId);
    const t7b = stOld.data.allowed === false && stOld.data.status === 'rejected';
    const regC = await j('POST', '/api/registration/manual', { name: 'Rechazado Otra Vez', email: 'rechazado2@test.com', phone: '+522222222222' });
    const t7c = regC.data.registrationId !== regBId && regC.data.status === 'pending';
    const list = await j('GET', '/api/admin/registrations', null, ADMIN);
    const oldStillThere = list.data.registrations.some(r => r.id === regBId && r.status === 'rejected');
    const t7 = t7a && t7b && t7c && oldStillThere;
    console.log('7. rechazar y registrar de nuevo:', '| rechazado+archivado:', t7a, '| viejo bloqueado:', t7b, '| nuevo pendiente:', t7c, '| viejo visible:', oldStillThere, '|', t7);

    const ok = t1 && t1b && t2 && t3 && t3b && t3c && t3d && t4 && t5 && t6 && t7;
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
