// Orchestrates one active call. Holds the customer media transport, the agent browser WS,
// and the two per-direction Gemini Translator sessions. Routes audio between them.
//
// Use case: agent speaks AGENT_LANG; customer hears it in CUSTOMER_LANG. Customer speaks
// CUSTOMER_LANG; agent hears it in AGENT_LANG.
import WebSocket from 'ws';
import { Translator } from './Translator.js';
import { failureCause, translatorTelemetry } from './CallMonitor.js';
import { OutputPacer } from './audiosocket.js';
import { bufToInt16, pcm8kTo16k, int16ToBuf, b64ToInt16, int16ToB64, StreamingDownsampler } from './audio.js';

const AGENT_LANG = process.env.AGENT_LANG || 'hi';
const CUSTOMER_LANG = process.env.CUSTOMER_LANG || 'en';
const AGENT_CHUNK_MS = Number(process.env.AGENT_CHUNK_MS || 20);
if (![20, 40, 100].includes(AGENT_CHUNK_MS)) throw new Error('AGENT_CHUNK_MS must be 20, 40, or 100');

export class CallBridge {
  constructor(callId, sock, { pacer = new OutputPacer(sock), monitor, onClose = () => {} } = {}) {
    this.callId = callId;
    this.onClose = onClose;
    this.sock = sock;             // customer TCP socket or WebSocket adapter
    this.agentWs = null;          // agent browser WS
    this.pacer = pacer;
    this.downsampler = new StreamingDownsampler();
    this.pacer.onFailure = reason => this.close(reason, true);
    this.startedAt = Date.now();
    this.agentTalking = false;    // PTT state
    this.closed = false;
    this.ready = false;
    this.monitor = monitor;
    this.monitorId = monitor?.start(callId, 'legacy');
    monitor?.watch(this.monitorId, () => ({ caller: { queueMs: Math.round(this.pacer.queuedMs || 0),
      maxQueueMs: Math.round(this.pacer.stats?.maxQueueMs || 0), ...translatorTelemetry(this.toAgent) },
      agent: translatorTelemetry(this.toCustomer) }));
    this.received = { caller: 0, agent: 0 };
    monitor?.update(this.monitorId, { state: 'starting' });
    monitor?.leg(this.monitorId, 'caller', { connected: true, sourceLang: CUSTOMER_LANG,
      targetLang: AGENT_LANG, translator: 'starting' });
    monitor?.leg(this.monitorId, 'agent', { connected: false, sourceLang: AGENT_LANG,
      targetLang: CUSTOMER_LANG, translator: 'starting' });

    // customer speech (CUSTOMER_LANG) -> agent hears AGENT_LANG
    this.toAgent = new Translator(AGENT_LANG, {
      sourceLang: CUSTOMER_LANG, callId, direction: 'caller->agent',
      onStateChange: (state, details) => this.translatorState('caller', state, details),
      onAudio: (i24) => this.sendToAgent(i24),
      onInputText: (t) => this.sendTranscript('customer', t),
      onOutputText: (t) => this.sendTranscript('agent-hears', t),
      onTurnEnd: () => this.sendUi({ type: 'turn-end', side: 'customer' }),
      onInterrupted: () => this.sendUi({ type: 'interrupted', side: 'customer' }),
      onFailure: error => this.reportFailure('caller', error),
    });
    // agent speech (AGENT_LANG) -> customer hears CUSTOMER_LANG
    this.toCustomer = new Translator(CUSTOMER_LANG, {
      sourceLang: AGENT_LANG, callId, direction: 'agent->caller',
      onStateChange: (state, details) => this.translatorState('agent', state, details),
      onAudio: (i24) => this.sendToCall(i24),
      onInputText: (t) => this.sendTranscript('agent', t),
      onOutputText: (t) => this.sendTranscript('customer-hears', t),
      // Release any short tail when a turn-end is available; streaming never depends on it.
      onTurnEnd: () => { this.pacer.commit(); this.sendUi({ type: 'turn-end', side: 'agent' }); },
      onInterrupted: () => { if (!this.closed) { this.pacer.flush(); this.pacer.resetClock(); this.downsampler.reset(); } },
      onFailure: error => this.reportFailure('agent', error),
    });
  }

  async init() {
    this.pacer.start();
    await Promise.all([this.toAgent.start(), this.toCustomer.start()]);
    if (this.closed) return;
    this.ready = true;
    this.monitor?.update(this.monitorId, { state: 'ready' });
    for (const role of ['caller', 'agent']) this.monitor?.leg(this.monitorId, role, { translator: translatorTelemetry(role === 'caller' ? this.toAgent : this.toCustomer).translator || 'ready' });
    this.monitor?.event(this.monitorId, 'info', 'Translators ready');
    console.log(`[bridge ${this.callId}] translators ready (customer ${CUSTOMER_LANG}->agent ${AGENT_LANG}, agent ${AGENT_LANG}->customer ${CUSTOMER_LANG})`);
  }

