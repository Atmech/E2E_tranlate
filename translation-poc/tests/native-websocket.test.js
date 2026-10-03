import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleNativeConnection } from '../bridge/native-websocket.js';

const start = { event: 'MEDIA_START', connection_id: 'test-call', format: 'slin', optimal_frame_size: 320, ptime: 20 };
const settle = () => new Promise(resolve => setImmediate(resolve));

function connect(t, { activeCalls = new Map(), agents = new Set(), init, mode = 'mock', createTranslator } = {}) {
  const ws = new EventEmitter();
  ws.readyState = 1; ws.bufferedAmount = 0; ws.sent = [];
  ws.send = (data, options) => ws.sent.push({ data, options });
  ws.close = (code, reason) => {
    ws.closeCode = code; ws.closeReason = reason; ws.readyState = 3; ws.emit('close');
  };
  let call;
  handleNativeConnection(ws, { activeCalls, agents, mode, createTranslator, createBridge: (id, sock, { pacer }) => {
    call = {
      id, sock, pacer, audio: [], attached: [], closed: false,
      init: init || (async () => {}),
      onCallAudio(pcm) { this.audio.push(pcm); },
      attachAgent(agent) { this.attached.push(agent); },
      close() { this.closed = true; pacer.stop(); },
    };
    return call;
  } });
  t.after(() => ws.close(1000));
  return { ws, activeCalls, get call() { return call; },
    control: event => ws.emit('message', Buffer.from(typeof event === 'string' ? event : JSON.stringify(event)), false),
    audio: pcm => ws.emit('message', pcm, true),
  };
}

for (const format of ['text', 'json']) test(`${format}: native setup, raw PCM both ways, and hangup cleanup`, async t => {
  const agent = {};
  const c = connect(t, { agents: new Set([agent]) });
  c.control(format === 'json' ? start : 'MEDIA_START connection_id:test-call channel:WebSocket/test format:slin optimal_frame_size:320 ptime:20');
  await settle();
  assert.equal(c.activeCalls.size, 1);
  assert.deepEqual(c.call.attached, [agent]);
  const pcm = Buffer.alloc(320, 42);
  c.audio(pcm);
  assert.deepEqual(c.call.audio, [pcm]);
  c.call.pacer._tick();
  assert.equal(c.ws.sent.length, 0, 'Asterisk generates idle silence itself');
  c.call.pacer.push(pcm); c.call.pacer.commit(); c.call.pacer._tick();
  assert.deepEqual(c.ws.sent, [{ data: pcm, options: { binary: true } }], 'no AudioSocket header');
  c.ws.close(1000);
  assert.equal(c.activeCalls.size, 0);
  assert.equal(c.call.closed, true);
  assert.equal(c.call.sock.destroyed, true);
});

test('XOFF retains queued audio and XON resumes; partial PCM output is padded', t => {
  const c = connect(t); c.control(start);
  c.call.pacer.push(Buffer.alloc(42, 7)); c.call.pacer.commit();
  c.control('MEDIA_XOFF'); c.call.pacer._tick();
  assert.equal(c.ws.sent.length, 0); assert.equal(c.call.pacer.queue.length, 42);
  c.control('MEDIA_XON'); c.call.pacer._tick();
  assert.equal(c.ws.sent[0].data.length, 320);
  assert.deepEqual(c.ws.sent[0].data.subarray(0, 42), Buffer.alloc(42, 7));
  assert.deepEqual(c.ws.sent[0].data.subarray(42), Buffer.alloc(278));
});

test('reject invalid setup, audio before setup, odd PCM, and duplicate setup', t => {
  for (const invalid of [
    c => c.control({ ...start, format: 'ulaw' }),
    c => c.control({ ...start, optimal_frame_size: 640 }),
    c => c.control({ ...start, connection_id: '' }),
    c => c.control('{broken'),
    c => c.audio(Buffer.alloc(320)),
    c => { c.control(start); c.audio(Buffer.alloc(3)); },
    c => { c.control(start); c.control(start); },
  ]) {
    const c = connect(t); invalid(c);
    assert.equal(c.ws.closeCode, 1008); assert.equal(c.activeCalls.size, 0);
  }
});

