import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { OutputPacer, buildAudioFrame, createParser } from '../bridge/audiosocket.js';
import * as audio from '../bridge/audio.js';

function pacer() {
  let time = 0;
  const frames = [];
  const output = new OutputPacer({ writable: true, write: b => frames.push(b.subarray(3)) }, {
    now: () => time, prebufferMs: 80, maxWaitMs: 120, endGapMs: 200,
  });
  return { output, frames, tick: t => { time = t; output._tick(); } };
}

test('short response plays by maximum wait without turn-end', () => {
  const { output, frames, tick } = pacer();
  output.push(Buffer.alloc(320, 1));
  tick(100); assert.equal(frames.length, 0);
  tick(120); assert.equal(frames.length, 1);
  assert.equal(output.queue.length, 0);
});

test('buffer threshold starts promptly and emits only one frame per tick', () => {
  const { output, frames, tick } = pacer();
  output.push(Buffer.alloc(1280, 2));
  tick(20); assert.equal(frames.length, 1);
  assert.equal(output.queue.length, 960);
});

test('commit releases short and partial response, padding only the tail', () => {
  const { output, frames, tick } = pacer();
  output.push(Buffer.alloc(350, 3)); output.commit();
  tick(20); tick(40);
  assert.equal(frames.length, 2);
  assert.deepEqual(Buffer.concat(frames).subarray(0, 350), Buffer.alloc(350, 3));
  assert.deepEqual(frames[1].subarray(30), Buffer.alloc(290));
  assert.equal(output.queue.length, 0);
});

test('partial response drains on timeout without commit', () => {
  const { output, frames, tick } = pacer();
  output.push(Buffer.alloc(30, 4));
  tick(120);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 320);
  assert.equal(output.queue.length, 0);
});

test('flush discards queued audio and next response gets its own wait', () => {
  const { output, frames, tick } = pacer();
  output.push(Buffer.alloc(30)); output.commit(); output.flush(); tick(200);
  assert.equal(frames.length, 0);
  output.push(Buffer.alloc(320)); tick(300);
  assert.equal(frames.length, 0);
  tick(320); assert.equal(frames.length, 1);
});

test('split and coalesced AudioSocket frames remain intact', () => {
  const received = [];
  const parse = createParser((type, data) => received.push([type, data.length]));
  const f = buildAudioFrame(Buffer.alloc(320));
  parse(f.subarray(0, 2)); parse(Buffer.concat([f.subarray(2), f]));
  assert.deepEqual(received, [[16, 320], [16, 320]]);
});

// Execute the actual modules with fake external sessions; no Gemini calls or API keys.
function loadModule(file, bindings, exports) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replaceAll('export class ', 'class ');
  const context = vm.createContext({ console, Buffer, performance, Int16Array,
    process: { env: {} }, ...bindings });
  vm.runInContext(source + `\nthis.result = { ${exports} };`, context);
  return context.result;
}

function translator(connect) {
  const { Translator } = loadModule('../bridge/Translator.js', {
    GoogleGenAI: class { live = { connect }; }, Modality: { AUDIO: 'AUDIO' },
    int16ToB64: audio.int16ToB64,
  }, 'Translator');
  return new Translator('ar');
}

test('PTT release sends pending input before stream-end and can resume', async () => {
  const sent = [];
  const t = translator(async () => ({ sendRealtimeInput: m => sent.push(m) }));
  await t.start(); t.feed(new Int16Array(128)); t.endInput();
  assert.equal(Buffer.from(sent[0].audio.data, 'base64').length, 256);
  assert.equal(sent[1].audioStreamEnd, true);
  t.feed(new Int16Array(320)); assert.equal(sent.length, 3);
});

test('hangup during Gemini connection closes the late session', async () => {
  let resolve, closed = 0;
  const t = translator(() => new Promise(r => { resolve = r; }));
  const starting = t.start(); t.close();
  resolve({ close: () => closed++ }); await starting;
  assert.equal(closed, 1); assert.equal(t.session, null);
});

test('late Gemini messages after hangup cannot enqueue audio', () => {
  const t = translator(() => {});
  let received = 0; t.onAudio = () => received++;
  t.close(); t._onMessage({ serverContent: { modelTurn: { parts: [
    { inlineData: { data: Buffer.alloc(20).toString('base64') } },
  ] } } });
  assert.equal(received, 0);
});

