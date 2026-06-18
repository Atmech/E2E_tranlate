# POC Plan: 2-Way Live Call Translation (FreeSWITCH + Zoiper + Gemini)

## What we are building

A translation bridge that sits between a FreeSWITCH PBX and a softphone (Zoiper).
When a "customer" calls in on Zoiper A speaking Hindi, the "agent" on Zoiper B hears
real-time English. When the agent replies in English, the customer hears real-time Hindi.
Translation is powered by Gemini Live Translate API (gemini-3.5-live-translate-preview).
No cloud telephony needed — everything runs locally on one machine for POC.

---

## Repo structure to create

```
translation-poc/
├── freeswitch/
│   └── dialplan.xml          # call routing config (copy into FS conf)
├── bridge/
│   ├── package.json
│   ├── index.js              # main entry — HTTP + WS server
│   ├── CallBridge.js         # per-call orchestrator
│   ├── Translator.js         # wraps one Gemini Live session (one direction)
│   └── audio.js              # all codec/resample helpers
├── agent-ui/
│   └── index.html            # agent browser client (mic capture + audio playback)
├── .env.example
└── README.md
```

---

## Environment variables (.env)

```
GEMINI_API_KEY=your_key_here
BRIDGE_PORT=8080
FREESWITCH_WS_PATH=/freeswitch    # path FS connects to
AGENT_WS_PATH=/agent              # path browser connects to
```

---

## Component 1 — audio.js

Pure functions, no side effects. All audio math lives here.

### Functions to implement:

**muLawDecode(u: number): number**
- Decode a single G.711 mu-law byte to 16-bit signed PCM sample
- Standard ITU-T G.711 algorithm

**muLawEncode(s: number): number**
- Encode a 16-bit signed PCM sample to G.711 mu-law byte
- Standard ITU-T G.711 algorithm

**resample(int16: Int16Array, inRate: number, outRate: number): Int16Array**
- Linear interpolation resampler
- If inRate === outRate return input unchanged (fast path)

**ulawBufToPcm8k(buf: Buffer): Int16Array**
- Convert a Buffer of mu-law bytes to Int16Array at 8kHz
- Calls muLawDecode per byte

**pcm8kToUlawBuf(int16: Int16Array): Buffer**
- Convert Int16Array at 8kHz to Buffer of mu-law bytes
- Calls muLawEncode per sample

**pcm8kTo16k(int16: Int16Array): Int16Array**
- Upsample 8kHz PCM to 16kHz using resample()

**pcm24kTo8k(int16: Int16Array): Int16Array**
- Downsample 24kHz PCM to 8kHz using resample()

**int16ToB64(i16: Int16Array): string**
- Serialize Int16Array to base64 string for WebSocket transport

**b64ToInt16(b64: string): Int16Array**
- Deserialize base64 string back to Int16Array

### Audio format reference (critical — wrong format = garbled audio):
- FreeSWITCH sends:  G.711 mu-law, 8kHz, mono, 20ms frames (160 bytes per frame)
- Gemini input needs: PCM 16-bit signed LE, 16kHz, mono, ~100ms chunks (1600 samples)
- Gemini output gives: PCM 16-bit signed LE, 24kHz, mono, variable chunk size
- FreeSWITCH expects back: G.711 mu-law, 8kHz, mono

### Conversion chains:
- Inbound (FS → Gemini):  mu-law bytes → pcm8k → pcm16k → batch to 1600 samples → base64
- Outbound (Gemini → FS): base64 → pcm24k → pcm8k → mu-law bytes

---

## Component 2 — Translator.js

Wraps a single Gemini Live Translate session for one direction of translation.

```
class Translator {
  constructor(targetLang: string, onAudio: fn, onTranscript: fn)

  async start(): void
    // Open Gemini Live session with:
    // model: "gemini-3.5-live-translate-preview"
    // responseModalities: ["AUDIO"]
    // inputAudioTranscription: {}       <- enables input transcript events
    // outputAudioTranscription: {}      <- enables output transcript events
    // translationConfig.targetLanguageCode: this.targetLang
    // translationConfig.echoTargetLanguage: false
    // On message: route inputTranscription, outputTranscription, modelTurn.parts to callbacks

  feed(int16_16k: Int16Array): void
    // Accumulate samples in this.pending buffer
    // Flush in 1600-sample (100ms) chunks to session.sendRealtimeInput()
    // mime type: "audio/pcm;rate=16000"
    // Keep remainder in pending for next call

  close(): void
    // Close session cleanly
}
```

