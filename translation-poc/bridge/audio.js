// Pure DSP + serialization helpers. No side effects.
// AudioSocket carries raw SLIN PCM, so there is NO G.711/mu-law code here.

// Integer downsampling uses a low-pass filter; upsampling uses linear interpolation.
export function resample(int16, inRate, outRate) {
  if (!int16.length || inRate === outRate) return int16;
  if (inRate > outRate && Number.isInteger(inRate / outRate)) return new StreamingDownsampler(inRate, outRate).process(int16);
  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.round(int16.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, int16.length - 1);
    const frac = pos - i0;
    out[i] = (int16[i0] * (1 - frac) + int16[i1] * frac) | 0;
  }
  return out;
}

export function pcm8kTo16k(int16) { return resample(int16, 8000, 16000); }
export function pcm24kTo8k(int16) { return resample(int16, 24000, 8000); }
export function pcm16kTo8k(int16) { return resample(int16, 16000, 8000); }

// Int16Array <-> base64 (browser WS transport). Always little-endian on the wire.
export function int16ToB64(i16) {
  return Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString('base64');
}

export function b64ToInt16(b64) {
  const buf = Buffer.from(b64, 'base64');
  return bufToInt16(buf);
}

// AudioSocket payload is signed 16-bit LITTLE-ENDIAN (x86/arm hosts are LE, so a typed-array
// view is correct). Zero-copy view when the buffer is 2-byte aligned; fall back to the safe
// per-sample copy on the rare odd byteOffset (pooled Buffer slices). Result is consumed
// synchronously by the resampler, so sharing memory with the source Buffer is safe.
export function bufToInt16(buf) {
  if ((buf.byteOffset & 1) === 0) {
    return new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
  }
  const n = buf.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

// Zero-copy view over the Int16Array's bytes (host is LE). Caller passes a fresh array
// (resampler output), so the returned Buffer never outlives a mutation of its source.
export function int16ToBuf(i16) {
  return Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength);
}

// Stateful low-pass FIR decimator. History and phase belong to one direction.
// 63 taps add 31 input samples of delay (~1.3ms at 24kHz), independent of chunk sizes.
export class StreamingDownsampler {
  constructor(inRate = 24000, outRate = 8000) {
    this.factor = inRate / outRate;
    if (!Number.isInteger(this.factor) || this.factor < 2) throw new Error('Downsampling requires an integer rate ratio >= 2');
    const count = 63, middle = (count - 1) / 2, cutoff = 0.45 / this.factor;
    this.taps = Float64Array.from({ length: count }, (_, i) => {
      const x = i - middle;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      return sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (count - 1)));
    });
    const sum = this.taps.reduce((a, b) => a + b, 0);
    this.taps = this.taps.map(x => x / sum);
    this.reset();
  }
  reset() { this.history = new Int16Array(this.taps.length); this.position = 0; this.phase = 0; }
  process(input) {
    const output = [];
    for (const value of input) {
      this.history[this.position] = value;
      if (this.phase === 0) {
        let sample = 0;
        for (let j = 0; j < this.taps.length; j++)
          sample += this.taps[j] * this.history[(this.position - j + this.taps.length) % this.taps.length];
        output.push(Math.max(-32768, Math.min(32767, Math.round(sample))));
      }
      this.position = (this.position + 1) % this.taps.length;
      this.phase = (this.phase + 1) % this.factor;
    }
    return Int16Array.from(output);
  }
}
