// One-way Asterisk media test: phone PCM in -> Gemini Live translation/audio -> PCM to Asterisk.
import { Translator } from './Translator.js';
import { bufToInt16, int16ToBuf, pcm8kTo16k, pcm24kTo8k } from './audio.js';

export class MediaTranslation {
  constructor(callId, sock, pacer, { sourceLang, targetLang }) {
    this.callId = callId;
    this.sock = sock;
    this.pacer = pacer;
    this.closed = false;
    this.ready = false;
    this.translator = new Translator(targetLang, {
      sourceLang,
      onInputText: text => console.log(`[stt ${callId}] ${text}`),
      onOutputText: text => console.log(`[translation ${callId}] ${text}`),
      onAudio: pcm24 => this.pacer.push(int16ToBuf(pcm24kTo8k(pcm24))),
      onTurnEnd: () => this.pacer.commit(),
    });
  }

  async init() {
    this.pacer.start();
    await this.translator.start();
    if (!this.closed) {
      this.ready = true;
      console.log(`[media ${this.callId}] translation ready (${this.translator.sourceLang || 'auto'} -> ${this.translator.targetLang}); speaking audio back to Asterisk`);
    }
  }

  onCallAudio(pcm8) {
    if (!this.closed && this.ready) this.translator.feed(pcm8kTo16k(bufToInt16(pcm8)));
  }

  // This Asterisk mode translates phone audio directly and does not use browser audio.
  attachAgent() {}
  detachAgent() {}
  setPtt() {}
  onAgentAudio() {}

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.translator.close();
    this.pacer.stop();
  }
}