for (const transport of ['tcp', 'ws']) test(`${transport}: browser rebinds across calls; concurrent call cannot replace active call`, async () => {
  let tcpServer;
  const wsServers = [];
  class Server extends EventEmitter { listen() {} }
  class Bridge {
    constructor() { this.ready = false; this.closed = false; this.audio = 0; }
    async init() { this.ready = true; }
    attachAgent(ws) { this.agentWs = ws; }
    detachAgent(ws) { if (this.agentWs === ws) this.agentWs = null; }
    onAgentAudio() { this.audio++; }
    setPtt() {}
    close() { this.closed = true; }
  }
  let source = fs.readFileSync(new URL('../bridge/index.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\n/gm, '').replace("const __dirname = path.dirname(fileURLToPath(import.meta.url));", "const __dirname = '/tmp';");
  const context = vm.createContext({ console, Buffer, URL, process: { env: { GEMINI_API_KEY: 'fake' } },
    net: { createServer: fn => { tcpServer = new Server(); tcpServer.on('connection', fn); return tcpServer; } },
    http: { createServer: () => new Server() }, path: { join: (...s) => s.join('/') },
    WebSocketServer: class extends Server { constructor() { super(); wsServers.push(this); } },
    CallBridge: Bridge, createParser, FRAME: { UUID: 1, AUDIO: 16, HANGUP: 0 },
  });
  vm.runInContext(source + '\nthis.calls = activeCalls;', context);
  const agent = new EventEmitter(); agent.send = () => {}; wsServers[0].emit('connection', agent);
  function call() {
    const socket = new EventEmitter();
    socket.setNoDelay = () => {}; socket.send = () => {};
    socket.end = socket.close = socket.destroy = () => socket.emit('close');
    (transport === 'tcp' ? tcpServer : wsServers[1]).emit('connection', socket);
    socket.emit(transport === 'tcp' ? 'data' : 'message', Buffer.from([1, 0, 1, 42]));
    return socket;
  }
  const first = call(); await Promise.resolve();
  const bridge1 = context.calls.values().next().value;
  agent.emit('message', Buffer.from('{"type":"audio","data":"AA=="}'));
  assert.equal(bridge1.audio, 1);
  call(); assert.equal(context.calls.values().next().value, bridge1);
  // Transport close may arrive later; protocol hangup must clear the call now.
  first.end = first.close = () => {};
  first.emit(transport === 'tcp' ? 'data' : 'message', Buffer.from([0, 0, 0]));
  assert.equal(context.calls.size, 0);
  assert.equal(bridge1.closed, true);
  first.emit('close');
  call(); await Promise.resolve();
  const bridge2 = context.calls.values().next().value;
  agent.emit('message', Buffer.from('{"type":"audio","data":"AA=="}'));
  assert.equal(bridge1.audio, 1); assert.equal(bridge2.audio, 1);
  agent.emit('close'); assert.equal(bridge2.agentWs, null);
});

function browser() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, style: {},
      classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, remove() {},
    });
    return elements.get(id);
  };
  const sources = [], sockets = [], worklets = [];
  class AudioContext {
    state = 'running'; currentTime = 1; destination = {};
    async resume() {}
    close() { this.state = 'closed'; }
    createBuffer(channels, length, rate) { return { duration: length / rate, copyToChannel() {} }; }
    createBufferSource() {
      const src = { connect() {}, disconnect() {}, start() {}, stop() { this.stopped = true; } };
      sources.push(src); return src;
    }
    createMediaStreamSource() { return { connect() {} }; }
    audioWorklet = { addModule: async () => {} };
  }
  const context = vm.createContext({ console, Float32Array, Int16Array, Uint8Array,
    document: { getElementById: element }, window: { addEventListener() {} },
    location: { protocol: 'https:', host: 'example.test' },
    AudioContext, AudioWorkletNode: class {
      port = {}; constructor() { worklets.push(this); } disconnect() {}
    },
    WebSocket: class {
      static OPEN = 1; readyState = 1; messages = [];
      constructor() { sockets.push(this); }
      send(data) { this.messages.push(JSON.parse(data)); }
      close() { this.readyState = 3; this.onclose?.(); }
    },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, Blob: class {},
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame: () => 1,
  });
  const html = fs.readFileSync(new URL('../agent-ui/index.html', import.meta.url), 'utf8');
  vm.runInContext(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1], context);
  return { context, sources, sockets, worklets, run: code => vm.runInContext(code, context) };
}

