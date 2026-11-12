// Prueba local de la aprobación MANUAL (sin acceso automático).
// El acceso automático se quitó el 2026-11-12: la solicitud nueva queda
// PENDIENTE y solo el admin la aprueba en el panel (Aprobar o ponerle un plan).
// Requiere un servidor corriendo en el puerto 3105 (ADMIN_KEY=test123).
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

  // 1. Registro manual -> queda PENDIENTE (ya no se aprueba solo).
  const reg = await j('POST', '/api/registration/manual', { name: 'Prueba Manual', email: 'manual@test.com', phone: '+521111111111', publicKey: pubB64 });
  console.log('1. registro manual:', reg.data.status, '|', reg.data.message);
  const regId = reg.data.registrationId;

  // 2. Flujo de arranque de la app con registro pendiente -> NO abre.
  const ch = await j('POST', '/api/device/challenge', { registrationId: regId });
  const sig = crypto.sign(null, Buffer.from(ch.data.nonce), privateKey).toString('base64');
  const st = await j('POST', '/api/device/status', { registrationId: regId, challengeId: ch.data.challengeId, signature: sig });
  console.log('2. status pendiente:', 'allowed=' + st.data.allowed, '| status=' + st.data.status);

  // 2b. El admin lo aprueba -> ahora sí abre.
  await j('PATCH', '/api/admin/registrations/' + regId, { action: 'approve' }, { 'x-acceso-admin': 'test123' });
  const ch2b = await j('POST', '/api/device/challenge', { registrationId: regId });
  const sig2b = crypto.sign(null, Buffer.from(ch2b.data.nonce), privateKey).toString('base64');
  const st2b = await j('POST', '/api/device/status', { registrationId: regId, challengeId: ch2b.data.challengeId, signature: sig2b });
  console.log('2b. status tras aprobar:', 'allowed=' + st2b.data.allowed, '| status=' + st2b.data.status);

  // 3. Claim con teléfono nuevo (sin registro) -> crea la solicitud pendiente.
  const { publicKey: pub2, privateKey: priv2 } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub2B64 = pub2.export({ type: 'spki', format: 'der' }).toString('base64');
  const ch2 = await j('POST', '/api/device/challenge', { phone: '+522222222222', publicKey: pub2B64 });
  const sig2 = crypto.sign(null, Buffer.from(ch2.data.nonce), priv2).toString('base64');
  const claim = await j('POST', '/api/device/claim', { challengeId: ch2.data.challengeId, signature: sig2, publicKey: pub2B64, phone: '+522222222222' });
  console.log('3. claim teléfono nuevo:', 'status=' + claim.data.status);

  // 4. Rechazar libera el teléfono: si se vuelve a registrar, le llega
  // una solicitud NUEVA pendiente (el registro viejo queda como rejected).
  const reg3 = await j('POST', '/api/registration/manual', { name: 'Rechazado', email: 'rej@test.com', phone: '+523333333333' });
  await j('PATCH', '/api/admin/registrations/' + reg3.data.registrationId, { action: 'reject' }, { 'x-acceso-admin': 'test123' });
  const reg4 = await j('POST', '/api/registration/manual', { name: 'Rechazado', email: 'rej@test.com', phone: '+523333333333' });
  console.log('4. re-registro tras rechazo del admin:', 'status=' + reg4.data.status, '| nuevo id:', reg4.data.registrationId !== reg3.data.registrationId);

  // 5. Desvincular (revoke) sí se respeta: si se vuelve a registrar, sigue
  // bloqueado con el mismo registro viejo.
  const reg5 = await j('POST', '/api/registration/manual', { name: 'Desvinculado', email: 'des@test.com', phone: '+524444444444' });
  await j('PATCH', '/api/admin/registrations/' + reg5.data.registrationId, { action: 'revoke' }, { 'x-acceso-admin': 'test123' });
  const reg6 = await j('POST', '/api/registration/manual', { name: 'Desvinculado', email: 'des@test.com', phone: '+524444444444' });
  console.log('5. re-registro tras desvincular:', 'status=' + reg6.data.status, '| mismo id:', reg6.data.registrationId === reg5.data.registrationId);

  const ok = reg.data.status === 'pending' && st.data.allowed === false && st.data.status === 'pending' && st2b.data.allowed === true && st2b.data.status === 'approved' && claim.data.status === 'pending' && reg4.data.status === 'pending' && reg4.data.registrationId !== reg3.data.registrationId && reg6.data.status === 'revoked' && reg6.data.registrationId === reg5.data.registrationId;
  console.log(ok ? 'TODO OK' : 'FALLO ALGO');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
