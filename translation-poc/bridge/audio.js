// Pure DSP + serialization helpers. No side effects.
// AudioSocket carries raw SLIN PCM, so there is NO G.711/mu-law code here.

// Linear-interpolation resampler. Fast-path when rates match.
export function resample(int16, inRate, outRate) {
  if (inRate === outRate) return int16;
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

// AudioSocket payload is signed 16-bit LITTLE-ENDIAN. Convert explicitly so this is
// correct regardless of host endianness and Buffer byte-offset alignment.
export function bufToInt16(buf) {
  const n = buf.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

export function int16ToBuf(i16) {
  const buf = Buffer.allocUnsafe(i16.length * 2);
  for (let i = 0; i < i16.length; i++) buf.writeInt16LE(i16[i], i * 2);
  return buf;
}
