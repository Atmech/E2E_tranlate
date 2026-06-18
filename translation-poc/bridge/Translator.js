// Wraps ONE Gemini Live session for ONE direction of translation.
// Two instances per call (hi->en, en->hi). Never share a session across directions.
import { GoogleGenAI, Modality } from '@google/genai';
import { int16ToB64 } from './audio.js';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.5-live-translate-preview';

// Gemini wants ~100ms chunks; 1600 samples @ 16kHz.
const CHUNK_SAMPLES = 1600;

const ai = new GoogleGenAI({ apiKey: API_KEY });

export class Translator {
  // onAudio(Int16Array@24k), onInputText(str), onOutputText(str), onTurnEnd()
  constructor(targetLang, { onAudio, onInputText, onOutputText, onTurnEnd } = {}) {
    this.targetLang = targetLang;
    this.onAudio = onAudio || (() => {});
    this.onInputText = onInputText || (() => {});
    this.onOutputText = onOutputText || (() => {});
    this.onTurnEnd = onTurnEnd || (() => {});
    this.session = null;
    this.pending = new Int16Array(0);
    this.closed = false;
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
      // Fallback model: prompt-driven translation.
      config.systemInstruction = {
        parts: [{ text: `You are a simultaneous interpreter. Translate every utterance you hear into ${this.targetLang} and speak only the translation. No commentary, no repetition of the source.` }],
      };
    }
    return config;
  }

  async start() {
    this.session = await ai.live.connect({
      model: MODEL,
      config: this._config(),
      callbacks: {
        onopen: () => console.log(`[translator ${this.targetLang}] open`),
        onmessage: (m) => this._onMessage(m),
        onerror: (e) => console.error(`[translator ${this.targetLang}] error:`, e?.message || e),
        onclose: (e) => console.log(`[translator ${this.targetLang}] close`, e?.reason || ''),
      },
    });
  }

  _onMessage(m) {
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) this.onInputText(sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this.onOutputText(sc.outputTranscription.text);
    const parts = sc.modelTurn?.parts || [];
    for (const part of parts) {
      const data = part.inlineData?.data;
      if (!data) continue;
      // Gemini audio out = PCM 16-bit LE 24kHz.
      const buf = Buffer.from(data, 'base64');
      const i16 = new Int16Array(buf.length >> 1);
      for (let i = 0; i < i16.length; i++) i16[i] = buf.readInt16LE(i * 2);
      this.onAudio(i16);
    }
    // End of a model turn: all audio for this utterance has been delivered.
    if (sc.turnComplete || sc.generationComplete) this.onTurnEnd();
  }

  // feed 16kHz PCM; flush in 100ms chunks, keep remainder.
  feed(int16_16k) {
    if (this.closed || !this.session) return;
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

  close() {
    this.closed = true;
    try { this.session?.close(); } catch { /* ignore */ }
    this.session = null;
  }
}
