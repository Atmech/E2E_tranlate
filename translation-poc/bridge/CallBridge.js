// Orchestrates one active call. Holds the customer media transport, the agent browser WS,
// and the two per-direction Gemini Translator sessions. Routes audio between them.
//
// Use case: agent speaks AGENT_LANG; customer hears it in CUSTOMER_LANG. Customer speaks
// CUSTOMER_LANG; agent hears it in AGENT_LANG.
import WebSocket from 'ws';
import { Translator } from './Translator.js';
import { OutputPacer } from './audiosocket.js';
import { bufToInt16, pcm8kTo16k, pcm24kTo8k, int16ToBuf, b64ToInt16, int16ToB64 } from './audio.js';

const AGENT_LANG = process.env.AGENT_LANG || 'hi';
const CUSTOMER_LANG = process.env.CUSTOMER_LANG || 'en';
const AGENT_CHUNK_MS = Number(process.env.AGENT_CHUNK_MS || 20);
if (![20, 40, 100].includes(AGENT_CHUNK_MS)) throw new Error('AGENT_CHUNK_MS must be 20, 40, or 100');

export class CallBridge {
  constructor(callId, sock, { pacer = new OutputPacer(sock) } = {}) {
    this.callId = callId;
    this.sock = sock;             // customer TCP socket or WebSocket adapter
    this.agentWs = null;          // agent browser WS
    this.pacer = pacer;
    this.startedAt = Date.now();
    this.agentTalking = false;    // PTT state
    this.closed = false;
    this.ready = false;

    // customer speech (CUSTOMER_LANG) -> agent hears AGENT_LANG
    this.toAgent = new Translator(AGENT_LANG, {
      sourceLang: CUSTOMER_LANG,
      onAudio: (i24) => this.sendToAgent(i24),
      onInputText: (t) => this.sendTranscript('customer', t),
      onOutputText: (t) => this.sendTranscript('agent-hears', t),
      onTurnEnd: () => this.sendUi({ type: 'turn-end', side: 'customer' }),
    });
    // agent speech (AGENT_LANG) -> customer hears CUSTOMER_LANG
    this.toCustomer = new Translator(CUSTOMER_LANG, {
      sourceLang: AGENT_LANG,
      onAudio: (i24) => this.sendToCall(i24),
      onInputText: (t) => this.sendTranscript('agent', t),
      onOutputText: (t) => this.sendTranscript('customer-hears', t),
      // Release any short tail when a turn-end is available; streaming never depends on it.
      onTurnEnd: () => { this.pacer.commit(); this.sendUi({ type: 'turn-end', side: 'agent' }); },
    });
  }

  async init() {
    this.pacer.start();
    await Promise.all([this.toAgent.start(), this.toCustomer.start()]);
    if (this.closed) return;
    this.ready = true;
    console.log(`[bridge ${this.callId}] translators ready (customer ${CUSTOMER_LANG}->agent ${AGENT_LANG}, agent ${AGENT_LANG}->customer ${CUSTOMER_LANG})`);
  }

  attachAgent(ws) {
    if (this.closed || !this.ready || this.agentWs === ws) return;
    this.agentWs = ws;
    // Reset PTT on (re)attach: a browser reconnect can leave agentTalking stuck true
    // (missed mouseup before the socket dropped), which silently mutes the customer leg.
    this.agentTalking = false;
    console.log(`[bridge ${this.callId}] agent attached`);
    this.sendUi({ type: 'config', agentLang: AGENT_LANG, customerLang: CUSTOMER_LANG, chunkMs: AGENT_CHUNK_MS });
    this.sendUi({ type: 'call', state: 'connected' });
  }
  detachAgent(ws) {
    if (ws && this.agentWs !== ws) return;
    if (this.agentTalking) this.toCustomer.endInput();
    if (this.agentWs) console.log(`[bridge ${this.callId}] agent detached`);
    this.agentWs = null;
    this.agentTalking = false; // never leave the customer leg muted with no agent attached
  }

  sendUi(obj) {
    const ws = this.agentWs;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
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
    const i8 = bufToInt16(payload);
    this.toAgent.feed(pcm8kTo16k(i8));
  }

  // base64 PCM 16kHz from agent browser mic -> Gemini agent->customer.
  // Browser only sends while PTT is held, so no gate needed here.
  onAgentAudio(b64) {
    if (!this.closed) this.toCustomer.feed(b64ToInt16(b64));
  }

  // translated AGENT_LANG audio (24kHz) -> agent browser.
  sendToAgent(i24) {
    const ws = this.agentWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'audio', rate: 24000, data: int16ToB64(i24) }));
    }
  }

  // translated CUSTOMER_LANG audio (24kHz) -> downsample 8kHz -> pace into the call.
  sendToCall(i24) {
    this.pacer.push(int16ToBuf(pcm24kTo8k(i24)));
  }

  sendTranscript(who, text) {
    const ws = this.agentWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'transcript', who, text }));
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.sendUi({ type: 'call', state: 'ended' });
    this.toAgent.close();
    this.toCustomer.close();
    this.pacer.stop();
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    console.log(`[bridge ${this.callId}] closed, duration ${secs}s`);
  }
}
