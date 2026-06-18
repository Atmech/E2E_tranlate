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

// Paces outbound audio to Asterisk at a steady 20ms cadence. Gemini returns audio in
// bursts; feeding bursts straight to the channel glitches playback. Accumulate 8kHz PCM
// bytes, emit exactly one 320-byte 0x10 frame per 20ms tick. Underrun -> skip the tick.
const END_GAP_MS = 100;                          // silence this long => spurt is over
const MAX_PREBUFFER_BYTES = BYTES_PER_FRAME * 10; // ~200ms safety fallback
const SILENCE_FRAME = Buffer.alloc(BYTES_PER_FRAME); // 20ms of 8kHz silence

export class OutputPacer {
  constructor(sock) {
    this.sock = sock;
    this.queue = Buffer.alloc(0);
    this.timer = null;
    this.draining = false;
    this.silenceRun = 0;
  }

  // No-op kept for call-site compatibility; no longer gates playback.
  commit() {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), 20);
  }

  // push 8kHz PCM (Buffer, 16-bit LE) to be played into the call.
  push(buf) {
    this.queue = this.queue.length ? Buffer.concat([this.queue, buf]) : buf;
    this._rxBytes = (this._rxBytes || 0) + buf.length;
    if (!this._rxStart) this._rxStart = Date.now();
  }

  // Barge-in: drop everything still queued so stale translation audio stops immediately.
  flush() {
    this.queue = Buffer.alloc(0);
    this.draining = false;
    this.silenceRun = 0;
  }

  _write(frame) {
    if (this.sock && !this.sock.destroyed && this.sock.writable) {
      this.sock.write(buildAudioFrame(frame));
    }
  }

  _tick() {
    // Drain immediately — no pre-buffer wait. Emit one 320-byte frame per 20ms tick.
    // On underrun: emit one silence frame to hold cadence; after END_GAP_MS of silence
    // treat the spurt as done and stop draining.
    if (this.queue.length >= BYTES_PER_FRAME) {
      if (!this.draining) {
        this.draining = true; this.silenceRun = 0;
        this._audioFrames = 0; this._silenceFrames = 0; this._spurtStart = Date.now();
      }
      const frame = this.queue.subarray(0, BYTES_PER_FRAME);
      this.queue = this.queue.subarray(BYTES_PER_FRAME);
      this.silenceRun = 0;
      this._audioFrames++;
      this._write(frame);
    } else if (this.draining) {
      this.silenceRun++;
      if (this.silenceRun * 20 > END_GAP_MS) {
        this.draining = false;
        this._logSpurt();
        return;
      }
      this._silenceFrames++;
      this._write(SILENCE_FRAME);
    }
  }

  _logSpurt() {
    const a = this._audioFrames || 0, s = this._silenceFrames || 0;
    if (a + s === 0) return;
    // realtime ratio = how fast Gemini delivered vs playback rate. <1 => sub-realtime (gaps unavoidable).
    const rxMs = this._rxStart ? (Date.now() - this._rxStart) : 0;
    const audioMs = a * 20;
    const ratio = rxMs ? (audioMs / rxMs).toFixed(2) : 'n/a';
    console.log(`[pacer] spurt: audio=${audioMs}ms gapFills=${s * 20}ms (${a}/${a + s} frames) rxBytes=${this._rxBytes || 0} deliveryRatio=${ratio} (>=1 good, <1 sub-realtime)`);
    this._rxBytes = 0; this._rxStart = 0;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = Buffer.alloc(0);
  }
}
