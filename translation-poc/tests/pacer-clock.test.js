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
    time = job.at + lateness;
    if (job.interval) job.at = time + job.interval;
    else jobs.delete(id);
    job.fn();
  }
  return { jobs, fire, nextAt: () => next()?.[1].at,
    runUntil(until, lateness = 0) {
      while (jobs.size && next()[1].at + lateness <= until) fire(lateness);
      time = until;
    },
    pacer(onWrite = () => {}) {
      const sent = [];
      const sock = { writable: true, write(frame) { sent.push(frame); onWrite(); } };
      const pacer = new context.OutputPacer(sock, { encodeFrame: b => b,
        sendSilence: false, logIntervalMs: 0 });
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

test('a missed full period re-anchors without dumping queued frames', () => {
  const c = clock(), { pacer, sent } = c.pacer();
  pacer.push(Buffer.alloc(3200)); pacer.start();
  c.fire(5); // Deadline 20, fires 25: next deadline remains 40.
  assert.equal(c.nextAt(), 40);
  c.fire(65); // Deadline 40, fires 105: restart at 125.
  assert.equal(sent.length, 2);
  assert.equal(c.nextAt(), 125);
  c.fire();
  assert.equal(sent.length, 3);
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
  sock.writable = true; c.fire(1.3);
  assert.equal(sent.length, 2);
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
