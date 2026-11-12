// Servidor del panel de acceso de Ratbani
// ================================
// Para la APK Ratbani (AccessActivity / RegistrationActivity).
// La APK habla con su origen HTTPS (acceso.API_ORIGIN) con estos endpoints:
//   GET  /api/design              -> diseño del panel (marca, colores, textos)
//   POST /api/device/challenge    -> reto de firma del dispositivo (ECDSA P-256)
//   POST /api/device/claim        -> el dispositivo reclama su activación con la firma
//   POST /api/device/status       -> estado firmado: la app manda {registrationId, challengeId, signature}
//   GET  /api/device/status       -> mismo estado por query (panel/compatibilidad)
//   POST /api/registration/manual -> registro manual: nombre, correo, teléfono
// Planes de pago (ver PLAN_DAYS/normalizePlan/leaseForPlan): '1d' = 1 día,
// '7d' = 7 días, '15d' = 15 días, '20d' = 20 días, 'mensual' = 1 mes (30 días),
// '2m' = 2 meses (60 días), 'unico' = pago único sin vencimiento.
// La cuenta atrás corre hasta cero y entonces el acceso se cierra.
// El admin asigna el plan con PATCH .../registrations/:id
// {action:'set-plan', plan:'1d'|'7d'|'15d'|'20d'|'mensual'|'2m'|'unico'}
// (eso marca el pago y activa).
// Además sirve el panel web (misma API que el panel original):
//   GET  /api/config, /api/session
//   GET  /api/admin/registrations, PATCH /api/admin/registrations/:id
//   POST /api/registration/start, /api/registration/verify
//   GET  /api/registration/status
//
// Sin dependencias: solo Node 18+ (http, crypto, fs, fetch global).
// Datos: se guardan en ./data/store.json. En Render gratis el disco es
// efímero: si el servicio se reinicia o se duerme, las solicitudes se
// pierden. Para que sobrevivan, configura UPSTASH_REDIS_REST_URL y
// UPSTASH_REDIS_REST_TOKEN (Redis gratis de Upstash): el servidor
// restaura el store y la llave de firma desde ahí al arrancar y hace
// respaldo de cada cambio. Sin esas variables, se comporta igual que antes.
//
// Admin: pon la variable de entorno ADMIN_KEY en Render.
// Por defecto es "ratbani-admin": CÁMBIALA antes de usarlo en serio.
// El panel web pide esa clave y la manda como header x-acceso-admin.
//
// Puerto: process.env.PORT o 3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'ratbani-admin';
// Usuario fijo: pon FIXED_PHONE en Render (ej. +528100000000).
// Ese teléfono queda pre-aprobado siempre, sin esperar al admin.
// Opcional: FIXED_NAME y FIXED_EMAIL para su ficha.
const FIXED_PHONE = (process.env.FIXED_PHONE || '').trim();
const FIXED_NAME = process.env.FIXED_NAME || 'Usuario fijo';
const FIXED_EMAIL = process.env.FIXED_EMAIL || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
const KEY_PATH = path.join(DATA_DIR, 'server-key.json');
// Persistencia externa opcional (Upstash Redis REST, plan gratis).
const KV_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_ENABLED = !!(KV_URL && KV_TOKEN);
const STORE_KV_KEY = process.env.STORE_KV_KEY || 'ratbani:store';
const SERVERKEY_KV_KEY = process.env.SERVERKEY_KV_KEY || 'ratbani:server-key';

const DESIGN = {
  schema: 1,
  brand: 'Ratbani',
  background: '#101611',
  text: '#F5FAF2',
  accent: '#C4F5AD',
  logo: null,
  registration: {
    title: 'Solicita tu acceso',
    description: 'Completa tus datos y tu acceso se activa automáticamente.',
  },
  home: {
    enabled: true,
    title: 'Bienvenido a Ratbani',
    subtitle: 'Tu espacio personal',
    button: 'Entrar',
    blocks: [
      { type: 'icon', icon: 'shield', text: 'Un acceso, tu dispositivo' },
      { type: 'text', text: 'Consulta las novedades de tu aplicación' },
    ],
  },
};

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    s.registrations = s.registrations || []; s.devices = s.devices || [];
    s.challenges = s.challenges || {}; s.otps = s.otps || {}; s.accessLog = s.accessLog || [];
    return s;
  } catch {
    return { registrations: [], devices: [], challenges: {}, otps: {}, accessLog: [] };
  }
}
function saveStore(s) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(s, null, 2));
  scheduleBackup();
}
let store = loadStore();

