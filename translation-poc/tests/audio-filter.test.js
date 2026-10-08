import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingDownsampler } from '../bridge/audio.js';
const tone = (hz, samples = 24000) => Int16Array.from({ length: samples }, (_, i) => Math.round(12000 * Math.sin(2 * Math.PI * hz * i / 24000)));
const rms = a => Math.sqrt(a.reduce((sum, x) => sum + x * x, 0) / a.length);
test('telephone downsampling preserves speech-band gain and suppresses aliased out-of-band energy', () => {
  const pass = new StreamingDownsampler().process(tone(1000)).subarray(100);
  const reject = new StreamingDownsampler().process(tone(6000)).subarray(100);
  assert.ok(rms(pass) > 8000 && rms(pass) < 9000);
  assert.ok(rms(reject) < 100, `6kHz RMS ${rms(reject)} must be below -38dB`);
});
test('filter history and phase preserve output exactly across irregular and one-sample chunks', () => {
  const input = tone(2300, 2401);
  const expected = new StreamingDownsampler().process(input);
  const filter = new StreamingDownsampler(); const parts = [];
  let i = 0;
  for (const size of [1, 1, 13, 320, 7, 2, 480, 1, 1, 31]) {
    parts.push(...filter.process(input.subarray(i, i + size))); i += size;
  }
  parts.push(...filter.process(input.subarray(i)));
  assert.deepEqual(Int16Array.from(parts), expected);
  assert.equal(expected.length, Math.ceil(input.length / 3));
  filter.reset(); assert.deepEqual(filter.process(input), expected);
  assert.equal(filter.process(new Int16Array()).length, 0);
});
