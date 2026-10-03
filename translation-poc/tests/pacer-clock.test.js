import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run the actual pacer with a deterministic clock and controllable timer lateness.
// No wall-clock sleeps or changes to process-wide timers.
function clock() {
  let time = 0, nextId = 0;
  const jobs = new Map();
  const schedule = (fn, delay, interval = 0) => {
    const id = ++nextId;
    jobs.set(id, { fn, at: time + delay, interval });
    return id;
  };
  const context = vm.createContext({ Buffer, process: { env: {} },
    performance: { now: () => time }, console: { log() {}, warn() {} },
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => jobs.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: id => jobs.delete(id),
  });
  const source = fs.readFileSync(new URL('../bridge/audiosocket.js', import.meta.url), 'utf8')
    .replace(/^export /gm, '');
  vm.runInContext(source + '\nglobalThis.OutputPacer = OutputPacer;', context);
  const next = () => [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
  function fire(lateness = 0) {
    const [id, job] = next();
    time = Math.max(time, job.at + lateness);
    if (job.interval) job.at = time + job.interval;
    else jobs.delete(id);
    job.fn();
  }
  return { jobs, fire, nextAt: () => next()?.[1].at,
    get time() { return time; },
    advanceTo: until => { assert.ok(until >= time); time = until; },
    runUntil(until, lateness = 0) {
      while (jobs.size && next()[1].at + lateness <= until) fire(lateness);
      time = until;
    },
    pacer(onWrite = () => {}, options = {}) {
      const sent = [];
      const sock = { writable: true, write(frame) { sent.push(frame); onWrite(); } };
      const pacer = new context.OutputPacer(sock, { encodeFrame: b => b,
        sendSilence: false, logIntervalMs: 0, ...options });
      return { pacer, sock, sent };
    },
  };
}

test('small timer lateness does not accumulate over 90 seconds', () => {
  const c = clock(), { pacer, sent } = c.pacer();
  const pcm = Buffer.alloc(90000 * 16, 7);
  pacer.push(pcm); pacer.start();
  c.runUntil(90000, 1.3);
  assert.equal(sent.length, 4499);
  assert.equal(pacer.queuedMs, 20);
  assert.equal(pacer.stats.droppedMs, 0);
  c.runUntil(90022, 1.3);
  assert.deepEqual(Buffer.concat(sent), pcm);
  pacer.stop();
  assert.equal(c.jobs.size, 0);
});

test('late callbacks recover missed audio deadlines and retain the original clock', () => {
  const c = clock(), { pacer, sent } = c.pacer();
  pacer.push(Buffer.alloc(3200)); pacer.start();
  c.fire(5); // Deadline 20, fires 25: next deadline remains 40.
  assert.equal(c.nextAt(), 40);
  c.fire(65); // Deadline 40, fires 105: four frames due, next deadline 120.
  assert.equal(sent.length, 5);
  assert.equal(pacer.stats.recoveredFrames, 3);
  assert.equal(pacer.stats.maxSchedulerLatenessMs, 65);
  assert.equal(c.nextAt(), 120);
  c.fire();
  assert.equal(sent.length, 6);
  pacer.stop();
});

test('scheduled playback preserves paused audio and resumes one frame at a time', () => {
  const c = clock(), { pacer, sock, sent } = c.pacer();
  pacer.push(Buffer.alloc(3200)); pacer.start();
  c.fire(); sock.writable = false;
  const queued = pacer.queuedBytes;
  c.runUntil(220, 1.3);
  assert.equal(pacer.queuedBytes, queued);
  assert.equal(sent.length, 1);
  sock.writable = true; c.fire(80);
  assert.equal(sent.length, 2);
  assert.equal(c.nextAt(), c.time + 20);
  assert.equal(pacer.stats.recoveredFrames, 0);
  assert.equal(pacer.stats.droppedMs, 0);
  pacer.stop();
});

test('duplicate start, stop during write, and restart leave only the intended timer', () => {
  const c = clock();
  let stopOnWrite = false;
  const { pacer, sent } = c.pacer(() => { if (stopOnWrite) pacer.stop(); });
  pacer.push(Buffer.alloc(3200)); pacer.start(); pacer.start();
  assert.equal(c.jobs.size, 1);
  stopOnWrite = true; c.fire();
  assert.equal(sent.length, 1);
  assert.equal(c.jobs.size, 0, 'callback must not reschedule after stop');
  stopOnWrite = false;
  pacer.push(Buffer.alloc(3200)); pacer.start();
  assert.equal(c.jobs.size, 1);
  c.fire(); assert.equal(sent.length, 2);
  pacer.stop();
  assert.equal(c.jobs.size, 0);
  c.runUntil(500); assert.equal(sent.length, 2);
});

test('stopping one pacer leaves the other call clock running', () => {
  const c = clock(), a = c.pacer(), b = c.pacer();
  for (const p of [a.pacer, b.pacer]) { p.push(Buffer.alloc(3200)); p.start(); }
  c.runUntil(100, 1.3);
  a.pacer.stop();
  const aFrames = a.sent.length, bFrames = b.sent.length;
  assert.equal(c.jobs.size, 1);
  c.runUntil(200, 1.3);
  assert.equal(a.sent.length, aFrames);
  assert.ok(b.sent.length > bFrames);
  b.pacer.stop(); assert.equal(c.jobs.size, 0);
});

for (const maxCatchUpFrames of [0, 2, 4]) test(`large stalls cap catch-up at ${maxCatchUpFrames} extra frames and resync`, () => {
  const c = clock(), { pacer, sent } = c.pacer(() => {}, { maxCatchUpFrames });
  const pcm = Buffer.alloc(6400);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
  pacer.push(pcm); pacer.start(); c.fire(2000);
  assert.equal(sent.length, 1 + maxCatchUpFrames);
  assert.equal(pacer.stats.recoveredFrames, maxCatchUpFrames);
  assert.equal(pacer.stats.schedulerResyncs, 1);
  assert.equal(c.nextAt(), 2040);
  c.fire(); assert.equal(sent.length, 2 + maxCatchUpFrames);
  c.runUntil(2500);
  assert.deepEqual(Buffer.concat(sent), pcm);
  assert.equal(pacer.stats.droppedMs, 0);
  pacer.stop();
});

test('idle and incomplete audio never add silence during catch-up', () => {
  for (const bytes of [0, 30, 350, 640]) {
    const c = clock(), { pacer, sent } = c.pacer(() => {}, { sendSilence: true, prebufferMs: 20 });
    pacer.push(Buffer.alloc(bytes, 9)); pacer.start(); c.fire(80);
    assert.equal(sent.length, Math.max(1, Math.floor(bytes / 320)));
    assert.equal(pacer.stats.silenceFrames, bytes < 320 ? 1 : 0);
    assert.equal(pacer.queuedBytes, bytes % 320);
    assert.equal(c.nextAt(), 120);
    if (bytes % 320) {
      c.fire(); // Tail timeout at 120ms, pad once and preserve all samples.
      const audio = Buffer.concat(sent.filter(b => b.some(byte => byte !== 0)));
      assert.deepEqual(audio.subarray(0, bytes), Buffer.alloc(bytes, 9));
      assert.ok(audio.subarray(bytes).every(byte => byte === 0));
      assert.equal(pacer.queuedBytes, 0);
    }
    pacer.stop();
  }
});

test('committed partial tails can catch up and are padded only once', () => {
  const c = clock(), { pacer, sent } = c.pacer(() => {}, { sendSilence: true });
  pacer.push(Buffer.alloc(350, 6)); pacer.commit(); pacer.start(); c.fire(80);
  assert.equal(sent.length, 2);
  assert.equal(pacer.stats.recoveredFrames, 1);
  assert.equal(pacer.stats.silenceFrames, 0);
  assert.deepEqual(Buffer.concat(sent).subarray(0, 350), Buffer.alloc(350, 6));
  assert.ok(sent[1].subarray(30).every(byte => byte === 0));
  pacer.stop();
});

for (const action of ['stop', 'disconnect', 'block']) test(`catch-up stops immediately on ${action} during a write`, () => {
  const c = clock();
  const { pacer, sock, sent } = c.pacer(() => {
    if (sent.length !== 2) return;
    if (action === 'stop') pacer.stop();
    else if (action === 'disconnect') sock.destroyed = true;
    else sock.writable = false;
  });
  pacer.push(Buffer.alloc(3200)); pacer.start(); c.fire(80);
  assert.equal(sent.length, 2);
  if (action === 'stop') assert.equal(c.jobs.size, 0);
  else { c.fire(); assert.equal(sent.length, 2); }
  pacer.stop();
  assert.equal(c.jobs.size, 0);
});

test('slow writes do not schedule an immediate second catch-up burst', () => {
  const c = clock();
  const { pacer, sent } = c.pacer(() => c.advanceTo(c.time + 25));
  pacer.push(Buffer.alloc(6400)); pacer.start(); c.fire(80);
  assert.equal(sent.length, 5);
  assert.equal(c.nextAt(), c.time + 20);
  assert.equal(pacer.stats.schedulerResyncs, 1);
  pacer.stop();
});

test('five calls / ten directions preserve audio across five minutes of shared stalls', () => {
  const c = clock(), legs = Array.from({ length: 10 }, () => c.pacer());
  const input = Buffer.alloc(300000 * 16);
  for (let i = 0; i < input.length; i++) input[i] = i % 251;
  for (const { pacer } of legs) pacer.start();
  let fedUntil = 0;
  while (true) {
    let next = Math.min(fedUntil + 20, c.nextAt());
    // 124 event-loop stalls of 60ms; all ten pacers share the same clock.
    const stall = Math.floor(next / 2400) * 2400;
    if (stall > 0 && stall < 300000 && next < stall + 60) next = stall + 60;
    if (next > 300000) break;
    c.advanceTo(next);
    const inputUntil = Math.floor(next / 20) * 20;
    if (inputUntil > fedUntil) {
      for (const { pacer } of legs) pacer.push(input.subarray(fedUntil * 16, inputUntil * 16));
      fedUntil = inputUntil;
    }
    while (c.nextAt() <= c.time) c.fire();
  }
  for (const { pacer } of legs) {
    assert.equal(pacer.stats.inputAudioMs, 300000);
    assert.ok(pacer.queuedMs <= 80, `backlog grew to ${pacer.queuedMs}ms`);
    assert.equal(pacer.stats.delayedTicks, 124);
    assert.equal(pacer.stats.recoveredFrames, 372);
    assert.equal(pacer.stats.schedulerResyncs, 0);
    assert.equal(pacer.stats.droppedMs, 0);
  }
  c.runUntil(300200);
  for (const { pacer, sent } of legs) {
    assert.deepEqual(Buffer.concat(sent), input, 'all samples must arrive once, in order');
    pacer.stop();
  }
  assert.equal(c.jobs.size, 0);
});
