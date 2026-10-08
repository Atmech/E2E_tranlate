// AudioSocket TLV protocol: [type:1][len:2 big-endian][payload:len].
// Types: 0x00 hangup, 0x01 UUID(16B, first frame), 0x03 DTMF(1B ascii),
//        0x10 audio SLIN 8kHz (320B = 160 samples = 20ms), 0xff error.

export const FRAME = {
  HANGUP: 0x00,
  UUID: 0x01,
  DTMF: 0x03,
  AUDIO: 0x10, // SLIN 8kHz
  ERROR: 0xff,
};

export const SAMPLES_PER_FRAME = 160; // 20ms @ 8kHz
export const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2; // 320

// Stateful parser. TCP coalesces/splits frames, so buffer until a full frame is present.
export function createParser(onFrame) {
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 3) {
      const type = buf[0];
      const len = buf.readUInt16BE(1);
      if (buf.length < 3 + len) break; // wait for the rest
      const payload = buf.subarray(3, 3 + len);
      buf = buf.subarray(3 + len);
      onFrame(type, payload);
    }
  };
}

export function buildAudioFrame(buf320) {
  const frame = Buffer.allocUnsafe(3 + buf320.length);
  frame[0] = FRAME.AUDIO;
  frame.writeUInt16BE(buf320.length, 1);
  buf320.copy(frame, 3);
  return frame;
}

export function buildHangupFrame() {
  return Buffer.from([FRAME.HANGUP, 0x00, 0x00]);
}

// Keep a small jitter buffer, but bound wall-clock waiting as well as audio quantity.
// Continuous translation does not reliably emit turn-end events.
function milliseconds(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 20 || value > 2000)
    throw new Error(`${name} must be between 20 and 2000 milliseconds`);
  return value;
}
const PREBUFFER_MS = milliseconds('PACER_PREBUFFER_MS', 80);
const MAX_WAIT_MS = milliseconds('PACER_MAX_WAIT_MS', 120);
const END_GAP_MS = milliseconds('PACER_END_GAP_MS', 200);
const SILENCE_FRAME = Buffer.alloc(BYTES_PER_FRAME);

// Proposed buffer optimization based on Rajiv's frame queue.
// Default: preserve speech. Optional trimming deliberately discards old audio.
export class OutputPacer {
  constructor(sock, { now = () => performance.now(), prebufferMs = PREBUFFER_MS,
    maxWaitMs = MAX_WAIT_MS, endGapMs = END_GAP_MS,
    encodeFrame = buildAudioFrame, sendSilence = true,
    warnBacklogMs = 3000, maxBacklogMs = 6000, targetBacklogMs = 3000,
    trimBacklog = false, label = 'unlabelled', logIntervalMs = 5000,
    maxCatchUpFrames = 4 } = {}) {
    for (const [name, value] of Object.entries({ warnBacklogMs, maxBacklogMs, targetBacklogMs })) {
      if (!Number.isFinite(value) || value < 20 || value > 30000)
        throw new Error(`${name} must be between 20 and 30000 milliseconds`);
    }
    if (targetBacklogMs > maxBacklogMs || warnBacklogMs > maxBacklogMs)
      throw new Error('Backlog target and warning must not exceed maximum');
    if (typeof trimBacklog !== 'boolean') throw new Error('trimBacklog must be boolean');
    if (!Number.isFinite(logIntervalMs) || logIntervalMs < 0)
      throw new Error('logIntervalMs must be nonnegative; zero disables periodic logging');
    if (!Number.isInteger(maxCatchUpFrames) || maxCatchUpFrames < 0 || maxCatchUpFrames > 10)
      throw new Error('maxCatchUpFrames must be an integer between 0 and 10');
    Object.assign(this, { sock, now, maxWaitMs, endGapMs, encodeFrame, sendSilence,
      trimBacklog, label, logIntervalMs, maxCatchUpFrames });
    this.prebufferBytes = Math.ceil(prebufferMs / 20) * BYTES_PER_FRAME;
    this.warnBacklogBytes = Math.ceil(warnBacklogMs / 20) * BYTES_PER_FRAME;
    this.maxBacklogBytes = Math.ceil(maxBacklogMs / 20) * BYTES_PER_FRAME;
    this.targetBacklogFrames = Math.ceil(targetBacklogMs / 20);
    this.timer = null;
    this.running = false;
    this.nextTickAt = null;
    this.startedAt = null;
    this.lastTickAt = null;
    this.lastLogAt = null;
    this.wasBlocked = false;
    this.clockResetPending = false;
    this.stats = { audioFrames: 0, silenceFrames: 0, maxQueueMs: 0, maxStartWaitMs: 0,
      inputAudioMs: 0, submittedAudioMs: 0, maxInputChunkMs: 0,
      backlogWarnings: 0, backlogTrims: 0, droppedFrames: 0, droppedMs: 0,
      maxTickGapMs: 0, delayedTicks: 0, observedBlockedMs: 0,
      recoveredFrames: 0, schedulerResyncs: 0, maxSchedulerLatenessMs: 0 };
    this.flush();
  }

