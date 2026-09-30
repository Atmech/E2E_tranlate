import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputPacer } from '../bridge/audiosocket.js';
function setup(options = {}) {
  let time = 0;
  const sent = [], sock = { writable: true, write: frame => sent.push(frame) };
  const pacer = new OutputPacer(sock, { now: () => time, encodeFrame: b => b,
    sendSilence: false, logIntervalMs: 0, ...options });
  return { pacer, sent, sock, tick: ms => { time = ms; pacer._tick(); } };
}
test('default preserves a 15.64 second burst and counts its duration', () => {
  const { pacer, sent, tick } = setup();
  const input = Buffer.alloc(15640 * 16);
  for (let i = 0; i < input.length; i++) input[i] = i % 251;
  pacer.push(input);
  assert.equal(pacer.queuedBytes, input.length);
  assert.equal(pacer.queuedMs, 15640);
  assert.equal(pacer.stats.droppedMs, 0);
  for (let ms = 20; ms <= 15640; ms += 20) tick(ms);
  assert.deepEqual(Buffer.concat(sent), input);
  assert.equal(pacer.stats.inputAudioMs, 15640);
  assert.equal(pacer.stats.submittedAudioMs, 15640);
  assert.equal(pacer.queuedBytes, 0);
});
test('explicit trimming retains newest three seconds and records discarded speech', () => {
  const { pacer, sent, tick } = setup({ trimBacklog: true });
  const input = Buffer.alloc(15640 * 16);
  for (let i = 0; i < input.length; i++) input[i] = i % 251;
  pacer.push(input);
  assert.equal(pacer.queuedMs, 3000);
  assert.equal(pacer.stats.droppedMs, 12640);
  for (let ms = 20; ms <= 3000; ms += 20) tick(ms);
  assert.deepEqual(Buffer.concat(sent), input.subarray(input.length - 48000));
});
test('split input preserves samples and accounts for partial-frame bytes', () => {
  const { pacer, sent, tick } = setup();
  const input = Buffer.alloc(1438);
  for (let i = 0; i < input.length; i++) input[i] = i % 251;
  let offset = 0;
  for (const length of [2, 300, 6, 322, 100, 708]) {
    pacer.push(input.subarray(offset, offset + length)); offset += length;
    assert.equal(pacer.queuedBytes, offset);
  }
  pacer.commit();
  for (let ms = 20; ms <= 100; ms += 20) tick(ms);
  assert.deepEqual(Buffer.concat(sent).subarray(0, input.length), input);
  assert.ok(Buffer.concat(sent).subarray(input.length).every(b => b === 0));
});
test('blocked playback and late ticks are measured without dropping or burst catch-up', () => {
  const { pacer, sent, sock, tick } = setup();
  pacer.push(Buffer.alloc(3200));
  tick(20);
  sock.writable = false;
  tick(40); tick(140);
  assert.equal(sent.length, 1);
  sock.writable = true;
  tick(240);
  assert.equal(sent.length, 2);
  assert.equal(pacer.stats.observedBlockedMs, 200);
  assert.equal(pacer.stats.maxTickGapMs, 100);
  assert.equal(pacer.stats.delayedTicks, 2);
  assert.equal(pacer.stats.droppedMs, 0);
});
test('invalid backlog options fail before playback starts', () => {
  for (const options of [{ maxBacklogMs: NaN }, { targetBacklogMs: -1 },
    { maxBacklogMs: 1000 }, { trimBacklog: 'false' }, { logIntervalMs: -1 }]) {
    assert.throws(() => setup(options));
  }
});
