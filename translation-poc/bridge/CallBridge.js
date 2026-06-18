// Orchestrates one active call. Holds the AudioSocket TCP socket, the agent browser WS,
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
const PTT_HANGOVER_MS = 0;

export class CallBridge {
  constructor(callId, sock) {
    this.callId = callId;
    this.sock = sock;             // AudioSocket TCP connection (customer leg)
    this.agentWs = null;          // agent browser WS
    this.pacer = new OutputPacer(sock);
    this.startedAt = Date.now();
    this.agentTalking = false;    // PTT state

    // customer speech (CUSTOMER_LANG) -> agent hears AGENT_LANG
    this.toAgent = new Translator(AGENT_LANG, {
      onAudio: (i24) => this.sendToAgent(i24),
      onInputText: (t) => this.sendTranscript('customer', t),
      onOutputText: (t) => this.sendTranscript('agent-hears', t),
      onTurnEnd: () => this.sendUi({ type: 'turn-end', side: 'customer' }),
    });
    // agent speech (AGENT_LANG) -> customer hears CUSTOMER_LANG
    this.toCustomer = new Translator(CUSTOMER_LANG, {
      onAudio: (i24) => this.sendToCall(i24),
      onInputText: (t) => this.sendTranscript('agent', t),
      onOutputText: (t) => this.sendTranscript('customer-hears', t),
      // Gemini delivers Arabic sub-realtime; buffer a full utterance then play it gaplessly.
      onTurnEnd: () => { this.pacer.commit(); this.sendUi({ type: 'turn-end', side: 'agent' }); },
    });
  }

  async init() {
    this.pacer.start();
    await Promise.all([this.toAgent.start(), this.toCustomer.start()]);
    console.log(`[bridge ${this.callId}] translators ready (customer ${CUSTOMER_LANG}->agent ${AGENT_LANG}, agent ${AGENT_LANG}->customer ${CUSTOMER_LANG})`);
  }

  attachAgent(ws) {
    this.agentWs = ws;
    console.log(`[bridge ${this.callId}] agent attached`);
    this.sendUi({ type: 'config', agentLang: AGENT_LANG, customerLang: CUSTOMER_LANG });
    this.sendUi({ type: 'call', state: 'connected' });
  }
  detachAgent() { if (this.agentWs) console.log(`[bridge ${this.callId}] agent detached`); this.agentWs = null; }

  sendUi(obj) {
    const ws = this.agentWs;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // Push-to-talk from the agent browser. While the agent is talking, mute the customer
  // leg so the shared-device mic can't echo the agent's own voice back into translation.
  setPtt(active) {
    this.agentTalking = active;
  }

  // 0x10 payload from Asterisk (PCM 16-bit LE 8kHz) -> Gemini customer->agent.
  onCallAudio(payload) {
    if (this.agentTalking) return;
    const i8 = bufToInt16(payload);
    this.toAgent.feed(pcm8kTo16k(i8));
  }

  // base64 PCM 16kHz from agent browser mic -> Gemini agent->customer.
  // Browser only sends while PTT is held, so no gate needed here.
  onAgentAudio(b64) {
    this.toCustomer.feed(b64ToInt16(b64));
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
    this.sendUi({ type: 'call', state: 'ended' });
    this.toAgent.close();
    this.toCustomer.close();
    this.pacer.stop();
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    console.log(`[bridge ${this.callId}] closed, duration ${secs}s`);
  }
}