test('browser sends 20ms chunks and flushes PTT tail before releasing', async () => {
  const b = browser(); await b.run('start()');
  b.sockets[0].onmessage({ data: JSON.stringify({ type: 'call', state: 'connected' }) });
  b.run('setTalking(true)');
  for (let i = 0; i < 3; i++) b.worklets[0].port.onmessage({ data: new Float32Array(128).fill(0.5) });
  b.run('setTalking(false)');
  const messages = b.sockets[0].messages;
  assert.deepEqual(messages.map(m => m.type), ['ptt', 'audio', 'audio', 'ptt']);
  assert.equal(Buffer.from(messages[1].data, 'base64').length, 640);
  assert.equal(Buffer.from(messages[2].data, 'base64').length, 128);
  assert.equal(messages[3].active, false);
  b.worklets[0].port.onmessage({ data: new Float32Array(128) });
  assert.equal(messages.length, 4);
});

test('hangup and disconnect cancel queued browser playback; mic can restart', async () => {
  const b = browser(); await b.run('start()');
  b.run('scheduleChunk(new Float32Array(2400))');
  b.sockets[0].onmessage({ data: JSON.stringify({ type: 'call', state: 'ended' }) });
  assert.equal(b.sources[0].stopped, true);
  b.run('scheduleChunk(new Float32Array(2400))');
  b.sockets[0].close(); assert.equal(b.sources[1].stopped, true);
  await b.run('start()');
  assert.equal(b.sockets.length, 2);
});

test('reattaching same browser preserves PTT; closing another browser cannot detach it', async () => {
  class Translator { async start() {} endInput() { this.ended = true; } close() {} }
  const { CallBridge } = loadModule('../bridge/CallBridge.js', {
    Translator, OutputPacer: class { start() {} stop() {} },
    WebSocket: { OPEN: 1 }, ...audio,
  }, 'CallBridge');
  const bridge = new CallBridge('test', {});
  await bridge.init();
  const sent = [];
  const ws = { readyState: 1, send: m => sent.push(m) };
  bridge.attachAgent(ws); bridge.setPtt(true); bridge.attachAgent(ws);
  assert.equal(bridge.agentTalking, true); assert.equal(sent.length, 2);
  bridge.detachAgent({}); assert.equal(bridge.agentWs, ws);
  bridge.detachAgent(ws); assert.equal(bridge.agentWs, null);
  assert.equal(bridge.toCustomer.ended, true);
});

test('microphone permission resolving after disconnect stops the late stream', async () => {
  const b = browser(); let resolve, stopped = 0;
  let requested;
  const ready = new Promise(r => { requested = r; });
  b.context.navigator.mediaDevices.getUserMedia = () => new Promise(r => { resolve = r; requested(); });
  const starting = b.run('start()');
  await ready;
  assert.equal(typeof resolve, 'function');
  b.sockets[0].close();
  resolve({ getTracks: () => [{ stop: () => stopped++ }] });
  await starting;
  assert.equal(stopped, 1); assert.equal(b.worklets.length, 0);
});


test('browser separates bridge connection from mic readiness and disables PTT after hangup', async () => {
  const b = browser();
  let resolveMic, requested;
  const pending = new Promise(r => { requested = r; });
  b.context.navigator.mediaDevices.getUserMedia = () => new Promise(r => { resolveMic = r; requested(); });
  const starting = b.run('start()');
  await pending;
  b.sockets[0].onopen();
  b.sockets[0].onmessage({ data: JSON.stringify({ type: 'call', state: 'connected' }) });
  assert.equal(b.run("$('bridge-status').textContent"), 'Bridge connected');
  assert.equal(b.run("$('ptt').disabled"), true);
  b.run('setTalking(true)');
  assert.equal(b.run('talking'), false);
  resolveMic({ getTracks: () => [] });
  await starting;
  assert.equal(b.run("$('ptt').disabled"), false);
  b.run('setTalking(true)');
  b.sockets[0].onmessage({ data: JSON.stringify({ type: 'call', state: 'ended' }) });
  assert.equal(b.run("$('status-pill').textContent"), 'Call Ended');
  assert.equal(b.run("$('ptt').disabled"), true);
  assert.equal(b.run('talking'), false);
  assert.equal(b.run('callTimerInterval'), null);
  b.run('setTalking(true)');
  assert.equal(b.run('talking'), false);
});
