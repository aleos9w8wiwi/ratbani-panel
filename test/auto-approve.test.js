// Prueba local de la aprobación automática (simula la app exacta).
const crypto = require('crypto');
const BASE = 'http://127.0.0.1:3105';
async function j(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}
(async () => {
  // Llave del "dispositivo" (EC P-256 como la app).
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  // 1. Registro manual con llave de dispositivo -> debe salir aprobado.
  const reg = await j('POST', '/api/registration/manual', { name: 'Prueba Auto', email: 'auto@test.com', phone: '+521111111111', publicKey: pubB64 });
  console.log('1. registro manual:', reg.data.status, '|', reg.data.message);
  const regId = reg.data.registrationId;

  // 2. Flujo de arranque de la app: reto -> firma -> status -> allowed:true.
  const ch = await j('POST', '/api/device/challenge', { registrationId: regId });
  const sig = crypto.sign(null, Buffer.from(ch.data.nonce), privateKey).toString('base64');
  const st = await j('POST', '/api/device/status', { registrationId: regId, challengeId: ch.data.challengeId, signature: sig });
  console.log('2. status de la app:', 'allowed=' + st.data.allowed, '| status=' + st.data.status);

  // 3. Claim con teléfono nuevo (sin registro) -> debe crearlo aprobado.
  const { publicKey: pub2, privateKey: priv2 } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub2B64 = pub2.export({ type: 'spki', format: 'der' }).toString('base64');
  const ch2 = await j('POST', '/api/device/challenge', { phone: '+522222222222', publicKey: pub2B64 });
  const sig2 = crypto.sign(null, Buffer.from(ch2.data.nonce), priv2).toString('base64');
  const claim = await j('POST', '/api/device/claim', { challengeId: ch2.data.challengeId, signature: sig2, publicKey: pub2B64, phone: '+522222222222' });
  console.log('3. claim teléfono nuevo:', 'status=' + claim.data.status);

  // 4. El admin rechaza a alguien; si se vuelve a registrar, NO se auto-aprueba.
  const reg3 = await j('POST', '/api/registration/manual', { name: 'Rechazado', email: 'rej@test.com', phone: '+523333333333' });
  await j('PATCH', '/api/admin/registrations/' + reg3.data.registrationId, { action: 'reject' }, { 'x-acceso-admin': 'test123' });
  const reg4 = await j('POST', '/api/registration/manual', { name: 'Rechazado', email: 'rej@test.com', phone: '+523333333333' });
  console.log('4. re-registro tras rechazo del admin:', 'status=' + reg4.data.status);

  const ok = reg.data.status === 'approved' && st.data.allowed === true && claim.data.status === 'active' && reg4.data.status === 'rejected';
  console.log(ok ? 'TODO OK' : 'FALLO ALGO');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