  get queuedFrames() { return this.frames.length - this.head; }
  get queuedBytes() { return this.queuedFrames * BYTES_PER_FRAME + this.partial.length; }
  get queuedMs() { return this.queuedBytes / 16; }
  // Compatibility snapshot for existing inspection/tests. Runtime uses queuedBytes
  // to avoid allocating and copying the backlog just to inspect its size.
  get queue() { return Buffer.concat([...this.frames.slice(this.head), this.partial], this.queuedBytes); }

  commit() { this.committed = this.queuedBytes > 0; }
  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.lastTickAt = this.startedAt;
    this.lastLogAt = this.startedAt;
    this.wasBlocked = this.sock?.writable === false;
    this.clockResetPending = false;
    this.nextTickAt = this.startedAt + 20;
    this._scheduleNextTick();
  }

  // Flow-control events can occur entirely between timer callbacks. Discard
  // scheduling debt on the next callback, while preserving the audio queue.
  resetClock() {
    if (this.running) this.clockResetPending = true;
  }

  _scheduleNextTick() {
    if (!this.running) return;
    const delay = Math.max(0, Math.ceil(this.nextTickAt - this.now()));
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running) return;
      const scheduledAt = this.nextTickAt;
      const lateness = Math.max(0, this.now() - scheduledAt);
      this.stats.maxSchedulerLatenessMs = Math.max(this.stats.maxSchedulerLatenessMs, lateness);
      const ticksDue = 1 + Math.floor(lateness / 20);
      const resetClock = this.clockResetPending || (this.wasBlocked && this.sock?.writable !== false);
      this.clockResetPending = false;
      const firstResult = this._tick();
      if (!this.running) return;
      let recovered = 0;
      if (!resetClock && firstResult === 'audio') {
        const limit = Math.min(ticksDue - 1, this.maxCatchUpFrames);
        while (recovered < limit && this.running && !this.clockResetPending &&
            !this.sock?.destroyed && this.sock?.writable !== false) {
          if (this._tick({ audioOnly: true }) !== 'audio') break;
          recovered++;
          this.stats.recoveredFrames++;
        }
      }
      if (!this.running) return;
      const nextDeadline = scheduledAt + ticksDue * 20;
      // Retain the monotonic clock only when all due frames were serviced.
      // Resync after flow control, insufficient audio, or a large stall. Slow
      // writes also re-anchor, avoiding consecutive zero-delay catch-up bursts.
      const now = this.now();
      if (resetClock || this.clockResetPending || 1 + recovered < ticksDue || nextDeadline <= now) {
        this.stats.schedulerResyncs++;
        this.nextTickAt = now + 20;
      } else this.nextTickAt = nextDeadline;
      this._scheduleNextTick();
    }, delay);
  }

  push(buf) {
    if (!buf?.length) return;
    if (buf.length % 2) throw new Error('PCM must contain complete 16-bit samples');
    const now = this.now();
    if (!this.queuedBytes) this.queuedAt = now;
    this.lastPushAt = now;
    this.stats.inputAudioMs += buf.length / 16;
    this.stats.maxInputChunkMs = Math.max(this.stats.maxInputChunkMs, buf.length / 16);
    let offset = 0;
    if (this.partial.length) {
      const needed = BYTES_PER_FRAME - this.partial.length;
      if (buf.length < needed) {
        this.partial = Buffer.concat([this.partial, buf]);
        this._checkBacklog(now);
        return;
      }
      const frame = Buffer.allocUnsafe(BYTES_PER_FRAME);
      this.partial.copy(frame);
      buf.copy(frame, this.partial.length, 0, needed);
      this.frames.push(frame);
      this.partial = Buffer.alloc(0);
      offset = needed;
    }
    for (; offset + BYTES_PER_FRAME <= buf.length; offset += BYTES_PER_FRAME)
      this.frames.push(buf.subarray(offset, offset + BYTES_PER_FRAME));
    if (offset < buf.length) this.partial = Buffer.from(buf.subarray(offset));
    this._checkBacklog(now);
  }

  _checkBacklog(now) {
    this.stats.maxQueueMs = Math.max(this.stats.maxQueueMs, this.queuedMs);
    if (this.queuedBytes >= this.warnBacklogBytes && !this.backlogWarningActive) {
      this.backlogWarningActive = true;
      this.stats.backlogWarnings++;
      console.warn(`[pacer ${this.label}] backlog`, { queuedMs: this.queuedMs, trimBacklog: this.trimBacklog });
    }
    if (this.trimBacklog && this.queuedBytes > this.maxBacklogBytes) {
      const count = Math.max(0, this.queuedFrames - this.targetBacklogFrames);
      this.head += count;
      this.stats.backlogTrims++;
      this.stats.droppedFrames += count;
      this.stats.droppedMs += count * 20;
      this.queuedAt = now;
      this._compactFrames();
      console.warn(`[pacer ${this.label}] SPEECH DISCARDED`, { droppedMs: count * 20, remainingMs: this.queuedMs });
    }
    if (this.queuedBytes < this.warnBacklogBytes) this.backlogWarningActive = false;
  }

  _compactFrames() {
    if (this.head && (this.head >= 1024 || this.head >= this.frames.length / 2)) {
      this.frames = this.frames.slice(this.head);
      this.head = 0;
    }
  }
  flush() {
    this.frames = [];
    this.head = 0;
    this.partial = Buffer.alloc(0);
    this.draining = false;
    this.silenceRun = 0;
    this.queuedAt = null;
    this.lastPushAt = null;
    this.committed = false;
    this.backlogWarningActive = false;
  }
  _write(frame) {
    if ((this.sock?.writableLength || this.sock?.bufferedAmount || 0) > 16000 * 5) {
      if (this.onFailure) this.onFailure('Playback transport buffer exceeded five seconds');
      else this.stop();
      return;
    }
    if (this.sock && !this.sock.destroyed && this.sock.writable)
      this.sock.write(this.encodeFrame(frame));
  }
  _writeSilence() {
    if (!this.sendSilence) return;
    this.stats.silenceFrames++;
    this._write(SILENCE_FRAME);
  }
  _report(now, event) {
    console.log(`[pacer ${this.label}] ${event}`, { ...this.stats,
      queuedMs: this.queuedMs, elapsedMs: this.startedAt === null ? null : now - this.startedAt });
  }
  _tick({ audioOnly = false } = {}) {
    const now = this.now();
    if (this.lastTickAt !== null) {
      const gap = Math.max(0, now - this.lastTickAt);
      this.stats.maxTickGapMs = Math.max(this.stats.maxTickGapMs, gap);
      if (gap > 40) this.stats.delayedTicks++;
      // Sampled blocked duration, not an exact XOFF event timestamp.
      if (this.wasBlocked) this.stats.observedBlockedMs += gap;
    }
    this.lastTickAt = now;
    this.wasBlocked = this.sock?.writable === false;
    if (this.logIntervalMs && this.lastLogAt !== null && now - this.lastLogAt >= this.logIntervalMs) {
      this._report(now, 'playback sample');
      this.lastLogAt = now;
    }
    if (this.sock?.destroyed) return 'closed';
    if (this.wasBlocked) return 'blocked';
    const tailReady = this.committed || now - this.lastPushAt >= this.maxWaitMs;
    // Recovery must never emit silence or consume a tail before commit/timeout.
    if (audioOnly && (!this.draining || (!this.queuedFrames && !(this.partial.length && tailReady))))
      return 'silence';
    if (!this.draining) {
      if (!this.queuedBytes) { this._writeSilence(); return 'silence'; }
      const waited = now - this.queuedAt;
      if (!this.committed && this.queuedBytes < this.prebufferBytes && waited < this.maxWaitMs) {
        this._writeSilence(); return 'silence';
      }
      this.stats.maxStartWaitMs = Math.max(this.stats.maxStartWaitMs, waited);
      this.draining = true;
      this.silenceRun = 0;
    }
    let frame;
    if (this.queuedFrames) {
      frame = this.frames[this.head++];
      this._compactFrames();
    } else if (this.partial.length && tailReady) {
      frame = Buffer.alloc(BYTES_PER_FRAME);
      this.partial.copy(frame);
      this.partial = Buffer.alloc(0);
    }
    if (frame) {
      if (!this.queuedBytes) { this.queuedAt = null; this.committed = false; }
      if (this.queuedBytes < this.warnBacklogBytes) this.backlogWarningActive = false;
      this.silenceRun = 0;
      this.stats.audioFrames++;
      this.stats.submittedAudioMs += 20;
      this._write(frame);
      return 'audio';
    } else {
      this.silenceRun += 20;
      if (this.silenceRun > this.endGapMs) this.draining = false;
      this._writeSilence();
      return 'silence';
    }
  }
  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextTickAt = null;
    this._report(this.now(), 'playback stats');
    this.lastTickAt = null;
    this.flush();
  }
}
