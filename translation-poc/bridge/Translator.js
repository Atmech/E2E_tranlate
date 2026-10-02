// Wraps ONE Gemini Live session for ONE direction of translation.
// Two instances per call (hi->en, en->hi). Never share a session across directions.
import { GoogleGenAI, Modality } from '@google/genai';
import { int16ToB64 } from './audio.js';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.5-live-translate-preview';
// Live Translate can leave final words pending despite audioStreamEnd. Advance its
// continuous input with 2s of synthetic silence, in real time, before ending input.
const INPUT_TAIL_CHUNKS = 20;
const INPUT_TAIL_MS = 100;
const INPUT_SILENCE = new Int16Array(1600); // 100ms at 16kHz; never microphone audio

// Chunk sent to Gemini. 1600 = 100ms (old default) added up to 100ms of buffering before
// audio even reached the model. The Live API accepts smaller chunks; 320 = 20ms (1:1 with
// the AudioSocket frame) cuts that buffering to ~20ms. If turn detection gets flaky on
// dialectal/phone audio, bump GEMINI_CHUNK_SAMPLES to 640 (40ms).
const CHUNK_SAMPLES = Number(process.env.GEMINI_CHUNK_SAMPLES || 320);

if (!Number.isInteger(CHUNK_SAMPLES) || CHUNK_SAMPLES < 1 || CHUNK_SAMPLES > 16000)
  throw new Error('GEMINI_CHUNK_SAMPLES must be an integer between 1 and 16000');
let ai; // Create only when starting translation; offline transport tests need no key.

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
  constructor(targetLang, { sourceLang, onAudio, onInputText, onOutputText, onTurnEnd, onFailure } = {}) {
    this.targetLang = targetLang;
    this.sourceLang = sourceLang || null;
    this.onAudio = onAudio || (() => {});
    this.onInputText = onInputText || (() => {});
    this.onOutputText = onOutputText || (() => {});
    this.onTurnEnd = onTurnEnd || (() => {});
    this.onFailure = onFailure || (() => {});
    this.session = null;
    this.pending = new Int16Array(0);
    this.closed = false;
    this.firstInputAt = null;
    this.firstOutputLogged = false;
    this.inputTailTimer = null;
    this.inputOpen = false;
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
    if (this.closed) return;
    ai ||= new GoogleGenAI({ apiKey: API_KEY });
    const started = performance.now();
    const session = await ai.live.connect({
      model: MODEL,
      config: this._config(),
      callbacks: {
        onopen: () => console.log(`[translator ${this.targetLang}] open`),
        onmessage: (m) => this._onMessage(m),
        onerror: (e) => {
          console.error(`[translator ${this.targetLang}] error:`, e?.message || e);
          if (!this.closed) this.onFailure(e);
        },
        onclose: (e) => {
          this._cancelInputTail();
          this.session = null;
          console.log(`[translator ${this.targetLang}] close`, e?.reason || '');
          if (!this.closed) this.onFailure(new Error('Translation connection closed'));
        },
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
    if (this.closed || !this.session || !int16_16k.length) return;
    this.beginInput();
    this.inputOpen = true;
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

  // Cancel a previous release tail before a new PTT press or new real input.
  beginInput() {
    // If a quick press has no audio, its release must still finish the old tail.
    if (this.inputTailTimer !== null) this.inputOpen = true;
    this._cancelInputTail();
  }

  _cancelInputTail() {
    if (this.inputTailTimer !== null) clearInterval(this.inputTailTimer);
    this.inputTailTimer = null;
  }

  endInput() {
    if (this.closed || !this.session || !this.inputOpen) return;
    this.inputOpen = false;
    if (this.pending.length) {
      this.session.sendRealtimeInput({ audio: {
        data: int16ToB64(this.pending), mimeType: 'audio/pcm;rate=16000',
      } });
      this.pending = new Int16Array(0);
    }
    if (!MODEL.includes('translate')) {
      this.session.sendRealtimeInput({ audioStreamEnd: true });
      return;
    }
    let remaining = INPUT_TAIL_CHUNKS;
    this.inputTailTimer = setInterval(() => {
      if (this.closed || !this.session) { this._cancelInputTail(); return; }
      try {
        this.session.sendRealtimeInput({ audio: {
          data: int16ToB64(INPUT_SILENCE), mimeType: 'audio/pcm;rate=16000',
        } });
        if (--remaining === 0) {
          this._cancelInputTail();
          this.session.sendRealtimeInput({ audioStreamEnd: true });
        }
      } catch (e) {
        this._cancelInputTail();
        console.error(`[translator ${this.targetLang}] input tail failed:`, e?.message || e);
        if (!this.closed) this.onFailure(e);
      }
    }, INPUT_TAIL_MS);
  }

  close() {
    this._cancelInputTail();
    this.closed = true;
    this.pending = new Int16Array(0);
    try { this.session?.close(); } catch { /* ignore */ }
    this.session = null;
  }
}
