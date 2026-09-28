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

export class OutputPacer {
  constructor(sock, { now = () => performance.now(), prebufferMs = PREBUFFER_MS,
    maxWaitMs = MAX_WAIT_MS, endGapMs = END_GAP_MS,
    encodeFrame = buildAudioFrame, sendSilence = true } = {}) {
    this.sock = sock;
    this.encodeFrame = encodeFrame;
    this.sendSilence = sendSilence;
    this.now = now;
    this.prebufferBytes = Math.ceil(prebufferMs / 20) * BYTES_PER_FRAME;
    this.maxWaitMs = maxWaitMs;
    this.endGapMs = endGapMs;
    this.timer = null;
    this.stats = { audioFrames: 0, silenceFrames: 0, maxQueueMs: 0, maxStartWaitMs: 0 };
    this.flush();
  }

  commit() { this.committed = this.queue.length > 0; }

  start() {
    if (!this.timer) this.timer = setInterval(() => this._tick(), 20);
  }

  push(buf) {
    if (!buf.length) return;
    const now = this.now();
    if (!this.queue.length) this.queuedAt = now;
    this.lastPushAt = now;
    this.queue = this.queue.length ? Buffer.concat([this.queue, buf]) : buf;
    this.stats.maxQueueMs = Math.max(this.stats.maxQueueMs, this.queue.length / 16);
  }

  flush() {
    this.queue = Buffer.alloc(0);
    this.draining = false;
    this.silenceRun = 0;
    this.queuedAt = null;
    this.lastPushAt = null;
    this.committed = false;
  }

  _write(frame) {
    if (this.sock && !this.sock.destroyed && this.sock.writable)
      this.sock.write(this.encodeFrame(frame));
  }

  _writeSilence() {
    if (!this.sendSilence) return;
    this.stats.silenceFrames++;
    this._write(SILENCE_FRAME);
  }

  _tick() {
    // Native WebSocket MEDIA_XOFF pauses consumption as well as writes.
    if (this.sock?.writable === false || this.sock?.destroyed) return;
    const now = this.now();
    if (!this.draining) {
      // Asterisk closes an AudioSocket call after two seconds without incoming
      // frames. Keep the socket active while translation is starting or idle.
      if (!this.queue.length) { this._writeSilence(); return; }
      const waited = now - this.queuedAt;
      if (!this.committed && this.queue.length < this.prebufferBytes && waited < this.maxWaitMs) {
        this._writeSilence();
        return;
      }
      this.stats.maxStartWaitMs = Math.max(this.stats.maxStartWaitMs, waited);
      this.draining = true;
      this.silenceRun = 0;
    }
    // A partial final frame must not wait forever, even without a model turn-end.
    const tailReady = this.committed || now - this.lastPushAt >= this.maxWaitMs;
    if (this.queue.length >= BYTES_PER_FRAME || (this.queue.length && tailReady)) {
      const count = Math.min(this.queue.length, BYTES_PER_FRAME);
      let frame = this.queue.subarray(0, count);
      if (count < BYTES_PER_FRAME) {
        frame = Buffer.alloc(BYTES_PER_FRAME);
        this.queue.copy(frame);
      }
      this.queue = this.queue.subarray(count);
      if (!this.queue.length) { this.queuedAt = null; this.committed = false; }
      this.silenceRun = 0;
      this.stats.audioFrames++;
      this._write(frame);
    } else {
      this.silenceRun += 20;
      if (this.silenceRun > this.endGapMs) this.draining = false;
      this._writeSilence();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    console.log('[pacer] playback stats', this.stats);
    this.flush();
  }
}
