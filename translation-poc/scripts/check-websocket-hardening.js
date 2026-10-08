// Real entry-point regression checks. Dummy key, loopback media, no provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

async function startBridge(t, overrides = {}) {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const availablePort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['bridge/index.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', GEMINI_API_KEY: 'offline-test',
      PORT: String(availablePort), AUDIOSOCKET_PORT: '0', MEDIA_MODE: 'loopback', AGENT_WS_PATH: '/agent',
      MAX_ACTIVE_CALLS: '0', MAX_MEDIA_CONNECTIONS: '0', MAX_UPGRADES_PER_MINUTE: '0', WS_HEARTBEAT_MS: '0',
      MONITOR_USERNAME: '', MONITOR_PASSWORD_HASH: '', MONITOR_ORIGIN: '', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Bridge exited during startup: ${output}`)));
    child.stderr.on('data', data => { output += data; });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/http on :(\d+)/);
      if (match) resolve(Number(match[1]));
    });
  });
  // Fail promptly if the child crashes instead of waiting for a socket timeout.
  const alive = promise => Promise.race([promise, exited.then(() => {
    throw new Error(`Bridge crashed: ${output}`);
  })]);
  const clients = [];
  t.after(() => { for (const client of clients) client.terminate(); });
  async function connect(path) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, path === '/media' ? 'media' : undefined);
    clients.push(ws);
    await alive(once(ws, 'open'));
    ws.on('error', () => {});
    return ws;
  }
  const healthy = await connect('/media');
  healthy.send(JSON.stringify({ event: 'MEDIA_START', connection_id: 'healthy-loopback',
    format: 'slin', optimal_frame_size: 320, ptime: 20,
    ...(overrides.MEDIA_MODE === 'translation' ? { channel_variables: { CALL_ID: 'healthy-call', ROLE: 'caller', SOURCE_LANG: 'hi', TARGET_LANG: 'en' } } : {}) }));
  async function checkHealthy() {
    if (overrides.MEDIA_MODE !== 'translation') {
      const echo = once(healthy, 'message');
      healthy.send(Buffer.alloc(320, 7));
      const [audio, binary] = await alive(echo);
      assert.equal(binary, true);
      assert.deepEqual(audio, Buffer.alloc(320, 7));
    }
    const response = await alive(fetch(`http://127.0.0.1:${port}/health`));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).activeCalls, 1);
  }
  await checkHealthy();
  return { connect, checkHealthy, alive, port };
}

test('invalid WebSocket upgrade URL leaves the bridge and an existing media connection alive',
  { timeout: 10000 }, async t => {
    const bridge = await startBridge(t);
    const socket = net.connect(bridge.port, '127.0.0.1');
    t.after(() => socket.destroy());
    await once(socket, 'connect');
    socket.on('error', () => {});
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.resume();
    socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n' +
      'Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n');
    await bridge.alive(closed);
    await bridge.checkHealthy();
  });

for (const path of ['/agent', '/audiosocket', '/media']) {
  test(`${path}: invalid frame closes only that client`, { timeout: 10000 }, async t => {
    const bridge = await startBridge(t);
    const bad = await bridge.connect(path);
    const closed = new Promise(resolve => bad.once('close', resolve));
    // A client frame must be masked. Use the transport to exercise ws's error event.
    bad._socket.write(Buffer.from([0x81, 0x01, 0x61]));
    await bridge.alive(closed);
    await bridge.checkHealthy();
  });
  test(`${path}: oversized fragmented message closes only that client`, { timeout: 10000 }, async t => {
    const bridge = await startBridge(t);
    const bad = await bridge.connect(path);
    const closed = new Promise(resolve => bad.once('close', resolve));
    bad.send(Buffer.alloc(64000), { fin: false });
    bad.send(Buffer.alloc(70000), { fin: true });
    assert.equal(await bridge.alive(closed), 1009);
    await bridge.checkHealthy();
  });
}


async function rejectedUpgrade(t, bridge, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/media`, 'media', { headers });
  ws.on('error', () => {}); t.after(() => ws.terminate());
  const status = await bridge.alive(new Promise(resolve => ws.once('unexpected-response', (_, res) => {
    res.resume(); resolve(res.statusCode); ws.terminate();
  })));
  return status;
}
test('existing endpoints accept connections without credentials or tokens', { timeout: 10000 }, async t => {
  const bridge = await startBridge(t);
  const response = await bridge.alive(fetch(`http://127.0.0.1:${bridge.port}/`));
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes('id="access-token"'));
  const browser = await bridge.connect('/agent');
  assert.equal(browser.protocol, '');
  browser.send(JSON.stringify({ type: 'join' }));
  const [reply] = await bridge.alive(once(browser, 'message'));
  assert.equal(JSON.parse(reply.toString()).ok, false, 'browser cannot attach to native loopback');
  const relay = await bridge.connect('/audiosocket'); relay.close();
  await bridge.checkHealthy();
});
test('socket capacity rejects new upgrades and releases the slot on disconnect', { timeout: 10000 }, async t => {
  const bridge = await startBridge(t, { MAX_MEDIA_CONNECTIONS: '2' });
  const pending = await bridge.connect('/media');
  assert.equal(await rejectedUpgrade(t, bridge), 503);
  const closed = once(pending, 'close'); pending.close(); await closed;
  const replacement = await bridge.connect('/media'); replacement.close();
  await bridge.checkHealthy();
});


test('original four-field translation metadata is accepted and no new default five-call cap is imposed', { timeout: 10000 }, async t => {
  const bridge = await startBridge(t, { MEDIA_MODE: 'translation' });
  const participants = [];
  for (let n = 0; n < 6; n++) {
    const ws = await bridge.connect('/media'); participants.push(ws);
    ws.send(JSON.stringify({ event: 'MEDIA_START', connection_id: 'translation-media',
      format: 'slin', optimal_frame_size: 320, ptime: 20,
      channel_variables: { CALL_ID: `existing-contract-${n}`, ROLE: 'caller', SOURCE_LANG: 'hi', TARGET_LANG: 'en' } }));
  }
  // Reserve caller-only sessions: no Gemini sessions are created until their peers join.
  let count = 0;
  for (let n = 0; n < 100 && count !== 7; n++) {
    count = (await (await bridge.alive(fetch(`http://127.0.0.1:${bridge.port}/health`))).json()).activeCalls;
    if (count !== 7) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(count, 7);
  assert.ok(participants.every(ws => ws.readyState === WebSocket.OPEN));
});
