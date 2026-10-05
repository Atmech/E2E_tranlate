// Wraps ONE logical Gemini Live session across connection rotations per direction.
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
const RECONNECT_BUFFER_BYTES = 16000 * 2 * 10; // Ten seconds of 16kHz mono PCM.
const CONNECT_TIMEOUT_MS = 5000;
const RESUME_ATTEMPTS = 3;
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
    this.started = false;
    this.failureRaised = false;
    this.connection = null;
    this.recovery = null;
    this.resumeHandle = null;
    this.outbox = [];
    this.outboxBytes = 0;
    this.drainTimer = null;
  }

  _config(handle = null) {
    const isTranslate = MODEL.includes('translate');
    const config = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: handle ? { handle } : {},
      contextWindowCompression: { slidingWindow: {} },
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
    if (this.closed || this.started) return;
    this.started = true;
    ai ||= new GoogleGenAI({ apiKey: API_KEY });
    try {
      await this._connect(null);
      this._drain();
    } catch (error) {
      if (!this.closed) {
        this._fail(error);
        throw error;
      }
    }
  }

  async _connect(handle) {
    const started = performance.now();
    const connection = { session: null, active: false, failed: false };
    this.connection = connection;
    let accept, reject;
    const ready = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
    connection.cancel = reject;
    const current = () => !this.closed && !this.failureRaised && this.connection === connection;
    const failed = error => {
      if (!current() || connection.failed) return;
      connection.failed = true;
      reject(error);
      if (connection.active) this._recover(error.message);
    };
    const timer = setTimeout(() => failed(new Error('Gemini setup timed out')), CONNECT_TIMEOUT_MS);
    try {
      // SDK connect resolves after sending setup, not after server acceptance.
      const opening = ai.live.connect({
        model: MODEL,
        config: this._config(handle),
        callbacks: {
          onopen: () => {},
          onmessage: message => {
            if (!current() || connection.failed) return;
            if (message.setupComplete) accept();
            this._onMessage(message);
            if (message.goAway) failed(new Error(`GoAway timeLeft=${message.goAway.timeLeft ?? 'unknown'}`));
          },
          onerror: error => failed(new Error(error?.message || 'Gemini socket error')),
          onclose: event => failed(new Error(event?.reason || 'Gemini connection closed')),
        },
      }).then(session => {
        connection.session = session;
        if (!current() || connection.failed) {
          try { session.close(); } catch { /* already closed */ }
        }
        return session;
      });
      const [session] = await Promise.all([opening, ready]);
      if (!current() || connection.failed) throw new Error('Gemini connection cancelled');
      connection.active = true;
      this.session = session;
      console.log(`[translator ${this.targetLang}] ready resumed=${Boolean(handle)} setupMs=${Math.round(performance.now() - started)}`);
    } catch (error) {
      this._disposeConnection(connection);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  _disposeConnection(connection = this.connection) {
    if (!connection) return;
    if (this.connection === connection) {
      this.connection = null;
      this.session = null;
    }
    connection.failed = true;
    connection.cancel(new Error('Gemini connection cancelled'));
    try { connection.session?.close(); } catch { /* already closed */ }
  }

  _recover(reason) {
    if (this.closed || this.failureRaised || this.recovery) return;
    console.warn(`[translator ${this.targetLang}] reconnecting: ${reason}`);
    this._stopDrain();
    this._disposeConnection();
    // Assign the owner before connect can synchronously invoke callbacks.
    this.recovery = Promise.resolve().then(async () => {
      let lastError;
      const attempts = this.resumeHandle ? RESUME_ATTEMPTS : 0;
      for (let attempt = 0; attempt <= attempts; attempt++) {
        if (this.closed || this.failureRaised) return;
        const fresh = attempt === attempts;
        if (fresh) {
          this.resumeHandle = null;
          console.warn(`[translator ${this.targetLang}] fresh-session fallback; translation context resets`);
        }
        try {
          await this._connect(fresh ? null : this.resumeHandle);
          if (this.closed) return;
          if (!this.session || this.connection.failed) throw new Error('Gemini closed during recovery');
          // Include the first buffered send in the retry budget, so a socket that
          // repeatedly accepts setup but cannot send cannot spin forever.
          if (this.outbox.length) this._sendQueued();
          return;
        } catch (error) {
          this._stopDrain();
          this._disposeConnection();
          lastError = error;
          console.warn(`[translator ${this.targetLang}] reconnect attempt ${attempt + 1} failed: ${error.message}`);
        }
      }
      throw lastError;
    }).catch(error => this._fail(error)).finally(() => {
      this.recovery = null;
      if (!this.closed && !this.failureRaised) {
        // A close/GoAway can arrive after setup but before this owner releases.
        if (!this.session || this.connection?.failed) this._recover('closed during recovery');
        else this._drain();
      }
    });
  }

  _fail(error) {
    if (this.closed || this.failureRaised) return;
    this.failureRaised = true;
    this.close();
    this.onFailure(error);
  }

  _stopDrain() {
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  _send(payload, bytes = 0) {
    if (this.closed) return;
    if (this.session && !this.recovery && !this.outbox.length && this.drainTimer === null) {
      try { this.session.sendRealtimeInput(payload); return; }
      catch (error) { this._recover(error.message); }
    }
    // Bound control messages as well as PCM. Overflow is fatal, never silent loss.
    if (this.outboxBytes + bytes > RECONNECT_BUFFER_BYTES || this.outbox.length >= 1000) {
      this._fail(new Error('Gemini reconnect audio buffer exceeded ten seconds or 1000 messages'));
      return;
    }
    this.outbox.push({ payload, bytes });
    this.outboxBytes += bytes;
    this._drain();
  }

  _drain() {
    if (this.closed || this.recovery || !this.session || this.drainTimer !== null || !this.outbox.length) return;
    try { this._sendQueued(); }
    catch (error) { this._recover(error.message); }
  }

  _sendQueued() {
    const item = this.outbox[0];
    this.session.sendRealtimeInput(item.payload);
    this.outbox.shift();
    this.outboxBytes -= item.bytes;
    // Schedule relative to actual send time; event-loop stalls cannot create bursts.
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this._drain();
    }, Math.max(1, item.bytes / 32));
  }

  _onMessage(m) {
    if (this.closed) return;
    const update = m.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) this.resumeHandle = update.newHandle;
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
    if (this.closed || !this.started || !int16_16k.length) return;
    this.beginInput();
    this.inputOpen = true;
    if (this.firstInputAt === null) this.firstInputAt = performance.now();
    const merged = new Int16Array(this.pending.length + int16_16k.length);
    merged.set(this.pending, 0);
    merged.set(int16_16k, this.pending.length);

    let offset = 0;
    while (merged.length - offset >= CHUNK_SAMPLES) {
      const chunk = merged.subarray(offset, offset + CHUNK_SAMPLES);
      this._send({
        audio: { data: int16ToB64(chunk), mimeType: 'audio/pcm;rate=16000' },
      }, chunk.byteLength);
      if (this.closed) return;
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
    if (this.closed || !this.inputOpen) return;
    this.inputOpen = false;
    if (this.pending.length) {
      this._send({ audio: {
        data: int16ToB64(this.pending), mimeType: 'audio/pcm;rate=16000',
      } }, this.pending.byteLength);
      this.pending = new Int16Array(0);
    }
    if (this.closed) return;
    if (!MODEL.includes('translate')) {
      this._send({ audioStreamEnd: true });
      return;
    }
    let remaining = INPUT_TAIL_CHUNKS;
    this.inputTailTimer = setInterval(() => {
      if (this.closed) { this._cancelInputTail(); return; }
      // Silence must advance the model in real time after buffered speech drains.
      if (!this.session || this.recovery || this.outbox.length || this.drainTimer !== null) return;
      try {
        this.session.sendRealtimeInput({ audio: {
          data: int16ToB64(INPUT_SILENCE), mimeType: 'audio/pcm;rate=16000',
        } });
        if (--remaining === 0) {
          this._cancelInputTail();
          this._send({ audioStreamEnd: true });
        }
      } catch (e) {
        console.error(`[translator ${this.targetLang}] input tail failed:`, e?.message || e);
        this._recover(e.message);
      }
    }, INPUT_TAIL_MS);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._cancelInputTail();
    this._stopDrain();
    this.pending = new Int16Array(0);
    this.outbox = [];
    this.outboxBytes = 0;
    this.resumeHandle = null;
    this._disposeConnection();
  }
}