  attachAgent(ws) {
    if (this.closed || !this.ready || this.agentWs === ws) return;
    this.agentWs = ws;
    this.monitor?.leg(this.monitorId, 'agent', { connected: true });
    this.monitor?.event(this.monitorId, 'info', 'Browser agent connected', 'agent');
    // Reset PTT on (re)attach: a browser reconnect can leave agentTalking stuck true
    // (missed mouseup before the socket dropped), which silently mutes the customer leg.
    this.agentTalking = false;
    console.log(`[bridge ${this.callId}] agent attached`);
    this.sendUi({ type: 'config', agentLang: AGENT_LANG, customerLang: CUSTOMER_LANG, chunkMs: AGENT_CHUNK_MS });
    this.sendUi({ type: 'call', state: 'connected' });
  }
  detachAgent(ws) {
    if (ws && this.agentWs !== ws) return;
    if (this.agentWs && !this.closed) {
      this.monitor?.leg(this.monitorId, 'agent', { connected: false });
      this.monitor?.event(this.monitorId, 'warning', 'Browser agent disconnected', 'agent');
    }
    if (this.agentTalking) this.toCustomer.endInput();
    if (this.agentWs) console.log(`[bridge ${this.callId}] agent detached`);
    this.agentWs = null;
    this.agentTalking = false; // never leave the customer leg muted with no agent attached
  }

  sendUi(obj) {
    const ws = this.agentWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 24000 * 2 * 5 * 4 / 3) {
        if (!this.closed) this.close('Browser send buffer exceeded five seconds', true);
        else ws.terminate?.();
        return;
      }
      ws.send(JSON.stringify(obj));
    }
  }

  // Push-to-talk from the agent browser. While the agent is talking, mute the customer
  // leg so the shared-device mic can't echo the agent's own voice back into translation.
  setPtt(active) {
    if (this.closed || active === this.agentTalking) return;
    this.agentTalking = active;
    if (active) this.toCustomer.beginInput();
    else this.toCustomer.endInput();
  }

  // Raw PCM 16-bit LE 8kHz from either Asterisk transport -> Gemini customer->agent.
  onCallAudio(payload) {
    if (this.closed || this.agentTalking) return;
    this.recordInput('caller', payload.length);
    const i8 = bufToInt16(payload);
    this.toAgent.feed(pcm8kTo16k(i8));
  }

  // base64 PCM 16kHz from agent browser mic -> Gemini agent->customer.
  // Browser only sends while PTT is held, so no gate needed here.
  onAgentAudio(b64) {
    if (!this.closed) {
      const pcm = b64ToInt16(b64);
      this.recordInput('agent', pcm.byteLength);
      this.toCustomer.feed(pcm);
    }
  }

  // translated AGENT_LANG audio (24kHz) -> agent browser.
  sendToAgent(i24) {
    if (this.closed) return;
    this.monitor?.leg(this.monitorId, 'caller', { lastOutputAt: Date.now() });
    this.sendUi({ type: 'audio', rate: 24000, data: int16ToB64(i24) });
  }

  // translated CUSTOMER_LANG audio (24kHz) -> downsample 8kHz -> pace into the call.
  sendToCall(i24) {
    if (this.closed) return;
    this.monitor?.leg(this.monitorId, 'agent', { lastOutputAt: Date.now() });
    const pcm = int16ToBuf(this.downsampler.process(i24));
    if (this.pacer.queuedBytes + pcm.length > 16000 * 30) return this.close('Playback queue exceeded thirty seconds', true);
    this.pacer.push(pcm);
  }

  sendTranscript(who, text) {
    const role = ['customer', 'agent-hears'].includes(who) ? 'caller' : 'agent';
    const kind = ['agent-hears', 'customer-hears'].includes(who) ? 'translated' : 'recognized';
    this.monitor?.transcript(this.monitorId, role, kind, text);
    this.sendUi({ type: 'transcript', who, text });
  }

  recordInput(role, bytes) {
    this.received[role] += bytes;
    this.monitor?.leg(this.monitorId, role, { receivedBytes: this.received[role], lastInputAt: Date.now() });
  }

  translatorState(role, state, details) {
    if (this.closed) return;
    this.monitor?.leg(this.monitorId, role, { translator: state });
    this.monitor?.event(this.monitorId, details.freshFallback ? 'warning' : 'info',
      details.freshFallback ? 'Fresh translation session: context reset' : `Translator ${state}`, role);
  }

  reportFailure(role, error) {
    if (this.closed) return;
    this.monitor?.leg(this.monitorId, role, { translator: 'failed' });
    this.monitor?.event(this.monitorId, 'error', failureCause(error), role);
    this.close(`Translator failed for ${role}`, true);
  }

  close(reason = 'Call ended', failed = false) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.monitor?.end(this.monitorId, reason, failed);
    this.onClose();
    try {
      this.sendUi({ type: 'call', state: 'ended' });
    } catch { /* Keep teardown progressing. */ }
    this.toAgent.close();
    this.toCustomer.close();
    this.pacer.stop();
    if (!this.sock.destroyed) this.sock.end?.();
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    console.log(`[bridge ${this.callId}] closed, duration ${secs}s`);
  }
}
