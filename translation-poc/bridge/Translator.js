// Wraps ONE logical Gemini Live session across connection rotations per direction.
// Two instances per call (for example hi->en and en->hi). Never share a Translator
// instance across call directions.
import { GoogleGenAI, Modality } from '@google/genai';
import { int16ToB64 } from './audio.js';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.5-live-translate-preview';

// Live Translate can leave final words pending despite audioStreamEnd. Advance its
// continuous input with 2s of synthetic silence, in real time, before ending input.
const INPUT_TAIL_CHUNKS = 20;
const INPUT_TAIL_MS = 100;
const INPUT_SILENCE = new Int16Array(1600); // 100ms at 16kHz; never microphone audio.

// Chunk sent to Gemini. 320 samples = 20ms at 16kHz mono PCM.
const CHUNK_SAMPLES = Number(process.env.GEMINI_CHUNK_SAMPLES || 320);
if (!Number.isInteger(CHUNK_SAMPLES) || CHUNK_SAMPLES < 1 || CHUNK_SAMPLES > 16000) {
  throw new Error('GEMINI_CHUNK_SAMPLES must be an integer between 1 and 16000');
}

// 16kHz * 2 bytes/sample = 32 bytes/ms.
const INPUT_BYTES_PER_MS = 32;

const RECONNECT_BUFFER_SECONDS = Number(process.env.GEMINI_RECONNECT_BUFFER_SECONDS || 10);
if (!Number.isFinite(RECONNECT_BUFFER_SECONDS) || RECONNECT_BUFFER_SECONDS < 1 || RECONNECT_BUFFER_SECONDS > 60) {
  throw new Error('GEMINI_RECONNECT_BUFFER_SECONDS must be between 1 and 60');
}
const RECONNECT_BUFFER_BYTES = 16000 * 2 * RECONNECT_BUFFER_SECONDS;

const MAX_OUTBOX_MESSAGES = Number(process.env.GEMINI_RECONNECT_MAX_MESSAGES || 1000);
if (!Number.isInteger(MAX_OUTBOX_MESSAGES) || MAX_OUTBOX_MESSAGES < 100 || MAX_OUTBOX_MESSAGES > 10000) {
  throw new Error('GEMINI_RECONNECT_MAX_MESSAGES must be an integer between 100 and 10000');
}

const CONNECT_TIMEOUT_MS = Number(process.env.GEMINI_CONNECT_TIMEOUT_MS || 5000);
if (!Number.isInteger(CONNECT_TIMEOUT_MS) || CONNECT_TIMEOUT_MS < 1 || CONNECT_TIMEOUT_MS > 60000) {
  throw new Error('GEMINI_CONNECT_TIMEOUT_MS must be an integer between 1 and 60000');
}
const RESUME_ATTEMPTS = Number(process.env.GEMINI_RESUME_ATTEMPTS || 3);
if (!Number.isInteger(RESUME_ATTEMPTS) || RESUME_ATTEMPTS < 0 || RESUME_ATTEMPTS > 10) {
  throw new Error('GEMINI_RESUME_ATTEMPTS must be an integer between 0 and 10');
}

// IMPORTANT: queued audio must drain faster than real time after a reconnect.
// If it drains at exactly 1x while new 1x audio continues to arrive, the queue never
// catches up and timer/event-loop overhead makes it grow until the reconnect buffer fails.
const CATCHUP_FACTOR_LOW = Number(process.env.GEMINI_CATCHUP_FACTOR_LOW || 1.5);
const CATCHUP_FACTOR_MEDIUM = Number(process.env.GEMINI_CATCHUP_FACTOR_MEDIUM || 2.0);
const CATCHUP_FACTOR_HIGH = Number(process.env.GEMINI_CATCHUP_FACTOR_HIGH || 4.0);
const CATCHUP_MEDIUM_MS = Number(process.env.GEMINI_CATCHUP_MEDIUM_MS || 500);
const CATCHUP_HIGH_MS = Number(process.env.GEMINI_CATCHUP_HIGH_MS || 2000);
const MIN_DRAIN_DELAY_MS = Number(process.env.GEMINI_MIN_DRAIN_DELAY_MS || 2);

