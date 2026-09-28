import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleNativeConnection } from '../bridge/native-websocket.js';

const start = { event: 'MEDIA_START', connection_id: 'test-call', format: 'slin', optimal_frame_size: 320, ptime: 20 };
const settle = () => new Promise(resolve => setImmediate(resolve));

function connect(t, { activeCalls = new Map(), agents = new Set(), init } = {}) {
  const ws = new EventEmitter();
  ws.readyState = 1; ws.bufferedAmount = 0; ws.sent = [];
  ws.send = (data, options) => ws.sent.push({ data, options });
  ws.close = (code, reason) => {
    ws.closeCode = code; ws.closeReason = reason; ws.readyState = 3; ws.emit('close');
  };
  let call;
  handleNativeConnection(ws, { activeCalls, agents, createBridge: (id, sock, { pacer }) => {
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
