import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CallMonitor } from '../bridge/CallMonitor.js';
import { MonitorAuth, passwordHash } from '../bridge/monitor-auth.js';
import { createMonitorHandler } from '../bridge/monitor-http.js';

const password = 'test-only-long-passphrase';
const encoded = await passwordHash(password);
const credentials = { username: 'operator', passwordHash: encoded, origin: 'https://monitor.example.test' };

test('HTTP routes enforce login; call speech is private; live stream is revoked on logout and expiration', async t => {
  const monitor = new CallMonitor(); const callId = monitor.start('private-call');
  monitor.transcript(callId, 'caller', 'translated', 'Confidential translation');
  let auth, handle;
  const server = http.createServer((req, res) => handle(req, res).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); }
  }).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let now = 1000;
  auth = new MonitorAuth({ ...credentials, origin, now: () => now, sessionMs: 10000 });
  handle = createMonitorHandler(monitor, { auth });
  const headers = { origin, 'x-monitor-request': '1', 'content-type': 'application/json' };
  for (const path of ['/monitor/api/snapshot', '/monitor/events', '/monitor/app.js',
    `/monitor/api/calls/${callId}/transcript`]) {
    const res = await fetch(origin + path); assert.equal(res.status, 401);
    assert.ok(!(await res.text()).includes('private-call'));
  }
  let res = await fetch(origin + '/monitor', { redirect: 'manual' });
  assert.equal(res.status, 303); assert.equal(res.headers.get('location'), '/monitor/login');
  res = await fetch(origin + '/monitor/login'); assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  res = await fetch(origin + '/monitor/login', { method: 'POST', headers: { ...headers, origin: 'https://attacker.test' },
    body: JSON.stringify({ username: 'operator', password }) }); assert.equal(res.status, 403);
  res = await fetch(origin + '/monitor/login', { method: 'POST', headers,
    body: JSON.stringify({ username: 'operator', password }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  res = await fetch(origin + '/monitor/api/snapshot', { headers: { cookie } });
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  const snapshot = await res.json();
  assert.equal(snapshot.calls[0].callId, 'private-call');
  assert.ok(!JSON.stringify(snapshot).includes('Confidential translation'));
  res = await fetch(origin + `/monitor/api/calls/${callId}/transcript`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).records[0].text, 'Confidential translation');
  const stream = await fetch(origin + '/monitor/events', { headers: { cookie } });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /private-call/);
  assert.ok(!JSON.stringify(monitor.snapshot()).includes('Confidential translation'));
  res = await fetch(origin + '/monitor/logout', { method: 'POST', headers: { ...headers, cookie } });
  assert.equal(res.status, 200);
  assert.equal((await reader.read()).done, true);
  assert.equal((await fetch(origin + '/monitor/api/snapshot', { headers: { cookie } })).status, 401);
  assert.equal((await fetch(origin + `/monitor/api/calls/${callId}/transcript`, { headers: { cookie } })).status, 401);

  const login = await auth.login('operator', password, 'local');
  const expiring = await fetch(origin + '/monitor/events', { headers: { cookie: auth.cookie(login.token) } });
  const expiryReader = expiring.body.getReader(); await expiryReader.read();
  now += 10001;
  assert.match(new TextDecoder().decode((await expiryReader.read()).value), /event: expired/);
  assert.equal((await expiryReader.read()).done, true);
  handle = createMonitorHandler(monitor, { auth: new MonitorAuth() });
  for (const path of ['/monitor', '/monitor/login', '/monitor/events', '/monitor/api/snapshot', '/monitor/app.js'])
    assert.equal((await fetch(origin + path, { headers: { cookie } })).status, 503);
});
