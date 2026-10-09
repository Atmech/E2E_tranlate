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

// Chunk sent to Gemini. 640 samples = 40ms at 16kHz mono PCM.
const CHUNK_SAMPLES = Number(process.env.GEMINI_CHUNK_SAMPLES || 640);
if (!Number.isInteger(CHUNK_SAMPLES) || CHUNK_SAMPLES < 1 || CHUNK_SAMPLES > 16000) {
  throw new Error('GEMINI_CHUNK_SAMPLES must be an integer between 1 and 16000');
}

// TEST-ONLY cost control. When enabled, long near-silent sections of synthetic load-test
// WAVs are discarded locally instead of being submitted to Gemini. The Gemini Live
// session itself remains connected, so concurrent-session / GoAway / resumption testing
// still exercises the real service. Keep this OFF for production/user calls.
const LOAD_TEST_SPEECH_GATE = /^(1|true|yes|on)$/i.test(
  String(process.env.LOAD_TEST_SPEECH_GATE || ''),
);
const SPEECH_GATE_THRESHOLD = Number(process.env.LOAD_TEST_SPEECH_GATE_THRESHOLD || 128);
const SPEECH_GATE_HANGOVER_MS = Number(process.env.LOAD_TEST_SPEECH_GATE_HANGOVER_MS || 600);
const SPEECH_GATE_LOG_INTERVAL_MS = Number(process.env.LOAD_TEST_SPEECH_GATE_LOG_INTERVAL_MS || 60000);

if (!Number.isInteger(SPEECH_GATE_THRESHOLD) || SPEECH_GATE_THRESHOLD < 0 || SPEECH_GATE_THRESHOLD > 32767) {
  throw new Error('LOAD_TEST_SPEECH_GATE_THRESHOLD must be an integer between 0 and 32767');
}
if (!Number.isFinite(SPEECH_GATE_HANGOVER_MS) || SPEECH_GATE_HANGOVER_MS < 0 || SPEECH_GATE_HANGOVER_MS > 5000) {
  throw new Error('LOAD_TEST_SPEECH_GATE_HANGOVER_MS must be between 0 and 5000');
}
if (!Number.isFinite(SPEECH_GATE_LOG_INTERVAL_MS) || SPEECH_GATE_LOG_INTERVAL_MS < 1000 || SPEECH_GATE_LOG_INTERVAL_MS > 3600000) {
  throw new Error('LOAD_TEST_SPEECH_GATE_LOG_INTERVAL_MS must be between 1000 and 3600000');
}
const SPEECH_GATE_HANGOVER_SAMPLES = Math.round(16000 * SPEECH_GATE_HANGOVER_MS / 1000);

// 16kHz * 2 bytes/sample = 32 bytes/ms.
const INPUT_BYTES_PER_MS = 32;

const RECONNECT_BUFFER_SECONDS = Number(process.env.GEMINI_RECONNECT_BUFFER_SECONDS || 30);
if (!Number.isFinite(RECONNECT_BUFFER_SECONDS) || RECONNECT_BUFFER_SECONDS < 1 || RECONNECT_BUFFER_SECONDS > 60) {
  throw new Error('GEMINI_RECONNECT_BUFFER_SECONDS must be between 1 and 60');
}
const RECONNECT_BUFFER_BYTES = 16000 * 2 * RECONNECT_BUFFER_SECONDS;

const MAX_OUTBOX_MESSAGES = Number(process.env.GEMINI_RECONNECT_MAX_MESSAGES || 3000);
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