// --- Respaldo externo (Upstash Redis REST, opcional) ---
let backupTimer = null, backupInFlight = false, backupPending = false;
async function kvGet(key) {
  if (!KV_ENABLED) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    if (!r.ok) { console.error('[persistencia] kvGet falló:', key, 'HTTP', r.status); return null; }
    const j = await r.json();
    return (j && j.result !== undefined && j.result !== null) ? j.result : null;
  } catch (e) { console.error('[persistencia] kvGet error:', key, e.message || e); return null; }
}
async function kvSet(key, value) {
  if (!KV_ENABLED) return false;
  try {
    // El valor ya viene como texto (JSON) en las llamadas actuales: se manda
    // tal cual. Antes se volvía a codificar con JSON.stringify y Upstash
    // guardaba el texto con las comillas escapadas, así que al leerlo el
    // JSON.parse devolvía un texto y no el objeto: la restauración fallaba
    // en silencio y cada despliegue borraba las solicitudes.
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body });
    if (!r.ok) { console.error('[persistencia] kvSet falló:', key, 'HTTP', r.status); return false; }
    return true;
  } catch (e) { console.error('[persistencia] kvSet error:', key, e.message || e); return false; }
}
// Descodifica un valor leído de Redis: puede venir como objeto (si la API
// REST lo devolvió ya interpretado), como texto JSON, o como texto JSON con
// doble codificación (valores guardados con el bug anterior). Devuelve el
// objeto o null.
function parseKvJson(text) {
  let v = text;
  for (let i = 0; i < 3 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return (v && typeof v === 'object') ? v : null;
}
function scheduleBackup() {
  if (!KV_ENABLED || backupTimer) return;
  backupTimer = setTimeout(async () => {
    backupTimer = null;
    if (backupInFlight) { backupPending = true; return; }
    backupInFlight = true;
    try { await kvSet(STORE_KV_KEY, JSON.stringify(store)); } finally {
      backupInFlight = false;
      if (backupPending) { backupPending = false; scheduleBackup(); }
    }
  }, 300);
}

// Registro de accesos: IP, fecha, ruta, usuario/dispositivo, navegador/app.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket ? req.socket.remoteAddress : '';
}
function logAccess(req, info = {}) {
  store.accessLog.push({
    at: new Date().toISOString(),
    ip: clientIp(req),
    method: req.method,
    path: new URL(req.url, 'http://x').pathname,
    userAgent: req.headers['user-agent'] || '',
    ...info,
  });
  if (store.accessLog.length > 500) store.accessLog = store.accessLog.slice(-500);
  saveStore(store);
}
function isFixedPhone(phone) { return FIXED_PHONE && phone && phone === FIXED_PHONE; }
// Usuario fijo pre-aprobado (si FIXED_PHONE está puesto).
function ensureFixedUser() {
  if (!FIXED_PHONE) return;
  let fixed = store.registrations.find(r => r.phone === FIXED_PHONE);
  if (!fixed) {
    fixed = { id: uid(), name: FIXED_NAME, email: FIXED_EMAIL, phone: FIXED_PHONE, status: 'approved', fixed: true, source: 'fixed', createdAt: new Date().toISOString(), authorizedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString() };
    store.registrations.push(fixed); saveStore(store);
  } else if (fixed.status !== 'approved') {
    fixed.status = 'approved'; fixed.fixed = true; fixed.authorizedAt = fixed.authorizedAt || new Date().toISOString(); saveStore(store);
  }
}

