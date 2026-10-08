import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createParser, FRAME } from '../bridge/audiosocket.js';
import { CallMonitor } from '../bridge/CallMonitor.js';

function harness() {
  const servers = [];
  class Server extends EventEmitter { listen() {} }
  class Bridge {
    ready = false;
    closed = false;
    async init() { this.ready = true; }
    attachAgent(ws) { this.agent = ws; }
    detachAgent(ws) { if (this.agent === ws) this.agent = null; }
    onAgentAudio() {}
    setPtt() {}
    onCallAudio() { throw new Error('processing failed'); }
    close() { this.closed = true; }
  }
  const source = fs.readFileSync(new URL('../bridge/index.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', "const __dirname = '/tmp';");
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Buffer, URL,
    process: { env: { GEMINI_API_KEY: 'offline-test' } },
    net: { createServer: () => new Server() }, http: { createServer: () => new Server() },
    path: { join: (...parts) => parts.join('/') },
    WebSocketServer: class extends Server { constructor() { super(); servers.push(this); } },
    CallBridge: Bridge, ConnectionLimits: class { maxCalls = Infinity; track() {} },
    CallMonitor, createMonitorHandler: () => async () => false,
    createParser, FRAME,
  });
  vm.runInContext(source + '\nthis.calls = activeCalls; this.agents = agents;', context);
  function connect(server) {
    const ws = new EventEmitter();
    ws.sent = [];
    ws.send = message => ws.sent.push(JSON.parse(message));
    ws.close = (code, reason) => { ws.closeCode = code; ws.closeReason = reason; ws.emit('close'); };
    servers[server].emit('connection', ws);
    return ws;
  }
  return { context, connect, Bridge };
}

for (const operation of ['audio', 'ptt', 'join']) {
  test(`browser ${operation} processing exception disconnects only the offending browser`, () => {
    const h = harness();
    const call = new h.Bridge(); call.ready = true; h.context.calls.set('existing-call', call);
    const bad = h.connect(0), healthy = h.connect(0);
    if (operation === 'audio') call.onAgentAudio = () => { throw new Error('audio failure'); };
    if (operation === 'ptt') call.setPtt = () => { throw new Error('PTT failure'); };
    if (operation === 'join') bad.send = () => { throw new Error('send failure'); };
    assert.doesNotThrow(() => bad.emit('message', Buffer.from(JSON.stringify({
      type: operation, data: 'AAA=', active: true,
    }))));
    assert.equal(bad.closeCode, 1011);
    assert.equal(h.context.agents.has(bad), false);
    assert.equal(h.context.calls.get('existing-call'), call);
    assert.equal(call.closed, false);
    healthy.emit('message', Buffer.from('{"type":"join"}'));
    assert.equal(healthy.sent.at(-1).ok, true);
  });
}

test('browser protocol error is handled and detaches the offending browser', () => {
  const h = harness();
  const ws = h.connect(0);
  assert.doesNotThrow(() => ws.emit('error', new Error('invalid frame')));
  assert.equal(h.context.agents.has(ws), false);
  ws.emit('message', Buffer.from('{"type":"join"}'));
  assert.equal(ws.sent.length, 0);
});

test('browser attachment exception cannot escape the connection handler', () => {
  const h = harness();
  const call = new h.Bridge(); call.ready = true;
  call.attachAgent = () => { throw new Error('attachment failed'); };
  h.context.calls.set('existing-call', call);
  let ws;
  assert.doesNotThrow(() => { ws = h.connect(0); });
  assert.equal(ws.closeCode, 1011);
  assert.equal(h.context.agents.has(ws), false);
  assert.equal(call.closed, false);
});

test('relay audio callback rejection closes its call and releases the registry', async () => {
  const h = harness();
  const relay = h.connect(1);
  relay.emit('message', Buffer.from([FRAME.UUID, 0, 16, ...Buffer.alloc(16)]));
  await Promise.resolve(); await Promise.resolve();
  const call = h.context.calls.values().next().value;
  relay.emit('message', Buffer.from([FRAME.AUDIO, 0, 2, 0, 0]));
  await Promise.resolve();
  assert.equal(relay.closeCode, 1011);
  assert.equal(call.closed, true);
  assert.equal(h.context.calls.size, 0);
  const browser = h.connect(0);
  browser.emit('message', Buffer.from('{"type":"join"}'));
  assert.equal(browser.sent.at(-1).ok, false);
});
