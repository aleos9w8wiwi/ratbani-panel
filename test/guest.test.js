const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, copyFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

test('each request yields a distinct guest without creating an approved account', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ratbani-guest-'));
  copyFileSync(join(__dirname, '..', 'server.js'), join(dir, 'server.js'));
  const port = await new Promise((resolve, reject) => {
    const socket = createServer(); socket.on('error', reject);
    socket.listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(() => resolve(value)); });
  });
  const adminKey = randomUUID();
  const child = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(port), ADMIN_KEY: adminKey, FIXED_PHONE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 5000);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited: ${code}`)));
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
  });
  const base = `http://127.0.0.1:${port}`;
  const firstResponse = await fetch(`${base}/api/guest`, { method: 'POST' });
  const secondResponse = await fetch(`${base}/api/guest`, { method: 'POST' });
  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  assert.equal(firstResponse.headers.get('cache-control'), 'no-store');
  const first = await firstResponse.json(), second = await secondResponse.json();
  assert.match(first.id, /^[0-9a-f-]{36}$/i);
  assert.notEqual(first.id, second.id);
  assert.equal(first.type, 'guest');
  assert.deepEqual(Object.keys(first).sort(), ['id', 'name', 'type']);
  const list = await fetch(`${base}/api/admin/registrations`, { headers: { 'x-acceso-admin': adminKey } });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).registrations.length, 0);
  const status = await fetch(`${base}/api/device/status?registrationId=${first.id}`);
  assert.notEqual((await status.json()).allowed, true);
});