// Clave del servidor para firmar tokens de activación (ECDSA P-256).
// Se genera una vez y se guarda en data/server-key.json. Si hay Redis
// externo, se restaura de ahí (si no, los tokens firmados antes de un
// reinicio de Render dejarían de valer).
let serverKey = null;
let serverPubPem = null;
function writeKeyFiles(privPem, pubPem) {
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  fs.writeFileSync(KEY_PATH, JSON.stringify({ privateKey: privPem, publicKey: pubPem }, null, 2));
  if (KV_ENABLED) void kvSet(SERVERKEY_KV_KEY, fs.readFileSync(KEY_PATH, 'utf8'));
}
async function initServerKey() {
  if (KV_ENABLED) {
    const remote = await kvGet(SERVERKEY_KV_KEY);
    if (remote) {
      try {
        const j = parseKvJson(remote);
        if (j && j.privateKey) {
          serverKey = crypto.createPrivateKey(j.privateKey);
          serverPubPem = j.publicKey || null;
          try { writeKeyFiles(j.privateKey, j.publicKey); } catch {}
          return;
        }
      } catch {}
    }
  }
  try {
    const j = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
    serverKey = crypto.createPrivateKey(j.privateKey);
    serverPubPem = j.publicKey || null;
    if (KV_ENABLED) void kvSet(SERVERKEY_KV_KEY, fs.readFileSync(KEY_PATH, 'utf8'));
    return;
  } catch {}
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  serverKey = crypto.createPrivateKey(priv);
  serverPubPem = pub;
  try { writeKeyFiles(priv, pub); } catch {}
}