for (const [name, value] of Object.entries({
  GEMINI_CATCHUP_FACTOR_LOW: CATCHUP_FACTOR_LOW,
  GEMINI_CATCHUP_FACTOR_MEDIUM: CATCHUP_FACTOR_MEDIUM,
  GEMINI_CATCHUP_FACTOR_HIGH: CATCHUP_FACTOR_HIGH,
})) {
  if (!Number.isFinite(value) || value <= 1 || value > 10) {
    throw new Error(`${name} must be > 1 and <= 10`);
  }
}

if (!(CATCHUP_FACTOR_LOW <= CATCHUP_FACTOR_MEDIUM && CATCHUP_FACTOR_MEDIUM <= CATCHUP_FACTOR_HIGH)) {
  throw new Error('Catch-up factors must satisfy LOW <= MEDIUM <= HIGH');
}


for (const [name, value] of Object.entries({
  GEMINI_CATCHUP_MEDIUM_MS: CATCHUP_MEDIUM_MS,
  GEMINI_CATCHUP_HIGH_MS: CATCHUP_HIGH_MS,
})) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite`);
}
if (CATCHUP_MEDIUM_MS >= CATCHUP_HIGH_MS) {
  throw new Error('Catch-up thresholds must satisfy MEDIUM < HIGH');
}
// Node timers have a 1ms floor. Reject configurations that cannot drain full
// input chunks faster than they arrive, even with an empty event loop.
if (!Number.isFinite(MIN_DRAIN_DELAY_MS) || MIN_DRAIN_DELAY_MS < 1 ||
    MIN_DRAIN_DELAY_MS >= CHUNK_SAMPLES / 16) {
  throw new Error('GEMINI_MIN_DRAIN_DELAY_MS must be >= 1 and less than the input chunk duration in milliseconds');
}

let ai; // Create only when starting translation; offline transport tests need no key.

// BCP-47 code -> human name, so the systemInstruction prompt is unambiguous about the
// SOURCE language when using a general Live model.
const LANG_NAMES = {
  en: 'English', hi: 'Hindi', ar: 'Arabic', es: 'Spanish', fr: 'French', de: 'German',
  pt: 'Portuguese', ru: 'Russian', it: 'Italian', zh: 'Chinese', ja: 'Japanese',
  ko: 'Korean', tr: 'Turkish', ur: 'Urdu', bn: 'Bengali',
};
const langName = code => LANG_NAMES[code] || code;

const errorDetails = error => ({
  name: error?.name,
  message: error?.message || String(error),
  code: error?.code,
  status: error?.status,
  details: error?.details,
  cause: error?.cause?.message || error?.cause,
  stack: error?.stack,
  wasClean: error?.wasClean,
});

// Normalize SDK errors without losing transport diagnostics.
function transportError(value, fallback) {
  const error = new Error(value?.message || value?.reason || fallback);
  for (const key of ['name', 'code', 'status', 'details', 'cause', 'stack', 'wasClean']) {
    if (value?.[key] !== undefined) error[key] = value[key];
  }
  return error;
}

export class Translator {
  // Callbacks:
  //   onAudio(Int16Array@24k)
  //   onInputText(str)
  //   onOutputText(str)
  //   onTurnEnd()
  //   onFailure(error)
  //
  // Optional logging context (backward-compatible):
  //   callId:    Asterisk linkedid / call id
  //   direction: e.g. "caller->agent"
  constructor(targetLang, {
    sourceLang,
    onAudio,
    onInputText,
    onOutputText,
    onTurnEnd,
    onFailure,
    callId,
    direction,
  } = {}) {
    this.targetLang = targetLang;
    this.sourceLang = sourceLang || null;
    this.onAudio = onAudio || (() => {});
    this.onInputText = onInputText || (() => {});
    this.onOutputText = onOutputText || (() => {});
    this.onTurnEnd = onTurnEnd || (() => {});
    this.onFailure = onFailure || (() => {});

    this.callId = callId || null;
    this.direction = direction || null;

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

    // Diagnostics for long-running / multi-call testing.
    this.reconnectCount = 0;
    this.reconnectStartedAt = null;
    this.catchupStartedAt = null;
    this.maxOutboxBytes = 0;
    this.maxOutboxMessages = 0;
    this.maxOutboxMs = 0;
  }

  _tag() {
    if (this.callId || this.direction) {
      const call = this.callId ? ` ${this.callId}` : '';
      const direction = this.direction ? ` ${this.direction}` : '';
      const langs = ` ${this.sourceLang || '?'}->${this.targetLang}`;
      return `[translator${call}${direction}${langs}]`;
    }
    return `[translator ${this.targetLang}]`;
  }

  _queuedMs() {
    return this.outboxBytes / INPUT_BYTES_PER_MS;
  }

  _recordOutboxHighWater() {
    const queuedMs = this._queuedMs();
    this.maxOutboxBytes = Math.max(this.maxOutboxBytes, this.outboxBytes);
    this.maxOutboxMessages = Math.max(this.maxOutboxMessages, this.outbox.length);
    this.maxOutboxMs = Math.max(this.maxOutboxMs, queuedMs);
    if (this.outbox.length && this.catchupStartedAt === null) {
      this.catchupStartedAt = performance.now();
    }
  }

  _catchupFactor(queuedMs = this._queuedMs()) {
    if (queuedMs >= CATCHUP_HIGH_MS) return CATCHUP_FACTOR_HIGH;
    if (queuedMs >= CATCHUP_MEDIUM_MS) return CATCHUP_FACTOR_MEDIUM;
    // Always >1 while an outbox exists. This is what lets the queue reach zero.
    return CATCHUP_FACTOR_LOW;
  }

  _drainDelayMs(itemBytes) {
    if (!itemBytes) return MIN_DRAIN_DELAY_MS;
    const audioDurationMs = itemBytes / INPUT_BYTES_PER_MS;
    const factor = this._catchupFactor();
    return Math.max(MIN_DRAIN_DELAY_MS, audioDurationMs / factor);
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
      config.translationConfig = {
        targetLanguageCode: this.targetLang,
        echoTargetLanguage: false,
      };
    } else {
      const from = this.sourceLang ? `from ${langName(this.sourceLang)} ` : '';
      config.systemInstruction = {
        parts: [{
          text: `You are a simultaneous interpreter. The speaker talks ${from}and you translate every utterance into ${langName(this.targetLang)}. Speak only the ${langName(this.targetLang)} translation — no commentary, no repetition of the source, never switch to any other language.`,
        }],
      };
    }

    return config;
  }

  async start() {
    if (this.closed || this.started) return;
    this.started = true;

    if (!API_KEY) {
      const error = new Error('GEMINI_API_KEY is not set');
      this._fail(error);
      throw error;
    }

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

    let accept;
    let reject;
    const ready = new Promise((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });

    connection.cancel = reject;

    const current = () => (
      !this.closed &&
      !this.failureRaised &&
      this.connection === connection
    );

    const failed = error => {
      if (!current() || connection.failed) return;
      connection.failed = true;
      reject(error);

      // Once active, a GoAway/socket error/close is recoverable.
      if (connection.active) this._recover(error);
    };

    const timer = setTimeout(
      () => failed(new Error('Gemini setup timed out')),
      CONNECT_TIMEOUT_MS,
    );

    try {
      // SDK connect resolves after sending setup, not necessarily after server acceptance.
      const opening = ai.live.connect({
        model: MODEL,
        config: this._config(handle),
        callbacks: {
          onopen: () => {},
          onmessage: message => {
            if (!current() || connection.failed) return;

            if (message.setupComplete) accept();
            this._onMessage(message);

            if (message.goAway) {
              failed(new Error(`GoAway timeLeft=${message.goAway.timeLeft ?? 'unknown'}`));
            }
          },
          onerror: error => failed(transportError(error, 'Gemini socket error')),
          onclose: event => failed(transportError(event, 'Gemini connection closed')),
        },
      }).then(session => {
        connection.session = session;

        // If this connection lost ownership while connect() was resolving, close it.
        if (!current() || connection.failed) {
          try { session.close(); } catch { /* already closed */ }
        }

        return session;
      });

      const [session] = await Promise.all([opening, ready]);

      if (!current() || connection.failed) {
        throw new Error('Gemini connection cancelled');
      }

      connection.active = true;
      this.session = session;

      console.log(
        `${this._tag()} ready resumed=${Boolean(handle)} ` +
        `setupMs=${Math.round(performance.now() - started)} ` +
        `queuedMs=${Math.round(this._queuedMs())}`,
      );
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

    try {
      connection.cancel?.(new Error('Gemini connection cancelled'));
    } catch {
      // Promise reject is harmless if already settled.
    }

    try {
      connection.session?.close();
    } catch {
      // Already closed.
    }
  }

  _recover(reason) {
    if (this.closed || this.failureRaised || this.recovery) return;

    const recoveryError = reason instanceof Error
      ? reason
      : new Error(String(reason || 'Gemini connection failure'));

    this.reconnectCount += 1;
    this.reconnectStartedAt = performance.now();

    console.warn(
      `${this._tag()} reconnecting #${this.reconnectCount}: ${recoveryError.message} ` +
      `queuedMs=${Math.round(this._queuedMs())} ` +
      `outboxMessages=${this.outbox.length}`,
      errorDetails(recoveryError),
    );

    this._stopDrain();
    this._disposeConnection();

    // Assign the recovery owner before connect can synchronously invoke callbacks.
    this.recovery = Promise.resolve().then(async () => {
      let lastError = recoveryError;
      const attempts = this.resumeHandle ? RESUME_ATTEMPTS : 0;

      for (let attempt = 0; attempt <= attempts; attempt++) {
        if (this.closed || this.failureRaised) return;

        const fresh = attempt === attempts;
        const handle = fresh ? null : this.resumeHandle;

        if (fresh) {
          this.resumeHandle = null;
          console.warn(
            `${this._tag()} fresh-session fallback; translation context resets ` +
            `queuedMs=${Math.round(this._queuedMs())}`,
          );
        }

        try {
          await this._connect(handle);

          if (this.closed) return;
          if (!this.session || this.connection?.failed) {
            throw new Error('Gemini closed during recovery');
          }

          // Include the first buffered write in the retry budget. A connection that accepts
          // setup but immediately rejects media should count as a failed recovery attempt.
          if (this.outbox.length) this._sendQueued();

          const recoveryMs = this.reconnectStartedAt === null
            ? 0
            : Math.round(performance.now() - this.reconnectStartedAt);

          console.log(
            `${this._tag()} recovery connected ` +
            `recoveryMs=${recoveryMs} queuedMs=${Math.round(this._queuedMs())} ` +
            `outboxMessages=${this.outbox.length}`,
          );

          return;
        } catch (error) {
          this._stopDrain();
          this._disposeConnection();
          lastError = error;

          console.warn(
            `${this._tag()} reconnect attempt ${attempt + 1}/${attempts + 1} failed: ` +
            `${error?.message || error}`,
            errorDetails(error),
          );
        }
      }

      throw lastError;
    }).catch(error => {
      this._fail(error);
    }).finally(() => {
      this.recovery = null;
      this.reconnectStartedAt = null;

      if (!this.closed && !this.failureRaised) {
        // A close/GoAway can arrive after setup but before this recovery owner releases.
        if (!this.session || this.connection?.failed) {
          this._recover(new Error('Gemini closed during recovery'));
        } else {
          this._drain();
        }
      }
    });
  }

  _fail(error) {
    if (this.closed || this.failureRaised) return;

    // Log BEFORE close(), because close() intentionally clears the outbox.
    console.error(`${this._tag()} FATAL`, {
      ...errorDetails(error),
      reconnectCount: this.reconnectCount,
      recovering: Boolean(this.recovery),
      hasSession: Boolean(this.session),
      hasResumeHandle: Boolean(this.resumeHandle),
      outboxMessages: this.outbox.length,
      outboxBytes: this.outboxBytes,
      outboxMs: Math.round(this._queuedMs()),
      maxOutboxMessages: this.maxOutboxMessages,
      maxOutboxBytes: this.maxOutboxBytes,
      maxOutboxMs: Math.round(this.maxOutboxMs),
    });

    this.failureRaised = true;
    this.close();

    try {
      this.onFailure(error);
    } catch (callbackError) {
      console.error(`${this._tag()} onFailure callback threw`, errorDetails(callbackError));
    }
  }

  _stopDrain() {
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  _enqueue(payload, bytes) {
    if (
      this.outboxBytes + bytes > RECONNECT_BUFFER_BYTES ||
      this.outbox.length >= MAX_OUTBOX_MESSAGES
    ) {
      this._fail(new Error(
        `Gemini reconnect audio buffer exceeded ` +
        `${RECONNECT_BUFFER_SECONDS}s or ${MAX_OUTBOX_MESSAGES} messages`,
      ));
      return false;
    }

    this.outbox.push({ payload, bytes });
    this.outboxBytes += bytes;
    this._recordOutboxHighWater();
    return true;
  }

  _send(payload, bytes = 0) {
    if (this.closed) return;

    // Fast path: no recovery/backlog, so send current audio directly.
    if (
      this.session &&
      !this.recovery &&
      !this.outbox.length &&
      this.drainTimer === null
    ) {
      try {
        this.session.sendRealtimeInput(payload);
        return;
      } catch (error) {
        // Preserve this payload. _recover() disposes the failed socket, then the payload is
        // appended to the outbox and replayed on the replacement connection.
        this._recover(error);
      }
    }

    if (!this._enqueue(payload, bytes)) return;
    this._drain();
  }

  _drain() {
    if (
      this.closed ||
      this.recovery ||
      !this.session ||
      this.drainTimer !== null ||
      !this.outbox.length
    ) {
      return;
    }

    try {
      this._sendQueued();
    } catch (error) {
      this._recover(error);
    }
  }

  _sendQueued() {
    if (!this.session || !this.outbox.length) return;

    const item = this.outbox[0];

    // sendRealtimeInput() is synchronous at this call boundary. Only remove the item after
    // the SDK accepted the send call; if it throws, the item remains queued for recovery.
    this.session.sendRealtimeInput(item.payload);

    this.outbox.shift();
    this.outboxBytes -= item.bytes;
    if (this.outboxBytes < 0) this.outboxBytes = 0;

    // IMPORTANT: if the queue is empty, do not leave a real-time timer running. The next
    // incoming audio can go back to the direct-send fast path immediately.
    if (!this.outbox.length) {
      if (this.catchupStartedAt !== null) {
        console.log(
          `${this._tag()} reconnect backlog drained ` +
          `catchupMs=${Math.round(performance.now() - this.catchupStartedAt)} ` +
          `maxQueuedMs=${Math.round(this.maxOutboxMs)}`,
        );
      }
      this.catchupStartedAt = null;
      this.drainTimer = null;
      return;
    }

    // Drain faster than real time until the queue reaches zero. This prevents the reconnect
    // backlog from becoming permanent while new real-time audio is still arriving.
    const delayMs = this._drainDelayMs(item.bytes);

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this._drain();
    }, delayMs);
  }

  _onMessage(m) {
    if (this.closed) return;

    const update = m.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) {
      this.resumeHandle = update.newHandle;
    }

    const sc = m.serverContent;
    if (!sc) return;

    if (sc.inputTranscription?.text) {
      this.onInputText(sc.inputTranscription.text);
    }

    if (sc.outputTranscription?.text) {
      this.onOutputText(sc.outputTranscription.text);
    }

    const parts = sc.modelTurn?.parts || [];

    for (const part of parts) {
      const data = part.inlineData?.data;
      if (!data) continue;

      // Gemini audio out = PCM 16-bit LE 24kHz. Buffer.from(base64) creates a fresh,
      // 2-byte-aligned allocation; Int16Array is then a zero-copy view over that Buffer.
      const buf = Buffer.from(data, 'base64');
      const i16 = new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);

      if (!this.firstOutputLogged && this.firstInputAt !== null) {
        console.log(
          `${this._tag()} firstInputToOutputMs=` +
          `${Math.round(performance.now() - this.firstInputAt)} ` +
          `(includes input silence/network/model; not inference-only)`,
        );
        this.firstOutputLogged = true;
      }

      this.onAudio(i16);
    }

    // End of a model turn: all audio for this utterance has been delivered.
    if (sc.turnComplete || sc.generationComplete) {
      this.onTurnEnd();
    }
  }

  // Feed 16kHz PCM in configured chunks; retain the remainder until input ends.
  feed(int16_16k) {
    if (this.closed || !this.started || !int16_16k.length) return;

    this.beginInput();
    this.inputOpen = true;

    if (this.firstInputAt === null) {
      this.firstInputAt = performance.now();
    }

    const merged = new Int16Array(this.pending.length + int16_16k.length);
    merged.set(this.pending, 0);
    merged.set(int16_16k, this.pending.length);

    let offset = 0;

    while (merged.length - offset >= CHUNK_SAMPLES) {
      const chunk = merged.subarray(offset, offset + CHUNK_SAMPLES);

      this._send({
        audio: {
          data: int16ToB64(chunk),
          mimeType: 'audio/pcm;rate=16000',
        },
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
    if (this.inputTailTimer !== null) {
      clearInterval(this.inputTailTimer);
    }
    this.inputTailTimer = null;
  }

  endInput() {
    if (this.closed || !this.inputOpen) return;

    this.inputOpen = false;

    if (this.pending.length) {
      this._send({
        audio: {
          data: int16ToB64(this.pending),
          mimeType: 'audio/pcm;rate=16000',
        },
      }, this.pending.byteLength);

      this.pending = new Int16Array(0);
    }

    if (this.closed) return;

    if (!MODEL.includes('translate')) {
      this._send({ audioStreamEnd: true });
      return;
    }

    let remaining = INPUT_TAIL_CHUNKS;

    this.inputTailTimer = setInterval(() => {
      if (this.closed) {
        this._cancelInputTail();
        return;
      }

      // Silence must advance the model in real time after buffered speech drains. Do not
      // inject tail silence while recovering or catching up, because it would compete with
      // real speech already waiting in the outbox.
      if (
        !this.session ||
        this.recovery ||
        this.outbox.length ||
        this.drainTimer !== null
      ) {
        return;
      }

      try {
        this.session.sendRealtimeInput({
          audio: {
            data: int16ToB64(INPUT_SILENCE),
            mimeType: 'audio/pcm;rate=16000',
          },
        });

        if (--remaining === 0) {
          this._cancelInputTail();
          this._send({ audioStreamEnd: true });
        }
      } catch (error) {
        console.error(`${this._tag()} input tail failed`, errorDetails(error));
        this._recover(error);
      }
    }, INPUT_TAIL_MS);
  }

  getStats() {
    return {
      closed: this.closed,
      started: this.started,
      failureRaised: this.failureRaised,
      reconnectCount: this.reconnectCount,
      recovering: Boolean(this.recovery),
      hasSession: Boolean(this.session),
      hasResumeHandle: Boolean(this.resumeHandle),
      outboxMessages: this.outbox.length,
      outboxBytes: this.outboxBytes,
      outboxMs: Math.round(this._queuedMs()),
      maxOutboxMessages: this.maxOutboxMessages,
      maxOutboxBytes: this.maxOutboxBytes,
      maxOutboxMs: Math.round(this.maxOutboxMs),
    };
  }

  close() {
    if (this.closed) return;

    this.closed = true;
    this._cancelInputTail();
    this._stopDrain();

    this.pending = new Int16Array(0);
    this.outbox = [];
    this.outboxBytes = 0;
    this.catchupStartedAt = null;
    this.reconnectStartedAt = null;
    this.resumeHandle = null;

    this._disposeConnection();
  }
}