test('concurrent call is rejected; next call can reuse the connected browser', async t => {
  const activeCalls = new Map(), agent = {}, agents = new Set([agent]);
  const first = connect(t, { activeCalls, agents }); first.control(start); await settle();
  const second = connect(t, { activeCalls, agents }); second.control({ ...start, connection_id: 'second' });
  assert.equal(second.ws.closeCode, 1008); assert.equal(activeCalls.get('test-call'), first.call);
  first.ws.close(1000);
  const third = connect(t, { activeCalls, agents }); third.control({ ...start, connection_id: 'third' }); await settle();
  assert.deepEqual(third.call.attached, [agent]); assert.equal(activeCalls.size, 1);
});

test('disconnect during initialization cannot reattach a browser; setup failure releases call', async t => {
  let resolve;
  const c = connect(t, { agents: new Set([{}]), init: () => new Promise(r => { resolve = r; }) });
  c.control(start); c.ws.close(1000); resolve(); await settle();
  assert.equal(c.activeCalls.size, 0); assert.deepEqual(c.call.attached, []);
  const failed = connect(t, { init: async () => { throw new Error('test setup failure'); } });
  failed.control(start); await settle();
  assert.equal(failed.activeCalls.size, 0); assert.equal(failed.call.closed, true);
  assert.equal(failed.ws.closeCode, 1008);
});

test('slow network closes call instead of accumulating an unbounded WebSocket send buffer', t => {
  const c = connect(t); c.control(start); c.ws.bufferedAmount = 80001;
  c.call.pacer.push(Buffer.alloc(320)); c.call.pacer.commit(); c.call.pacer._tick();
  assert.equal(c.ws.closeCode, 1008); assert.equal(c.activeCalls.size, 0);
});

for (const format of ['text', 'json']) test(`${format}: loopback echoes exact binary audio without creating translators`, async t => {
  const c = connect(t, { mode: 'loopback', agents: new Set([{}]) });
  c.control(format === 'json' ? start : 'MEDIA_START connection_id:test-call format:slin optimal_frame_size:320 ptime:20');
  await settle();
  assert.equal(c.call, undefined, 'translation bridge factory must not run');
  assert.equal(c.activeCalls.size, 1);
  assert.equal(c.activeCalls.get('test-call').ready, false, 'browser must not bind to echo test');
  assert.equal(c.ws.sent.length, 0, 'control events must not be echoed as audio');
  const pcm = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) pcm.writeInt16LE(i * 100 - 8000, i * 2);
  c.audio(pcm);
  assert.deepEqual(c.ws.sent, [{ data: pcm, options: { binary: true } }]);
  c.control('MEDIA_XOFF'); c.audio(pcm);
  assert.equal(c.ws.sent.length, 1, 'respect Asterisk flow control');
  c.control('MEDIA_XON'); c.audio(pcm);
  assert.equal(c.ws.sent.length, 2);
  c.ws.close(1000); c.audio(pcm);
  assert.equal(c.activeCalls.size, 0); assert.equal(c.ws.sent.length, 2);
});

test('loopback preserves setup validation, single-call exclusion, and slow-network protection', t => {
  const early = connect(t, { mode: 'loopback' }); early.audio(Buffer.alloc(320));
  assert.equal(early.ws.closeCode, 1008);
  const wrong = connect(t, { mode: 'loopback' }); wrong.control({ ...start, format: 'ulaw' });
  assert.equal(wrong.ws.closeCode, 1008);
  const c = connect(t, { mode: 'loopback' }); c.control(start);
  const concurrent = connect(t, { mode: 'loopback', activeCalls: c.activeCalls }); concurrent.control(start);
  assert.equal(concurrent.ws.closeCode, 1008); assert.equal(c.activeCalls.size, 1);
  c.ws.bufferedAmount = 80001; c.audio(Buffer.alloc(320));
  assert.equal(c.ws.closeCode, 1008); assert.equal(c.activeCalls.size, 0);
});