function uid() { return crypto.randomUUID(); }
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function tokenFor(payload) {
  const head = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(`${head}.${body}`), serverKey);
  return `${head}.${body}.${b64url(sig)}`;
}
function nonce43() { return crypto.randomBytes(32).toString('base64url').slice(0, 43); }
function verifyDeviceSig(pubB64, nonce, sigB64) {
  try {
    const pubBuf = Buffer.from(pubB64, 'base64');
    const pubKey = crypto.createPublicKey({ key: pubBuf, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(nonce), pubKey, Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function sendFile(res, file, type) {
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': type, 'content-length': data.length });
    res.end(data);
  } catch { sendJson(res, 404, { ok: false, error: 'not_found' }); }
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}
function isAdmin(req) {
  const h = req.headers['x-acceso-admin'];
  if (h && h === ADMIN_KEY) return true;
  try {
    const u = new URL(req.url, 'http://x');
    return u.searchParams.get('adminKey') === ADMIN_KEY;
  } catch { return false; }
}
function findReg(id) { return store.registrations.find(r => r.id === id); }
// Planes de pago: '1d' = 1 día, '7d' = 7 días, '15d' = 15 días,
// '20d' = 20 días, 'mensual' = 1 mes (30 días), '2m' = 2 meses (60 días),
// 'unico' = pago único, sin vencimiento.
const PLAN_DAYS = { '1d': 1, '7d': 7, '15d': 15, '20d': 20, 'mensual': 30, '2m': 60 };
function normalizePlan(p) { return (p === '1d' || p === '7d' || p === '15d' || p === '20d' || p === 'mensual' || p === '2m' || p === 'unico') ? p : 'mensual'; }
function leaseForPlan(plan, phone) {
  if (isFixedPhone(phone)) return new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  if (normalizePlan(plan) === 'unico') return null; // pago único: sin vencimiento
  return new Date(Date.now() + PLAN_DAYS[normalizePlan(plan)] * 24 * 3600 * 1000).toISOString();
}
// Acceso automático con tope: las solicitudes nuevas se aprueban solas
// mientras las aprobadas no lleguen a AUTO_APPROVE_MAX (10). Al llegar al
// tope, las nuevas quedan pendientes hasta que el admin las apruebe en el
// panel. El usuario fijo (FIXED_PHONE) no cuenta para el tope.
const AUTO_APPROVE_MAX = 10;
function autoApproveAllowed(phone) {
  if (isFixedPhone(phone)) return true;
  const approved = store.registrations.filter(r => !r.archived && (r.status === 'approved' || r.status === 'active')).length;
  return approved < AUTO_APPROVE_MAX;
}
function initialStatusFor(phone, plan) {
  if (autoApproveAllowed(phone)) return { status: 'approved', authorizedAt: new Date().toISOString(), leaseExpiresAt: leaseForPlan(plan, phone) };
  return { status: 'pending', authorizedAt: null, leaseExpiresAt: null };
}
function deviceStatusFor(reg) {
  if (!reg) return 'not_enrolled';
  // La mensualidad vencida cierra el acceso: al llegar a cero la app ya no abre.
  if ((reg.status === 'approved' || reg.status === 'active') && reg.leaseExpiresAt && Date.now() > Date.parse(reg.leaseExpiresAt)) return 'expired';
  return reg.status;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    // Registro de IP en cada llamada a la API (no en la web ni /health).
    if (p.startsWith('/api/')) logAccess(req, {});

    if (p === '/' || p === '/health') {
      if (p === '/health') return sendJson(res, 200, { ok: true, service: 'ratbani-panel', version: '1.0.0', registrations: store.registrations.length });
      return sendFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
    }
    if (p === '/panel' || p === '/registro') return sendFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');

    // Perfil temporal: no crea una solicitud ni concede acceso al dispositivo.
    if (p === '/api/guest' && req.method === 'POST') {
      const id = uid();
      res.setHeader('cache-control', 'no-store');
      return sendJson(res, 201, { id, name: `Invitado ${id.slice(0, 8)}`, type: 'guest' });
    }

    // ---- Diseño (app Android) ----
    if (p === '/api/design' && req.method === 'GET') {
      return sendJson(res, 200, DESIGN);
    }

    // ---- Reto del dispositivo (app Android) ----
    if (p === '/api/device/challenge' && req.method === 'POST') {
      const body = await readBody(req);
      const challengeId = uid();
      const nonce = nonce43();
      store.challenges[challengeId] = {
        challengeId, nonce,
        publicKey: body.publicKey || body.public_key || null,
        phone: body.phone || null,
        registrationId: body.registrationId || body.registration_id || null,
        createdAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000,
      };
      saveStore(store);
      return sendJson(res, 200, { challengeId, nonce, challenge: nonce, expiresAt: store.challenges[challengeId].expiresAt });
    }

    // ---- Reclamo / activación (app Android) ----
    if (p === '/api/device/claim' && req.method === 'POST') {
      const body = await readBody(req);
      const challengeId = body.challengeId || body.challenge_id;
      const pubB64claim = body.publicKey || body.public_key || null;
      // Modo vincular dispositivo: la app manda {registrationId, statusToken, publicKey} sin reto.
      if (!challengeId) {
        const reg0 = (body.registrationId || body.registration_id) ? findReg(body.registrationId || body.registration_id) : null;
        if (!reg0) return sendJson(res, 400, { ok: false, error: 'device_not_linked', message: 'Dispositivo sin registro.' });
        if (pubB64claim) reg0.devicePublicKey = pubB64claim;
        reg0.lastIp = clientIp(req); reg0.lastSeenAt = new Date().toISOString();
        const statusToken0 = tokenFor({ sub: reg0.id, type: 'status', iat: Math.floor(Date.now() / 1000) });
        saveStore(store);
        return sendJson(res, 200, { ok: true, status: deviceStatusFor(reg0), registrationId: reg0.id, registration_id: reg0.id, statusToken: statusToken0, signedStatus: statusToken0, authorizedAt: reg0.authorizedAt || null, leaseExpiresAt: reg0.leaseExpiresAt || null });
      }
      const ch = store.challenges[challengeId];
      if (!ch || Date.now() > ch.expiresAt) {
        return sendJson(res, 400, { ok: false, error: 'invalid_challenge', message: 'El reto no es válido o caducó.' });
      }
      // Verificar firma ECDSA del dispositivo sobre el nonce, si viene.
      let signatureOk = null;
      const sigB64 = body.signature || body.signedChallenge || null;
      const pubB64 = body.publicKey || body.public_key || ch.publicKey || null;
      if (sigB64 && pubB64) {
        try {
          let pubKey;
          const pubBuf = Buffer.from(pubB64, 'base64');
          try { pubKey = crypto.createPublicKey({ key: pubBuf, format: 'der', type: 'spki' }); }
          catch { pubKey = crypto.createPublicKey({ key: pubBuf, format: 'der', type: 'spki' }); }
          signatureOk = crypto.verify(null, Buffer.from(ch.nonce), pubKey, Buffer.from(sigB64, 'base64'));
        } catch { signatureOk = false; }
      }
      if (signatureOk === false) {
        return sendJson(res, 400, { ok: false, error: 'invalid_signature', message: 'La firma del dispositivo no es válida.' });
      }
      // Vincular con una solicitud por registrationId o por teléfono, si la hay.
      const phone = body.phone || body.challengedPhone || ch.phone || null;
      let reg = (body.registrationId || body.registration_id || ch.registrationId) ? findReg(body.registrationId || body.registration_id || ch.registrationId) : null;
      if (!reg && phone) reg = store.registrations.find(r => r.phone === phone && !r.archived) || null;
      if (!reg) {
        // Acceso automático con tope de 10: la solicitud nueva se aprueba
        // sola si aún hay cupo; si no, queda pendiente hasta que el admin
        // la apruebe en el panel (Aprobar o ponerle un plan). Solo el
        // usuario fijo (FIXED_PHONE) entra aprobado directo siempre.
        const init = initialStatusFor(phone, 'mensual');
        reg = { id: uid(), name: body.name || null, email: body.email || null, phone, plan: 'mensual', status: init.status, fixed: isFixedPhone(phone) || undefined, source: 'device', createdAt: new Date().toISOString(), ip: clientIp(req), lastIp: clientIp(req), lastSeenAt: new Date().toISOString(), devicePublicKey: pubB64, authorizedAt: init.authorizedAt, leaseExpiresAt: init.leaseExpiresAt };
        store.registrations.push(reg);
      } else {
        if (pubB64) reg.devicePublicKey = pubB64;
        // Acceso automático: si la solicitud estaba pendiente y aún hay
        // cupo, el vínculo del dispositivo la aprueba (igual que un registro
        // nuevo). La decisión del admin de desvincular se respeta: un
        // registro revocado nunca se aprueba solo. Un rechazo (reject)
        // archiva la solicitud y libera el teléfono, así que esa persona
        // puede registrarse de nuevo.
        if (reg.status === 'pending') {
          const init = initialStatusFor(phone, reg.plan || 'mensual');
          if (init.status === 'approved') { reg.status = 'approved'; reg.authorizedAt = init.authorizedAt; reg.leaseExpiresAt = init.leaseExpiresAt; }
        }
      }
      reg.lastIp = clientIp(req); reg.lastSeenAt = new Date().toISOString();
      // Con acceso automático, una solicitud pendiente solo se queda así si
      // ya se llegó al tope de 10 aprobadas. Si el admin la desvinculó
      // (revoke), su decisión se respeta.
      const claimStatus = deviceStatusFor(reg);
      const statusToken = tokenFor({ sub: reg.id, type: 'status', iat: Math.floor(Date.now() / 1000) });
      const dev = { id: uid(), registrationId: reg.id, challengeId, publicKey: pubB64, signatureOk, statusToken, createdAt: new Date().toISOString() };
      store.devices.push(dev);
      delete store.challenges[challengeId];
      saveStore(store);
      const approved = claimStatus === 'approved' || claimStatus === 'active';
      return sendJson(res, 200, {
        ok: true,
        status: approved ? 'active' : claimStatus,
        registrationId: reg.id,
        registration_id: reg.id,
        statusToken,
        signedStatus: statusToken,
        authorizedAt: reg.authorizedAt || null,
        leaseExpiresAt: reg.leaseExpiresAt || null,
      });
    }

    // ---- Estado del dispositivo (app Android) ----
    // La app hace POST con {registrationId, challengeId, signature} y espera
    // {allowed, status, authorizedAt, leaseExpiresAt, launchExpiresAt} en ms.
    // leaseExpiresAt debe vencer en menos de 6 min y launchExpiresAt en menos
    // de 2 min: el acceso se renueva en cada arranque (por eso el diálogo
    // dice "renovar el acceso"). La autorización de 30 días sigue aparte.
    if (p === '/api/device/status' && req.method === 'POST') {
      const body = await readBody(req);
      const reg = (body.registrationId || body.registration_id) ? findReg(body.registrationId || body.registration_id) : null;
      if (!reg) return sendJson(res, 200, { ok: true, allowed: false, status: 'not_enrolled', message: 'Dispositivo sin registro.' });
      const ch = body.challengeId ? store.challenges[body.challengeId] : null;
      if (body.challengeId && (!ch || Date.now() > ch.expiresAt)) {
        return sendJson(res, 400, { ok: false, error: 'invalid_challenge', message: 'El reto no es válido o caducó.' });
      }
      if (ch && body.signature && reg.devicePublicKey) {
        if (!verifyDeviceSig(reg.devicePublicKey, ch.nonce, body.signature)) {
          return sendJson(res, 400, { ok: false, error: 'invalid_signature', message: 'La firma del dispositivo no es válida.' });
        }
      }
      if (ch) { delete store.challenges[body.challengeId]; }
      reg.lastIp = clientIp(req); reg.lastSeenAt = new Date().toISOString();
      const st = deviceStatusFor(reg);
      if (st === 'approved' || st === 'active') {
        const now = Date.now();
        const statusToken = tokenFor({ sub: reg.id, type: 'status', iat: Math.floor(now / 1000) });
        saveStore(store);
        return sendJson(res, 200, { ok: true, allowed: true, status: 'approved', registrationId: reg.id, authorizedAt: now, leaseExpiresAt: now + 300000, launchExpiresAt: now + 120000, statusToken, signedStatus: statusToken });
      }
      saveStore(store);
      return sendJson(res, 200, { ok: true, allowed: false, status: st, registrationId: reg.id });
    }
    if (p === '/api/device/status' && req.method === 'GET') {
      const token = url.searchParams.get('statusToken') || url.searchParams.get('token') || req.headers['authorization'] || '';
      const regId = url.searchParams.get('registrationId') || url.searchParams.get('id') || null;
      let reg = regId ? findReg(regId) : null;
      if (!reg && token) {
        const dev = store.devices.find(d => d.statusToken === token);
        if (dev) reg = findReg(dev.registrationId);
      }
      if (!reg) return sendJson(res, 200, { ok: true, allowed: false, status: 'not_enrolled', message: 'Dispositivo sin registro.' });
      const now = Date.now();
      const st = deviceStatusFor(reg);
      const approved = st === 'approved' || st === 'active';
      return sendJson(res, 200, {
        ok: true, allowed: approved, status: st, registrationId: reg.id,
        authorizedAt: reg.authorizedAt ? Date.parse(reg.authorizedAt) : now,
        leaseExpiresAt: now + 300000, launchExpiresAt: now + 120000,
      });
    }

    // ---- Registro manual (app Android) ----
    if (p === '/api/registration/manual' && req.method === 'POST') {
      const body = await readBody(req);
      const name = (body.name || '').trim();
      const email = (body.email || '').trim();
      const phone = (body.phone || '').trim();
      if (!name || !email || !phone) {
        return sendJson(res, 400, { ok: false, error: 'invalid_fields', message: 'Completa nombre, correo y teléfono. Todos son obligatorios.' });
      }
      const existing = store.registrations.find(r => r.phone === phone && !r.archived);
      if (existing) {
        // Si ya existe una solicitud con ese teléfono se devuelve tal cual
        // (pendiente, aprobada o desvinculada). Un rechazo archiva la
        // solicitud y libera el teléfono, así que aquí ya no aparece el
        // registro viejo: llega uno nuevo (aprobado solo si aún hay cupo).
        return sendJson(res, 200, { ok: true, registrationId: existing.id, registration_id: existing.id, statusToken: tokenFor({ sub: existing.id, type: 'status', iat: Math.floor(Date.now() / 1000) }), status: existing.status, plan: existing.plan || 'mensual', leaseExpiresAt: existing.leaseExpiresAt || null, message: existing.status === 'approved' ? 'Solicitud aprobada.' : 'Este teléfono ya tiene otra solicitud guardada.' });
      }
      const plan = normalizePlan(body.plan);
      const init = initialStatusFor(phone, plan);
      const reg = { id: uid(), name, email, phone, plan, status: init.status, fixed: isFixedPhone(phone) || undefined, source: 'manual', createdAt: new Date().toISOString(), ip: clientIp(req), lastIp: clientIp(req), lastSeenAt: new Date().toISOString(), devicePublicKey: body.publicKey || body.public_key || null, authorizedAt: init.authorizedAt, leaseExpiresAt: init.leaseExpiresAt };
      store.registrations.push(reg); saveStore(store);
      return sendJson(res, 200, { ok: true, registrationId: reg.id, registration_id: reg.id, statusToken: tokenFor({ sub: reg.id, type: 'status', iat: Math.floor(Date.now() / 1000) }), status: reg.status, plan, leaseExpiresAt: reg.leaseExpiresAt || null, message: reg.status === 'approved' ? 'Solicitud aprobada.' : 'Solicitud recibida. Espera la aprobación del administrador.' });
    }

    // ---- Config / sesión (panel web) ----
    if (p === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, { databaseConfigured: true, registrationEnabled: true, serviceVersion: '1.0.0' });
    }
    if (p === '/api/session' && req.method === 'GET') {
      return sendJson(res, 200, { authenticated: isAdmin(req), isAdmin: isAdmin(req), setupRequired: false, email: isAdmin(req) ? 'admin@ratbani' : null });
    }

    // ---- Registro web con código (sin SMS: el código se ve en el panel de admin) ----
    if (p === '/api/registration/start' && req.method === 'POST') {
      const body = await readBody(req);
      const details = body.details || body;
      const name = (details.name || '').trim(); const email = (details.email || '').trim(); const phone = (details.phone || '').trim();
      if (!name || !email || !phone) return sendJson(res, 400, { ok: false, error: 'invalid_fields', message: 'Completa nombre, correo y teléfono.' });
      const challengeId = uid();
      const code = String(Math.floor(100000 + Math.random() * 900000));
      store.otps[challengeId] = { challengeId, code, details: { name, email, phone }, createdAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000 };
      saveStore(store);
      // Sin SMS en el plan gratis: el código aparece en el panel de admin.
      // En esta versión también se devuelve para poder probarlo.
      return sendJson(res, 200, { challengeId, devCode: code, message: 'Código generado. Pídelo al administrador o míralo en el panel.' });
    }
    if (p === '/api/registration/verify' && req.method === 'POST') {
      const body = await readBody(req);
      const otp = store.otps[body.challengeId];
      if (!otp || Date.now() > otp.expiresAt || String(body.code).trim() !== otp.code) {
        return sendJson(res, 400, { ok: false, error: 'invalid_code', message: 'El código no es válido.' });
      }
      const init = initialStatusFor(otp.details.phone, 'mensual');
      const reg = { id: uid(), name: otp.details.name, email: otp.details.email, phone: otp.details.phone, plan: 'mensual', status: init.status, fixed: isFixedPhone(otp.details.phone) || undefined, source: 'web', createdAt: new Date().toISOString(), ip: clientIp(req), lastIp: clientIp(req), lastSeenAt: new Date().toISOString(), authorizedAt: init.authorizedAt, leaseExpiresAt: init.leaseExpiresAt };
      store.registrations.push(reg);
      delete store.otps[body.challengeId];
      saveStore(store);
      return sendJson(res, 200, { ok: true, registrationId: reg.id, statusToken: tokenFor({ sub: reg.id, type: 'status', iat: Math.floor(Date.now() / 1000) }), status: reg.status });
    }
    if (p === '/api/registration/status' && req.method === 'GET') {
      const reg = findReg(url.searchParams.get('id'));
      if (!reg) return sendJson(res, 404, { ok: false, error: 'not_found', message: 'Solicitud no encontrada.' });
      return sendJson(res, 200, { ok: true, status: deviceStatusFor(reg), plan: reg.plan || 'mensual', registrationId: reg.id, authorizedAt: reg.authorizedAt || null, leaseExpiresAt: reg.leaseExpiresAt || null });
    }

    // ---- Admin ----
    if (p === '/api/admin/access-log' && req.method === 'GET') {
      if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized', message: 'Falta la clave de administrador.' });
      return sendJson(res, 200, { accessLog: store.accessLog.slice(-200).reverse() });
    }
    if (p === '/api/admin/registrations' && req.method === 'GET') {
      if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized', message: 'Falta la clave de administrador.' });
      return sendJson(res, 200, { registrations: store.registrations, otps: Object.values(store.otps).map(o => ({ challengeId: o.challengeId, code: o.code, phone: o.details.phone, name: o.details.name })) });
    }
    const m = p.match(/^\/api\/admin\/registrations\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      const body = await readBody(req);
      const reg = findReg(decodeURIComponent(m[1]));
      if (!reg) return sendJson(res, 404, { ok: false, error: 'not_found' });
      const action = body.action || body.status;
      if (action === 'approve' || action === 'approved') { reg.status = 'approved'; reg.authorizedAt = new Date().toISOString(); reg.leaseExpiresAt = leaseForPlan(reg.plan, reg.phone); }
      else if (action === 'set-plan' || action === 'set_plan' || action === 'plan') {
        // El admin marca que esta persona pagó: se le asigna el plan y se activa con su vigencia.
        // 'mensual' = 30 días con cuenta atrás; 'unico' = pago único, sin vencimiento.
        const plan = normalizePlan(body.plan);
        reg.plan = plan;
        reg.paidAt = new Date().toISOString();
        reg.status = 'approved';
        reg.authorizedAt = new Date().toISOString();
        reg.leaseExpiresAt = leaseForPlan(plan, reg.phone);
      }
      else if (action === 'reject' || action === 'rejected') {
        // Rechazar libera el teléfono: la solicitud queda guardada como
        // 'rejected' (visible en el panel) pero archivada, así que la
        // persona puede registrarse de nuevo desde la app con ese mismo
        // número y le llega una solicitud nueva. Su registro viejo ya no
        // abre la app (el estado por registrationId sigue siendo rejected).
        reg.status = 'rejected'; reg.archived = true;
      }
      else if (action === 'revoke' || action === 'revoked') { reg.status = 'revoked'; }
      else if (action === 'archive') { reg.archived = true; }
      else if (action === 'pending') { reg.status = 'pending'; }
      saveStore(store);
      return sendJson(res, 200, { ok: true, registration: reg });
    }

    return sendJson(res, 404, { ok: false, error: 'not_found', message: 'Ruta no disponible.' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { ok: false, error: 'server_error', message: String(err.message || err) });
  }
});

(async () => {
  if (KV_ENABLED) {
    try {
      const remote = await kvGet(STORE_KV_KEY);
      if (remote !== null && remote !== undefined) {
        const parsed = parseKvJson(remote);
        if (parsed && Array.isArray(parsed.registrations)) {
          store = {
            registrations: parsed.registrations || [],
            devices: parsed.devices || [],
            challenges: parsed.challenges || {},
            otps: parsed.otps || {},
            accessLog: parsed.accessLog || [],
          };
          try { fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true }); fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2)); } catch {}
          console.log(`[persistencia] store restaurado desde Redis externo (${store.registrations.length} registros)`);
        } else {
          console.error('[persistencia] el store en Redis no se pudo interpretar (se empieza vacío, no se sobrescribe)');
        }
      } else {
        console.log('[persistencia] sin datos del store en Redis externo (se empieza vacío)');
        if (store.registrations.length || store.accessLog.length) {
          await kvSet(STORE_KV_KEY, JSON.stringify(store));
          console.log('[persistencia] store local subido a Redis externo');
        }
      }
    } catch (e) { console.error('[persistencia] no se pudo restaurar store externo:', e.message || e); }
  }
  ensureFixedUser();
  await initServerKey();
  server.listen(PORT, () => {
    console.log(`ratbani-panel escuchando en puerto ${PORT}`);
    console.log('Panel: /  |  Salud: /health  |  Diseño: /api/design');
    if (KV_ENABLED) console.log('[persistencia] Redis externo activo: las solicitudes sobreviven reinicios');
    else console.log('[persistencia] sin Redis externo: en Render gratis los datos se pierden al reiniciar');
  });
})();