// Close confirmation and retry delays share the existing recovery/audio budget.
const CLOSE_WAIT_MS = Number(process.env.GEMINI_CLOSE_WAIT_MS ?? 1000);
const RETRY_BASE_MS = Number(process.env.GEMINI_RETRY_BASE_MS ?? 500);
const RETRY_JITTER_MS = Number(process.env.GEMINI_RETRY_JITTER_MS ?? 250);
for (const [name, value] of Object.entries({ GEMINI_CLOSE_WAIT_MS: CLOSE_WAIT_MS,
  GEMINI_RETRY_BASE_MS: RETRY_BASE_MS, GEMINI_RETRY_JITTER_MS: RETRY_JITTER_MS })) {
  if (!Number.isInteger(value) || value < 0 || value > 5000)
    throw new Error(`${name} must be an integer between 0 and 5000`);
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

// Catch-up is drained in bounded bursts instead of one message per timer callback.
// This preserves the configured average catch-up factor while sharply reducing timer
// pressure when many translator directions reconnect at the same time.
const CATCHUP_BURST_TARGET_MS = Number(process.env.GEMINI_CATCHUP_BURST_TARGET_MS || 160);
const CATCHUP_BURST_MAX_MESSAGES = Number(process.env.GEMINI_CATCHUP_BURST_MAX_MESSAGES || 8);

if (!Number.isFinite(CATCHUP_BURST_TARGET_MS) ||
    CATCHUP_BURST_TARGET_MS < 20 || CATCHUP_BURST_TARGET_MS > 1000) {
  throw new Error('GEMINI_CATCHUP_BURST_TARGET_MS must be between 20 and 1000 milliseconds');
}
if (!Number.isInteger(CATCHUP_BURST_MAX_MESSAGES) ||
    CATCHUP_BURST_MAX_MESSAGES < 1 || CATCHUP_BURST_MAX_MESSAGES > 64) {
  throw new Error('GEMINI_CATCHUP_BURST_MAX_MESSAGES must be an integer between 1 and 64');
}

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
    onInterrupted,
    onStateChange,
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
    this.onInterrupted = onInterrupted || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.state = 'waiting';
    this.freshFallbackCount = 0;
    this.onFailure = onFailure || (() => {});

    this.costStartedAt = null;
    this.costLastLogAt = null;
    this.costConnectionAttempt = 0;
    this.costUsageReports = 0;
    this.costLatestUsage = null;
    this.costInputMs = 0;
    this.costSubmittedMs = 0;
    this.costSyntheticMs = 0;
    this.costOutputMs = 0;
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
    this.drainBursts = 0;
    this.maxDrainBurstMessages = 0;
    this.maxDrainBurstMs = 0;
    // Test-only speech gate accounting. Counters are based on 16kHz source samples.
    this.speechGateHangoverSamples = 0;
    this.speechGateInputSamples = 0;
    this.speechGateForwardedSamples = 0;
    this.speechGateSkippedSamples = 0;
    this.speechGateSpeechFrames = 0;
    this.speechGateSilentFrames = 0;
    this.speechGateLastLogAt = performance.now();
  }

  _setState(state, details = {}) {
    if (this.state === state && !details.freshFallback) return;
    this.state = state;
    try { this.onStateChange(state, details); }
    catch { console.error(`${this._tag()} state observer failed`); }
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

  _drainDelayMs(audioBytes, factor = this._catchupFactor()) {
    if (!audioBytes) return MIN_DRAIN_DELAY_MS;
    const audioDurationMs = audioBytes / INPUT_BYTES_PER_MS;
    return Math.max(MIN_DRAIN_DELAY_MS, audioDurationMs / factor);
  }

  _speechGateStats() {
    const inputMs = this.speechGateInputSamples / 16;
    const forwardedMs = this.speechGateForwardedSamples / 16;
    const skippedMs = this.speechGateSkippedSamples / 16;
    const ratio = this.speechGateInputSamples > 0
      ? this.speechGateForwardedSamples / this.speechGateInputSamples
      : (LOAD_TEST_SPEECH_GATE ? 0 : 1);
    const savedPercent = LOAD_TEST_SPEECH_GATE && this.speechGateInputSamples > 0
      ? (1 - ratio) * 100
      : 0;

    return {
      speechGateEnabled: LOAD_TEST_SPEECH_GATE,
      speechGateThreshold: SPEECH_GATE_THRESHOLD,
      speechGateHangoverMs: SPEECH_GATE_HANGOVER_MS,
      speechGateInputMs: Math.round(inputMs),
      speechForwardedMs: Math.round(forwardedMs),
      silenceSkippedMs: Math.round(skippedMs),
      speechGateRatio: Number(ratio.toFixed(4)),
      speechGateSavedPercent: Number(savedPercent.toFixed(1)),
      speechGateSpeechFrames: this.speechGateSpeechFrames,
      speechGateSilentFrames: this.speechGateSilentFrames,
    };
  }

  _logSpeechGate(prefix = 'speech-gate') {
    if (!LOAD_TEST_SPEECH_GATE) return;
    const stats = this._speechGateStats();
    console.log(
      `${this._tag()} ${prefix} ` +
      `inputMs=${stats.speechGateInputMs} ` +
      `forwardedMs=${stats.speechForwardedMs} ` +
      `skippedMs=${stats.silenceSkippedMs} ` +
      `forwardedRatio=${stats.speechGateRatio} ` +
      `saved=${stats.speechGateSavedPercent}%`,
    );
  }

  _speechGateAllows(int16_16k) {
    if (!LOAD_TEST_SPEECH_GATE) return true;

    this.speechGateInputSamples += int16_16k.length;

    // Peak detector is intentional for synthetic load-test WAVs: their silent regions are
    // digital/near-digital silence, so this is cheap and avoids clipping speech onsets.
    let peak = 0;
    for (let i = 0; i < int16_16k.length; i++) {
      const value = int16_16k[i];
      const abs = value < 0 ? -value : value;
      if (abs > peak) peak = abs;
      if (peak >= SPEECH_GATE_THRESHOLD) break;
    }

    let forward = false;

    if (peak >= SPEECH_GATE_THRESHOLD) {
      this.speechGateSpeechFrames += 1;
      this.speechGateHangoverSamples = SPEECH_GATE_HANGOVER_SAMPLES;
      forward = true;
    } else {
      this.speechGateSilentFrames += 1;
      if (this.speechGateHangoverSamples > 0) {
        // Forward a short tail of real silence so Gemini can finish the utterance/turn.
        this.speechGateHangoverSamples = Math.max(
          0,
          this.speechGateHangoverSamples - int16_16k.length,
        );
        forward = true;
      }
    }

    if (forward) this.speechGateForwardedSamples += int16_16k.length;
    else this.speechGateSkippedSamples += int16_16k.length;

    const now = performance.now();
    if (now - this.speechGateLastLogAt >= SPEECH_GATE_LOG_INTERVAL_MS) {
      this.speechGateLastLogAt = now;
      this._logSpeechGate();
    }

    return forward;
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
      config.realtimeInputConfig = { activityHandling: 'NO_INTERRUPTION' };
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
    this.costStartedAt = performance.now();
    this._logCost('start');
    this._setState('connecting');

    if (LOAD_TEST_SPEECH_GATE) {
      console.warn(
        `${this._tag()} TEST speech gate ENABLED ` +
        `threshold=${SPEECH_GATE_THRESHOLD} hangoverMs=${SPEECH_GATE_HANGOVER_MS}; ` +
        'do not use this setting for production/user calls',
      );
    }

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

  async _connect(handle, timeoutMs = CONNECT_TIMEOUT_MS) {
    const started = performance.now();
    this.costConnectionAttempt++;
    const connection = { session: null, active: false, failed: false, closed: false };
    connection.closeSignal = new Promise(resolve => { connection.confirmClose = resolve; });
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
      timeoutMs,
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
          onclose: event => {
            // Confirm even stale/intentional closes without letting them affect a new session.
            connection.closed = true;
            connection.confirmClose();
            failed(transportError(event, 'Gemini connection closed'));
          },
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
      this._setState(this.outbox.length ? 'catching_up' : 'ready');

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
    this.closingConnection = connection;

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

  // Both close confirmation and backoff must be cancellable on telephone hangup.
  _recoveryWait(ms, signal) {
    if (ms <= 0 || this.closed || this.failureRaised) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        if (this.cancelRecoveryWait === finish) this.cancelRecoveryWait = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.cancelRecoveryWait = finish;
      signal?.then(finish);
    });
  }

  _recover(reason) {
    if (this.closed || this.failureRaised || this.recovery) return;

    const recoveryError = reason instanceof Error
      ? reason
      : new Error(String(reason || 'Gemini connection failure'));

    this.reconnectCount += 1;
    this._setState('recovering');
    this.reconnectStartedAt = performance.now();
    // Leave headroom for new input and timer delays; budget every attempt, including fallback.
    const budgetMs = Math.min(RECONNECT_BUFFER_SECONDS * 1000,
      MAX_OUTBOX_MESSAGES * CHUNK_SAMPLES / 16) - 250;
    const recoveryDeadline = this.reconnectStartedAt + budgetMs;

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
          this.freshFallbackCount++;
          this._setState('recovering', { freshFallback: true });
          console.warn(
            `${this._tag()} fresh-session fallback; translation context resets ` +
            `queuedMs=${Math.round(this._queuedMs())}`,
          );
        }

        try {
          const slots = attempts - attempt + 1;
          const closing = this.closingConnection;
          this.closingConnection = null;
          if (closing && !closing.closed) {
            const waitMs = Math.max(0, Math.min(CLOSE_WAIT_MS,
              (recoveryDeadline - performance.now()) / slots / 4));
            await this._recoveryWait(waitMs, closing.closeSignal);
            if (this.closed || this.failureRaised) return;
            console.log(`${this._tag()} previous connection close confirmed=${closing.closed}`);
          }
          // Reserve at least half this attempt's share for setup, and preserve later slots.
          const requestedDelay = fresh ? 0 : Math.min(2000, RETRY_BASE_MS * 2 ** attempt)
            + Math.floor(Math.random() * (RETRY_JITTER_MS + 1));
          const delayMs = Math.max(0, Math.floor(Math.min(requestedDelay,
            (recoveryDeadline - performance.now()) / slots / 2)));
          if (delayMs) {
            console.log(`${this._tag()} reconnect attempt ${attempt + 1} backoffMs=${delayMs}`);
            await this._recoveryWait(delayMs);
          }
          if (this.closed || this.failureRaised) return;
          const remainingMs = recoveryDeadline - performance.now();
          if (remainingMs < 1) throw new Error('Gemini recovery deadline exceeded');
          const attemptMs = Math.max(1, Math.floor(Math.min(CONNECT_TIMEOUT_MS,
            remainingMs / (attempts - attempt + 1))));
          await this._connect(handle, attemptMs);

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
      drainBursts: this.drainBursts,
      maxDrainBurstMessages: this.maxDrainBurstMessages,
      maxDrainBurstMs: Math.round(this.maxDrainBurstMs),
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
        this.costSubmittedMs += bytes / INPUT_BYTES_PER_MS;
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

    const queuedMsAtStart = this._queuedMs();
    const factor = this._catchupFactor(queuedMsAtStart);
    const targetBytes = Math.max(
      CHUNK_SAMPLES * 2,
      Math.ceil(CATCHUP_BURST_TARGET_MS * INPUT_BYTES_PER_MS),
    );

    let acceptedMessages = 0;
    let acceptedBytes = 0;

    try {
      // sendRealtimeInput() is synchronous at this call boundary. Send a bounded amount
      // of already-buffered audio per callback, then sleep according to the SAME average
      // catch-up factor. This cuts timer callbacks substantially without hot-looping the SDK.
      while (
        acceptedMessages < this.outbox.length &&
        acceptedMessages < CATCHUP_BURST_MAX_MESSAGES
      ) {
        const item = this.outbox[acceptedMessages];
        this.session.sendRealtimeInput(item.payload);
        acceptedMessages += 1;
        acceptedBytes += item.bytes;

        // Zero-byte control messages do not advance the audio-time budget. Keep them bounded
        // by CATCHUP_BURST_MAX_MESSAGES so a control-message run can never monopolize the loop.
        if (acceptedBytes >= targetBytes) break;
      }
    } finally {
      // Remove only writes the SDK accepted. If a later item throws, that item and everything
      // after it remain queued for the replacement connection. One splice per burst also avoids
      // the repeated Array.shift() work that becomes expensive with large reconnect queues.
      if (acceptedMessages) {
        this.outbox.splice(0, acceptedMessages);
        this.outboxBytes -= acceptedBytes;
        this.costSubmittedMs += acceptedBytes / INPUT_BYTES_PER_MS;
        if (this.outboxBytes < 0) this.outboxBytes = 0;

        const burstMs = acceptedBytes / INPUT_BYTES_PER_MS;
        this.drainBursts += 1;
        this.maxDrainBurstMessages = Math.max(this.maxDrainBurstMessages, acceptedMessages);
        this.maxDrainBurstMs = Math.max(this.maxDrainBurstMs, burstMs);
      }
    }

    // IMPORTANT: if the queue is empty, do not leave a real-time timer running. The next
    // incoming audio can go back to the direct-send fast path immediately.
    if (!this.outbox.length) {
      if (this.catchupStartedAt !== null) {
        console.log(
          `${this._tag()} reconnect backlog drained ` +
          `catchupMs=${Math.round(performance.now() - this.catchupStartedAt)} ` +
          `maxQueuedMs=${Math.round(this.maxOutboxMs)} ` +
          `drainBursts=${this.drainBursts} ` +
          `maxBurstMessages=${this.maxDrainBurstMessages} ` +
          `maxBurstMs=${Math.round(this.maxDrainBurstMs)}`,
        );
      }
      this.catchupStartedAt = null;
      this._setState('ready');
      this.drainTimer = null;
      return;
    }

    // Pace the whole burst at the configured average catch-up factor. With the defaults,
    // four 40ms chunks (160ms audio) are sent together and a high-backlog 4x catch-up waits
    // about 40ms before the next burst, instead of scheduling one timer for every chunk.
    const delayMs = this._drainDelayMs(acceptedBytes, factor);

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

    if (m.usageMetadata) {
      // Preserve individual reports: do not assume cumulative vs per-response billing.
      const usage = {};
      for (const key of ['promptTokenCount', 'responseTokenCount', 'totalTokenCount',
        'cachedContentTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount']) {
        const value = m.usageMetadata[key];
        if (Number.isFinite(value) && value >= 0) usage[key] = value;
      }
      for (const key of ['promptTokensDetails', 'responseTokensDetails', 'cacheTokensDetails',
        'toolUsePromptTokensDetails']) {
        const details = m.usageMetadata[key];
        if (Array.isArray(details)) usage[key] = details.filter(x =>
          ['AUDIO', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'MODALITY_UNSPECIFIED'].includes(x?.modality)
          && Number.isFinite(x.tokenCount) && x.tokenCount >= 0
        ).map(x => ({ modality: x.modality, tokenCount: x.tokenCount }));
      }
      this.costUsageReports++;
      this.costLatestUsage = usage;
      console.log('[gemini-usage] ' + JSON.stringify({
        ...this._costIdentity(), report: this.costUsageReports, usage,
      }));
    }

    const sc = m.serverContent;
    if (!sc) return;
    // Count received/generated audio even if an interruption prevents playback.
    for (const part of sc.modelTurn?.parts || []) {
      if (part.inlineData?.data)
        this.costOutputMs += Buffer.byteLength(part.inlineData.data, 'base64') / 48;
    }
    if (sc.interrupted) { this.onInterrupted(); return; }

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

    this.costInputMs += int16_16k.length / 16;
    if (performance.now() - this.costLastLogAt >= 60000) this._logCost('sample');
    // Count received audio above even when the test gate skips it. Submitted cost
    // remains counted only after the SDK accepts a send.
    if (!this._speechGateAllows(int16_16k)) {
      this._flushPendingInput();
      return;
    }
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

  // Also used when the test gate closes, so a partial chunk cannot wait for
  // the next utterance. Do not start the PTT synthetic tail on every silent gap.
  _flushPendingInput() {
    if (this.pending.length) {
      this._send({
        audio: {
          data: int16ToB64(this.pending),
          mimeType: 'audio/pcm;rate=16000',
        },
      }, this.pending.byteLength);

      this.pending = new Int16Array(0);
    }
  }

  endInput() {
    if (this.closed || !this.inputOpen) return;

    this.inputOpen = false;

    this._flushPendingInput();

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

        this.costSubmittedMs += INPUT_TAIL_MS;
        this.costSyntheticMs += INPUT_TAIL_MS;
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

  _costIdentity() {
    return { schemaVersion: 1, timestamp: new Date().toISOString(), model: MODEL,
      callId: this.callId, direction: this.direction, sourceLang: this.sourceLang,
      targetLang: this.targetLang, connectionAttempt: this.costConnectionAttempt };
  }

  _logCost(event) {
    const now = performance.now();
    this.costLastLogAt = now;
    console.log('[gemini-cost] ' + JSON.stringify({ ...this._costIdentity(), event,
      elapsedMs: this.costStartedAt === null ? 0 : Math.round(now - this.costStartedAt),
      inputReceivedMs: this.costInputMs, inputSubmittedMs: this.costSubmittedMs,
      syntheticInputSubmittedMs: this.costSyntheticMs, outputReceivedMs: this.costOutputMs,
      usageReports: this.costUsageReports, reconnectCount: this.reconnectCount,
      freshFallbackCount: this.freshFallbackCount, pendingInputMs: this.pending.length / 16,
      queuedInputMs: Math.round(this._queuedMs()), failed: this.failureRaised,
    }));
  }

  getStats() {
    return {
      cost: this.started ? { model: MODEL, inputSubmittedMs: this.costSubmittedMs,
        outputReceivedMs: this.costOutputMs, syntheticInputSubmittedMs: this.costSyntheticMs,
        usageReports: this.costUsageReports, latestUsage: this.costLatestUsage } : null,
      state: this.state,
      freshFallbackCount: this.freshFallbackCount,
      recoveryMs: this.reconnectStartedAt === null ? 0 : Math.round(performance.now() - this.reconnectStartedAt),
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
      drainBursts: this.drainBursts,
      maxDrainBurstMessages: this.maxDrainBurstMessages,
      maxDrainBurstMs: Math.round(this.maxDrainBurstMs),
      ...this._speechGateStats(),
    };
  }

  close() {
    if (this.closed) return;

    this._logSpeechGate('speech-gate final');
    if (this.started) this._logCost('end');
    this.closed = true;
    this.cancelRecoveryWait?.();
    this._setState(this.failureRaised ? 'failed' : 'closed');
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