Two instances are created per call:
- `hiToEn` — targetLang "en", receives Hindi from customer, fires onAudio with English PCM
- `enToHi` — targetLang "hi", receives English from agent, fires onAudio with Hindi PCM

---

## Component 3 — CallBridge.js

Orchestrates one active call. Holds references to both WebSocket connections and both
Translator instances. Routes audio between them.

```
class CallBridge {
  constructor(callId: string)

  // Properties:
  fsWs: WebSocket | null         // FreeSWITCH mod_audio_stream connection
  agentWs: WebSocket | null      // Agent browser WebSocket connection
  hiToEn: Translator             // customer Hindi → agent English
  enToHi: Translator             // agent English → customer Hindi

  async init(): void
    // Start both Translator sessions

  onFsAudio(rawBuf: Buffer): void
    // Called when FS sends a binary audio frame (raw mu-law bytes, NOT JSON)
    // Pipeline: ulawBufToPcm8k → pcm8kTo16k → hiToEn.feed()

  onAgentAudio(b64pcm16k: string): void
    // Called when agent browser sends mic audio
    // Pipeline: b64ToInt16 → enToHi.feed()

  sendToAgent(pcm24: Int16Array): void
    // Send translated English audio to agent browser
    // Format: JSON { type: "audio", rate: 24000, data: int16ToB64(pcm24) }
    // Check agentWs.readyState === WebSocket.OPEN before sending

  sendToFs(pcm24: Int16Array): void
    // Send translated Hindi audio back to FreeSWITCH
    // Pipeline: pcm24kTo8k → pcm8kToUlawBuf
    // Send as BINARY frame (raw Buffer, not JSON) over fsWs
    // Check fsWs.readyState === WebSocket.OPEN before sending

  close(): void
    // Close both Translator sessions
    // Log call duration
}
```

---

## Component 4 — index.js

HTTP + WebSocket server. Manages the active calls map.

### Endpoints:

**GET /health**
- Returns 200 JSON { status: "ok", activeCalls: number }

**WS /freeswitch**
- FreeSWITCH mod_audio_stream connects here
- Protocol: FS sends a JSON text frame first with call metadata:
  ```json
  { "callId": "abc123", "callerNum": "+91xxxxxxxxxx", "direction": "inbound" }
  ```
