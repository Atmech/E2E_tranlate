// Wraps ONE Gemini Live session for ONE direction of translation.
// Two instances per call (hi->en, en->hi). Never share a session across directions.
import { GoogleGenAI, Modality } from '@google/genai';
import { int16ToB64 } from './audio.js';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.5-live-translate-preview';

// Chunk sent to Gemini. 1600 = 100ms (old default) added up to 100ms of buffering before
// audio even reached the model. The Live API accepts smaller chunks; 320 = 20ms (1:1 with
// the AudioSocket frame) cuts that buffering to ~20ms. If turn detection gets flaky on
// dialectal/phone audio, bump GEMINI_CHUNK_SAMPLES to 640 (40ms).
const CHUNK_SAMPLES = Number(process.env.GEMINI_CHUNK_SAMPLES || 320);

if (!Number.isInteger(CHUNK_SAMPLES) || CHUNK_SAMPLES < 1 || CHUNK_SAMPLES > 16000)
  throw new Error('GEMINI_CHUNK_SAMPLES must be an integer between 1 and 16000');
const ai = new GoogleGenAI({ apiKey: API_KEY });

// BCP-47 code -> human name, so the systemInstruction prompt is unambiguous about the
// SOURCE language (the dedicated translate model auto-detects and can mis-detect dialectal
// phone audio; the general model lets us pin both directions explicitly).
const LANG_NAMES = {
  en: 'English', hi: 'Hindi', ar: 'Arabic', es: 'Spanish', fr: 'French', de: 'German',
  pt: 'Portuguese', ru: 'Russian', it: 'Italian', zh: 'Chinese', ja: 'Japanese',
  ko: 'Korean', tr: 'Turkish', ur: 'Urdu', bn: 'Bengali',
};
const langName = (code) => LANG_NAMES[code] || code;

export class Translator {
  // onAudio(Int16Array@24k), onInputText(str), onOutputText(str), onTurnEnd()
  constructor(targetLang, { sourceLang, onAudio, onInputText, onOutputText, onTurnEnd } = {}) {
    this.targetLang = targetLang;
    this.sourceLang = sourceLang || null;
    this.onAudio = onAudio || (() => {});
    this.onInputText = onInputText || (() => {});
    this.onOutputText = onOutputText || (() => {});
    this.onTurnEnd = onTurnEnd || (() => {});
    this.session = null;
    this.pending = new Int16Array(0);
    this.closed = false;
    this.firstInputAt = null;
    this.firstOutputLogged = false;
  }

  _config() {
    const isTranslate = MODEL.includes('translate');
    const config = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (isTranslate) {
      config.translationConfig = { targetLanguageCode: this.targetLang, echoTargetLanguage: false };
    } else {
      // General model: prompt-driven translation. Pin the source language when known so
      // the model doesn't mis-detect it (e.g. dialectal Arabic over 8kHz phone audio).
      const from = this.sourceLang ? `from ${langName(this.sourceLang)} ` : '';
      config.systemInstruction = {
        parts: [{ text: `You are a simultaneous interpreter. The speaker talks ${from}and you translate every utterance into ${langName(this.targetLang)}. Speak only the ${langName(this.targetLang)} translation — no commentary, no repetition of the source, never switch to any other language.` }],
      };
    }
    return config;
  }

  async start() {
    const started = performance.now();
    const session = await ai.live.connect({
      model: MODEL,
      config: this._config(),
      callbacks: {
        onopen: () => console.log(`[translator ${this.targetLang}] open`),
        onmessage: (m) => this._onMessage(m),
        onerror: (e) => console.error(`[translator ${this.targetLang}] error:`, e?.message || e),
        onclose: (e) => console.log(`[translator ${this.targetLang}] close`, e?.reason || ''),
      },
    });
    if (this.closed) { session.close(); return; }
    this.session = session;
    console.log(`[translator ${this.targetLang}] setupMs=${Math.round(performance.now() - started)}`);
  }

  _onMessage(m) {
    if (this.closed) return;
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) this.onInputText(sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this.onOutputText(sc.outputTranscription.text);
    const parts = sc.modelTurn?.parts || [];
    for (const part of parts) {
      const data = part.inlineData?.data;
      if (!data) continue;
      // Gemini audio out = PCM 16-bit LE 24kHz. Zero-copy view (Buffer.from(base64) is a
      // fresh, 2-byte-aligned allocation), consumed synchronously by onAudio — no per-sample loop.
      const buf = Buffer.from(data, 'base64');
      const i16 = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
      if (!this.firstOutputLogged && this.firstInputAt !== null) {
        console.log(`[translator ${this.targetLang}] firstInputToOutputMs=${Math.round(performance.now() - this.firstInputAt)} (includes input silence/network/model; not inference-only)`);
        this.firstOutputLogged = true;
      }
      this.onAudio(i16);
    }
    // End of a model turn: all audio for this utterance has been delivered.
    if (sc.turnComplete || sc.generationComplete) this.onTurnEnd();
  }

  // Feed 16kHz PCM in configured chunks; retain the remainder until input ends.
  feed(int16_16k) {
    if (this.closed || !this.session) return;
    if (this.firstInputAt === null) this.firstInputAt = performance.now();
    const merged = new Int16Array(this.pending.length + int16_16k.length);
    merged.set(this.pending, 0);
    merged.set(int16_16k, this.pending.length);

    let offset = 0;
    while (merged.length - offset >= CHUNK_SAMPLES) {
      const chunk = merged.subarray(offset, offset + CHUNK_SAMPLES);
      this.session.sendRealtimeInput({
        audio: { data: int16ToB64(chunk), mimeType: 'audio/pcm;rate=16000' },
      });
      offset += CHUNK_SAMPLES;
    }
    this.pending = merged.slice(offset);
  }

  endInput() {
    if (this.closed || !this.session) return;
    if (this.pending.length) {
      this.session.sendRealtimeInput({ audio: {
        data: int16ToB64(this.pending), mimeType: 'audio/pcm;rate=16000',
      } });
      this.pending = new Int16Array(0);
    }
    this.session.sendRealtimeInput({ audioStreamEnd: true });
  }

  close() {
    this.closed = true;
    this.pending = new Int16Array(0);
    try { this.session?.close(); } catch { /* ignore */ }
    this.session = null;
  }
}
