// One call owns two Asterisk connections and one translator per speaker.
import { Translator } from './Translator.js';
import { bufToInt16, int16ToBuf, pcm8kTo16k, pcm24kTo8k } from './audio.js';

export function readMediaMetadata(variables) {
  const { CALL_ID, ROLE, SOURCE_LANG, TARGET_LANG } = variables || {};
  if (typeof CALL_ID !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(CALL_ID))
    throw new Error('Missing or invalid channel_variables.CALL_ID');
  if (!['caller', 'agent'].includes(ROLE))
    throw new Error('channel_variables.ROLE must be caller or agent');
  for (const value of [SOURCE_LANG, TARGET_LANG]) {
    if (typeof value !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value))
      throw new Error('Missing or invalid SOURCE_LANG / TARGET_LANG');
  }
  return { callId: CALL_ID, role: ROLE, sourceLang: SOURCE_LANG, targetLang: TARGET_LANG };
}

const opposite = role => role === 'caller' ? 'agent' : 'caller';

export class CallTranslationSession {
  constructor(callId, { onClose, createTranslator = (lang, options) => new Translator(lang, options),
    setupTimeoutMs = 30000 } = {}) {
    this.callId = callId;
    this.legs = new Map();
    this.closed = false;
    this.ready = false;
    this.acceptsBrowserAudio = false;
    this.onClose = onClose || (() => {});
    this.createTranslator = createTranslator;
    this.setupTimeoutMs = setupTimeoutMs;
    this._armTimeout('Waiting for second participant timed out');
  }

  _armTimeout(reason) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(reason, 1011), this.setupTimeoutMs);
    this.timer.unref?.();
  }

  addLeg(metadata, sock, pacer) {
    const { callId, role, sourceLang, targetLang } = metadata;
    if (this.closed || callId !== this.callId) throw new Error('Call session unavailable');
    if (this.legs.has(role)) throw new Error(`Duplicate role ${role}`);
    const peer = this.legs.get(opposite(role));
    if (peer && (peer.sourceLang !== targetLang || peer.targetLang !== sourceLang))
      throw new Error('Caller and agent languages must be reciprocal');
    pacer.label = `${callId} ${opposite(role)}->${role}`;
    this.legs.set(role, { sourceLang, targetLang, sock, pacer, droppedBytes: 0 });
    console.log(`[media ${callId}] joined role=${role} ${sourceLang}->${targetLang}`);
    // Defer startup until the handler has installed its connection cleanup adapter.
    if (this.legs.size === 2) {
      this._armTimeout('Translator setup timed out');
      queueMicrotask(() => this._start());
    } else console.log(`[media ${callId}] waiting for ${opposite(role)}`);
    return {
      onCallAudio: pcm => this.onAudio(role, pcm),
      close: () => this.close(`${role} disconnected`),
    };
  }

  async _start() {
    if (this.closed) return;
    try {
      for (const [role, leg] of this.legs) {
        const destination = this.legs.get(opposite(role));
        leg.translator = this.createTranslator(leg.targetLang, {
          sourceLang: leg.sourceLang,
          onInputText: text => console.log(`[stt ${this.callId} ${role}] ${text}`),
          onOutputText: text => console.log(`[translation ${this.callId} ${role}->${opposite(role)}] ${text}`),
          onAudio: pcm24 => {
            if (this.closed) return;
            const pcm8 = int16ToBuf(pcm24kTo8k(pcm24));
            // Bound memory even when the recipient remains paused with MEDIA_XOFF.
            if (destination.pacer.queuedBytes + pcm8.length > 16000 * 30)
              return this.close('Playback queue exceeded thirty seconds', 1011);
            destination.pacer.push(pcm8);
          },
          onTurnEnd: () => { if (!this.closed) destination.pacer.commit(); },
          onFailure: () => this.close(`Translator failed for ${role}`, 1011),
        });
      }
      await Promise.all([...this.legs.values()].map(leg => leg.translator.start()));
      if (this.closed) return;
      clearTimeout(this.timer);
      for (const leg of this.legs.values()) leg.pacer.start();
      this.ready = true;
      console.log(`[media ${this.callId}] translation ready: caller->agent and agent->caller`);
    } catch (error) {
      console.error(`[media ${this.callId}] translator setup failed:`, error.message);
      this.close('Translator setup failed', 1011);
    }
  }

  onAudio(role, pcm8) {
    if (this.closed) return;
    const leg = this.legs.get(role);
    if (!this.ready) { leg.droppedBytes += pcm8.length; return; }
    leg.translator.feed(pcm8kTo16k(bufToInt16(pcm8)));
  }

  close(reason = 'Call ended', code = 1000) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.timer);
    this.onClose();
    for (const [role, leg] of this.legs) {
      leg.translator?.close();
      leg.pacer.stop();
      leg.sock.end(code, reason);
      console.log(`[media ${this.callId}] closed role=${role} startupDroppedBytes=${leg.droppedBytes}: ${reason}`);
    }
  }
}