- After that metadata frame, ALL subsequent frames from FS are BINARY (raw mu-law audio)
- On metadata frame: create new CallBridge(callId), await bridge.init(), store in activeCalls map
- On binary frame: activeCalls.get(callId).onFsAudio(frame)
- On close: activeCalls.get(callId).close(), delete from map

  IMPORTANT — FreeSWITCH mod_audio_stream does NOT send the JSON metadata frame by default.
  The dialplan config must inject it. See FreeSWITCH config section below for how to do this.
  Simplest alternative for POC: use the channel UUID from the WS upgrade request URL as callId
  (FS appends it: ws://bridge:8080/freeswitch?uuid=<channel-uuid>)

**WS /agent**
- Agent browser connects here
- Protocol: all messages are JSON text frames
- Message types from browser:
  ```json
  { "type": "audio", "data": "<base64 pcm16k>" }
  { "type": "join",  "callId": "abc123" }
  ```
- On "join": link this ws to the matching CallBridge in activeCalls map
  (For POC with one call at a time, just link to whichever bridge exists)
- On "audio": bridge.onAgentAudio(msg.data)
- On close: detach from bridge (bridge stays alive, call continues)

### Active calls management:
```
const activeCalls = new Map()   // callId -> CallBridge
```

For POC, one call at a time is fine. Log a warning if a second call comes in.

---

## Component 5 — agent-ui/index.html

Single file browser app. No framework, no build step.

### What it does:
1. Connects to ws://localhost:8080/agent (URL configurable via input field)
2. Captures mic audio using AudioWorklet at 16kHz
3. Batches mic audio into ~100ms chunks (1600 samples at 16kHz)
4. Sends chunks as JSON { type: "audio", data: base64 } over WebSocket
5. Receives JSON { type: "audio", rate: 24000, data: base64 } from bridge
6. Plays received audio gaplessly using AudioContext at 24kHz with scheduled playback
   (use a playHead timestamp that advances with each buffer — prevents gaps and overlaps)
7. Shows live transcripts in a scrolling log panel
   (input transcripts = what customer said in Hindi, output = English translation)

### AudioWorklet processor (inline as blob URL):
```js
class CapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('cap', CapProcessor);
```

### Key implementation notes:
- Create AudioContext with { sampleRate: 16000 } for capture — browser resamples mic for you
- Create separate AudioContext with { sampleRate: 24000 } for playback
- Do NOT connect capture node to destination — avoids echo of own voice
- Always call audioCtx.resume() after creation (autoplay policy)
- gapless playback pattern:
  ```js
  let playHead = 0;
  function scheduleChunk(float32, ctx) {
    const buf = ctx.createBuffer(1, float32.length, 24000);
    buf.copyToChannel(float32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    if (playHead < now) playHead = now + 0.05; // small jitter buffer
    src.start(playHead);
    playHead += buf.duration;
  }
  ```

---

## Component 6 — FreeSWITCH dialplan config

File: `freeswitch/dialplan.xml`
This gets copied to `/etc/freeswitch/dialplan/default/` on the FS machine.

```xml
<extension name="translation-poc">
  <condition field="destination_number" expression="^(1000|1001)$">

    <!-- Answer the call -->
    <action application="answer"/>

    <!-- Small delay to let audio path establish -->
    <action application="sleep" data="500"/>

    <!-- Bridge audio to translation bridge via mod_audio_stream -->
    <!-- ws://127.0.0.1:8080/freeswitch?uuid=${uuid} -->
    <!-- two-way=true means FS both sends AND receives audio over this WS -->
    <action application="audio_stream"
            data="ws://127.0.0.1:8080/freeswitch?uuid=${uuid} two-way=true"/>

  </condition>
</extension>
```

### FreeSWITCH modules to enable in modules.conf.xml:
```xml
<load module="mod_audio_stream"/>   <!-- the key one -->
<load module="mod_sofia"/>          <!-- SIP stack -->
<load module="mod_native_file"/>
<load module="mod_sndfile"/>
<load module="mod_tone_stream"/>
<load module="mod_commands"/>
<load module="mod_dptools"/>
```

### SIP profile for Zoiper registration (sofia conf):
Default FS internal profile on port 5060 is fine for POC.
Zoiper registers as extension 1000 (customer) and 1001 (agent).
Default FS credentials: user = 1000 or 1001, password = 1234, domain = 127.0.0.1

---

## Component 7 — package.json

```json
{
  "name": "translation-poc",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node bridge/index.js",
    "dev": "node --watch bridge/index.js"
  },
  "dependencies": {
    "@google/genai": "latest",
    "express": "^4.18.0",
    "ws": "^8.16.0",
    "dotenv": "^16.0.0"
  }
}
```

---

## Setup sequence (README content)

### Step 1 — Install FreeSWITCH (Ubuntu 22.04)
```bash
apt install -y gnupg2 wget lsb-release
wget -O - https://files.freeswitch.org/repo/deb/debian-release/fsstretch-archive-keyring.asc | apt-key add -
echo "deb [signed-by=/usr/share/keyrings/freeswitch-archive-keyring.gpg] https://files.freeswitch.org/repo/deb/debian-release/ `lsb_release -sc` main" > /etc/apt/sources.list.d/freeswitch.list
apt update && apt install -y freeswitch freeswitch-mod-audio-stream freeswitch-mod-sofia
systemctl start freeswitch
```

### Step 2 — Configure FreeSWITCH
```bash
cp freeswitch/dialplan.xml /etc/freeswitch/dialplan/default/translation-poc.xml
systemctl restart freeswitch
# Verify mod_audio_stream is loaded:
fs_cli -x "module_exists mod_audio_stream"
```

### Step 3 — Start bridge
```bash
cp .env.example .env
# Add GEMINI_API_KEY to .env
npm install
npm start
# Should print: bridge on :8080
```

### Step 4 — Configure Zoiper (do this on two devices or two Zoiper instances)
```
Account type: SIP
Username: 1000          (second instance: 1001)
Password: 1234
Domain:   127.0.0.1
Port:     5060
```

### Step 5 — Open agent UI
```
Open agent-ui/index.html in browser (serve it: npx serve agent-ui)
WS URL: ws://localhost:8080/agent
Click "Start mic"
```

### Step 6 — Make a test call
```
From Zoiper 1000, dial 1001 (or any extension in the dialplan range)
FreeSWITCH answers, connects to bridge
Agent UI should light up — bridge is now live
Speak Hindi on Zoiper 1000 → agent hears English
Speak English in browser mic → Zoiper 1000 hears Hindi
```

---

## Data flow (precise, for implementation reference)

```
INBOUND (customer Hindi → agent English):

Zoiper A speaks Hindi
  → SIP/RTP → FreeSWITCH
  → mod_audio_stream → WS binary frame → bridge /freeswitch
  → CallBridge.onFsAudio(buf)
  → audio.ulawBufToPcm8k(buf)         [G.711 decode, 8kHz PCM]
  → audio.pcm8kTo16k(pcm8)            [upsample to 16kHz]
  → hiToEn.feed(pcm16k)               [buffer to 100ms chunks]
  → Gemini session A sendRealtimeInput [audio/pcm;rate=16000]
  → Gemini returns English PCM 24kHz
  → CallBridge.sendToAgent(pcm24)
  → WS JSON { type:"audio", data:b64 } → agent browser
  → AudioContext scheduleChunk()
  → Agent hears English ✓


OUTBOUND (agent English → customer Hindi):

Agent speaks English into browser mic
  → AudioWorklet @16kHz → main thread
  → WS JSON { type:"audio", data:b64 } → bridge /agent
  → CallBridge.onAgentAudio(b64)
  → audio.b64ToInt16(b64)             [16kHz PCM]
  → enToHi.feed(pcm16k)               [buffer to 100ms chunks]
  → Gemini session B sendRealtimeInput [audio/pcm;rate=16000]
  → Gemini returns Hindi PCM 24kHz
  → CallBridge.sendToFs(pcm24)
  → audio.pcm24kTo8k(pcm24)           [downsample]
  → audio.pcm8kToUlawBuf(pcm8)        [G.711 encode]
  → WS binary frame → FreeSWITCH mod_audio_stream
  → RTP → Zoiper A
  → Customer hears Hindi ✓
```

---

## Critical implementation gotchas

1. **FreeSWITCH binary frames** — mod_audio_stream sends raw binary (mu-law bytes), NOT base64,
   NOT JSON. Handle ws `message` event: if `Buffer.isBuffer(data)` → audio frame, else → metadata.

2. **mod_audio_stream output direction** — by default FS only SENDS audio to the WS.
   The `two-way=true` param in the dialplan is what enables FS to also RECEIVE translated audio back.
   Without it, the customer will never hear the Hindi translation.

3. **Chunk size matters** — Gemini needs ~100ms (1600 samples @16kHz) minimum. Sending 20ms
   FS frames (160 mu-law bytes = 320 samples after decode and upsample to 16kHz = 320 samples)
   directly will cause choppy/broken translation. Always accumulate in Translator.pending.

4. **PlayHead jitter buffer** — add 50ms jitter buffer (playHead = now + 0.05 if playHead < now)
   in agent UI. Without this, rapid chunks cause AudioContext scheduling errors and audio cuts out.

5. **One Gemini session = one direction** — do not try to share a session for both directions.
   Two sessions per call, always.

6. **Session cleanup on call drop** — FreeSWITCH closes the WS when the call ends. Make sure
   CallBridge.close() is called on WS close event, which must call translator.close() on both
   sessions. Leaked Gemini sessions = leaked API cost.

7. **echoTargetLanguage: false** — keep this false. If true and customer accidentally speaks
   English, FS will echo it back to them which sounds broken on a phone call.

---

## What is explicitly OUT OF SCOPE for this POC

- Multiple simultaneous calls (activeCalls map is there but not stress tested)
- Authentication on the WebSocket endpoints
- DTMF / IVR handling
- Recording or logging of audio
- Agent UI running on a separate machine (localhost assumptions throughout)
- Production FreeSWITCH hardening (ACLs, TLS, etc.)
