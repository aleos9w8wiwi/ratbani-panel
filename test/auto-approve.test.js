// Prueba local del acceso automático con TOPE de 10 (activado 2026-11-12).
// La solicitud nueva se aprueba sola mientras las aprobadas no lleguen a 10;
// al llegar al tope, las nuevas quedan PENDIENTES hasta que el admin las
// apruebe en el panel. La aprobación manual del admin no tiene tope.
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

  // 1. Registro manual con cupo libre -> se aprueba SOLO, con vigencia de 1 mes.
  const reg = await j('POST', '/api/registration/manual', { name: 'Prueba Auto', email: 'auto@test.com', phone: '+521111111111', publicKey: pubB64 });
  const leaseMs = reg.data.leaseExpiresAt ? Date.parse(reg.data.leaseExpiresAt) - Date.now() : 0;
  console.log('1. registro manual:', reg.data.status, '|', reg.data.message, '| vigencia ~30d:', leaseMs > 29 * 864e5 && leaseMs < 31 * 864e5);
  const regId = reg.data.registrationId;

  // 2. Flujo de arranque de la app con registro aprobado -> SÍ abre.
  const ch = await j('POST', '/api/device/challenge', { registrationId: regId });
  const sig = crypto.sign(null, Buffer.from(ch.data.nonce), privateKey).toString('base64');
  const st = await j('POST', '/api/device/status', { registrationId: regId, challengeId: ch.data.challengeId, signature: sig });
  console.log('2. status aprobado:', 'allowed=' + st.data.allowed, '| status=' + st.data.status);

  // 3. Claim con teléfono nuevo (sin registro) -> se aprueba solo (status active).
  const { publicKey: pub2, privateKey: priv2 } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub2B64 = pub2.export({ type: 'spki', format: 'der' }).toString('base64');
  const ch2 = await j('POST', '/api/device/challenge', { phone: '+522222222222', publicKey: pub2B64 });
  const sig2 = crypto.sign(null, Buffer.from(ch2.data.nonce), priv2).toString('base64');
  const claim = await j('POST', '/api/device/claim', { challengeId: ch2.data.challengeId, signature: sig2, publicKey: pub2B64, phone: '+522222222222' });
  console.log('3. claim teléfono nuevo:', 'status=' + claim.data.status);

  // 4. Rechazar libera el teléfono: si se vuelve a registrar, le llega una
  // solicitud NUEVA (aprobada sola porque aún hay cupo).
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

  // 6. Llenar el cupo: ya hay 3 aprobadas (1, 3 y 4); 7 más llegan a 10.
  let fillOk = true;
  for (let i = 0; i < 7; i++) {
    const r = await j('POST', '/api/registration/manual', { name: 'Relleno ' + i, email: 'relleno' + i + '@test.com', phone: '+5250000000' + i });
    if (r.data.status !== 'approved') fillOk = false;
  }
  console.log('6. relleno hasta 10 aprobadas:', fillOk);

  // 7. La número 11 ya NO se aprueba sola: queda pendiente y la app no abre.
  const regP = await j('POST', '/api/registration/manual', { name: 'Tope', email: 'tope@test.com', phone: '+529999999999' });
  const chP = await j('POST', '/api/device/challenge', { registrationId: regP.data.registrationId });
  const { publicKey: pubP, privateKey: privP } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const sigP = crypto.sign(null, Buffer.from(chP.data.nonce), privP).toString('base64');
  const stP = await j('POST', '/api/device/status', { registrationId: regP.data.registrationId, challengeId: chP.data.challengeId, signature: sigP });
  console.log('7. registro 11 (tope):', 'status=' + regP.data.status, '| app allowed=' + stP.data.allowed);

  // 8. El admin sí puede aprobarla a mano aunque esté lleno el tope; la
  // siguiente que llegue sigue pendiente (11 aprobadas >= 10).
  await j('PATCH', '/api/admin/registrations/' + regP.data.registrationId, { action: 'approve' }, { 'x-acceso-admin': 'test123' });
  const regQ = await j('POST', '/api/registration/manual', { name: 'Tope 2', email: 'tope2@test.com', phone: '+528888888888' });
  console.log('8. tras aprobar a mano, la siguiente:', 'status=' + regQ.data.status);

  const ok = reg.data.status === 'approved' && leaseMs > 29 * 864e5 && leaseMs < 31 * 864e5 && st.data.allowed === true && st.data.status === 'approved' && claim.data.status === 'active' && reg4.data.status === 'approved' && reg4.data.registrationId !== reg3.data.registrationId && reg6.data.status === 'revoked' && reg6.data.registrationId === reg5.data.registrationId && fillOk && regP.data.status === 'pending' && stP.data.allowed === false && regQ.data.status === 'pending';
  console.log(ok ? 'TODO OK' : 'FALLO ALGO');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