test('brief XOFF/XON between callbacks suppresses catch-up on resume', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = connect(t); c.control(start);
  let now = 0;
  const pacer = c.call.pacer;
  pacer.now = () => now;
  pacer.push(Buffer.alloc(6400, 7)); pacer.start();
  now = 20; t.mock.timers.tick(20);
  assert.equal(c.ws.sent.length, 1);
  now = 30; c.control('MEDIA_XOFF');
  now = 35; c.control({ event: 'MEDIA_XON' });
  now = 120; t.mock.timers.tick(20); // Timer for 40ms is 80ms late.
  assert.equal(c.ws.sent.length, 2, 'resume sends only one frame');
  assert.equal(pacer.nextTickAt, 140);
  assert.equal(pacer.stats.recoveredFrames, 0);
  assert.equal(pacer.stats.schedulerResyncs, 1);
  now = 140; t.mock.timers.tick(20);
  assert.equal(c.ws.sent.length, 3);
  now = 240; t.mock.timers.tick(20);
  assert.equal(c.ws.sent.length, 8, 'later scheduler stalls can recover normally');
  c.ws.close(1000);
  now = 400; t.mock.timers.tick(100);
  assert.equal(c.ws.sent.length, 8);
});

test('paired translation XOFF/XON resets only the affected direction', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const activeCalls = new Map();
  const createTranslator = () => ({ async start() {}, close() {}, feed() {} });
  const caller = connect(t, { activeCalls, mode: 'translation', createTranslator });
  const agent = connect(t, { activeCalls, mode: 'translation', createTranslator });
  const metadata = { CALL_ID: 'clock-pair', ROLE: 'caller', SOURCE_LANG: 'hi', TARGET_LANG: 'en' };
  caller.control({ ...start, channel_variables: metadata });
  agent.control({ ...start, channel_variables: { ...metadata, ROLE: 'agent', SOURCE_LANG: 'en', TARGET_LANG: 'hi' } });
  let now = 0;
  const session = activeCalls.get('clock-pair');
  for (const leg of session.legs.values()) leg.pacer.now = () => now;
  await settle();
  assert.equal(session.ready, true);
  for (const leg of session.legs.values()) leg.pacer.push(Buffer.alloc(6400, 8));
  now = 20; t.mock.timers.tick(20);
  caller.control('MEDIA_XOFF'); caller.control('MEDIA_XON');
  now = 120; t.mock.timers.tick(20);
  assert.equal(caller.ws.sent.length, 2);
  assert.equal(agent.ws.sent.length, 6);
  assert.equal(session.legs.get('caller').pacer.stats.recoveredFrames, 0);
  assert.equal(session.legs.get('agent').pacer.stats.recoveredFrames, 4);
  caller.ws.close(1000);
  assert.equal(activeCalls.size, 0);
  now = 500; t.mock.timers.tick(100);
  assert.equal(agent.ws.sent.length, 6, 'hangup cancels both clocks');
});

test('send-buffer failure during catch-up closes playback before further writes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = connect(t); c.control(start);
  let now = 0;
  c.call.pacer.now = () => now;
  c.ws.send = (data, options) => {
    c.ws.sent.push({ data, options }); c.ws.bufferedAmount = 80001;
  };
  c.call.pacer.push(Buffer.alloc(6400)); c.call.pacer.start();
  now = 100; t.mock.timers.tick(20);
  assert.equal(c.ws.sent.length, 1);
  assert.equal(c.ws.closeCode, 1008);
  assert.equal(c.call.pacer.running, false);
  assert.equal(c.activeCalls.size, 0);
  now = 300; t.mock.timers.tick(100);
  assert.equal(c.ws.sent.length, 1);
});
