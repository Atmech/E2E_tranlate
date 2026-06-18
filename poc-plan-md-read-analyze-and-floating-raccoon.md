# POC Plan: 2-Way Live Call Translation (Asterisk AudioSocket + Zoiper + Gemini)

## Context

Goal: prove a real-time speech translation bridge. Customer speaks Hindi into a
softphone; a human agent in a browser hears live English. Agent replies in English;
customer hears live Hindi. Powered by Gemini `gemini-3.5-live-translate-preview`.

The original `poc-plan.md` chose **FreeSWITCH + mod_audio_stream** for media. Research
killed that path for a free POC:

- mod_audio_stream **bidirectional playback is commercial-only** (v1.0.3+). The free
  module is send-only → customer would never hear the Hindi translation. **Hard blocker.**
- Its wire format is **L16 PCM** (not mu-law), playback is **JSON base64** (not raw
  binary), app is `uuid_audio_stream` via `bgapi` (not `audio_stream`), two-way is a
  `mixed`/`stereo` mix-type (not `two-way=true`). Plan was wrong on all four.

**Decision (user picked "alternative media path"):** switch media transport to
**Asterisk AudioSocket** — purpose-built, free, natively full-duplex, dead-simple TLV
protocol over TCP, raw SLIN PCM. Everything else (Gemini config, agent browser UI,
Zoiper) stays. Gemini API assumptions in the original plan were **verified correct**.

**Topology insight:** the "agent" is the **browser UI**, not a second Zoiper. Only ONE
softphone is needed (the customer, ext 1000). A single AudioSocket leg carries both
directions. This removes all G.711/mu-law code from the original plan.

```
Customer (Zoiper 1000) --SIP/RTP--> Asterisk --AudioSocket(TCP)--> bridge (Node)
                                                                      |   ^
                                                  hiToEn (Hindi->En)  |   | enToHi (En->Hindi)
                                                                      v   |
                                                            Agent browser UI (mic+speakers)
```

---

## Host setup (recommendation — user asked to advise)

- **Asterisk in Docker on the Mac** (`mlan/docker-asterisk` or equivalent, Asterisk 18+).
- **Bridge** runs natively on the Mac host (Node). Container reaches it at
  `host.docker.internal:9092`.
- **Agent UI** + **browser** on the Mac. **Zoiper** on the Mac or a phone on the same LAN.
- **SIP/RTP NAT caveat (Docker Desktop Mac has no host networking):** publish
  `5060/udp` and an RTP range (e.g. `10000-10100/udp`), and in `pjsip.conf` transport set
  `external_media_address` / `external_signaling_address` to the Mac's LAN IP so Asterisk
  advertises a reachable address in SDP. If RTP audio refuses to flow, fall back to a
  Linux VM (multipass/UTM) with bridged networking — simpler SIP media than Docker on Mac.
  AudioSocket itself (container→host TCP 9092) is unaffected by the RTP NAT issue.

---

## Repo structure to create (full build)

```
translation-poc/
├── asterisk/
│   ├── pjsip.conf            # transport + customer endpoint 1000
│   ├── extensions.conf       # dialplan: ext 5000 -> AudioSocket
│   └── docker-compose.yml    # Asterisk container, port mappings, conf mounts
├── bridge/
│   ├── package.json
│   ├── index.js              # TCP AudioSocket server + WS /agent + HTTP /health & UI
│   ├── CallBridge.js         # per-call orchestrator
│   ├── Translator.js         # one Gemini Live session (one direction)
│   ├── audiosocket.js        # TLV frame parse/build + 20ms output pacer
│   └── audio.js              # resample + base64 helpers (pure DSP)
├── agent-ui/
│   └── index.html            # browser agent: mic capture + gapless playback + transcripts
├── scripts/
│   └── smoke-gemini.js       # verify GEMINI_API_KEY + preview model access (one-shot)
├── .env.example
└── README.md
```

---

## Environment variables (.env)

```
GEMINI_API_KEY=your_key_here
BRIDGE_HTTP_PORT=8080         # health + agent WS + serves agent-ui
AUDIOSOCKET_PORT=9092         # TCP port Asterisk connects to
AGENT_WS_PATH=/agent
```

---

## Component 1 — audio.js (pure DSP, no mu-law anymore)

AudioSocket gives raw SLIN PCM, so all G.711 functions are **dropped**. Keep only:

- `resample(int16: Int16Array, inRate, outRate): Int16Array` — linear interp; fast-path
  return input when rates equal.
- `pcm8kTo16k(int16)` — upsample inbound 8k→16k for Gemini. Wraps `resample`.
- `pcm24kTo8k(int16)` — downsample Gemini 24k output → 8k for AudioSocket. Wraps `resample`.
- `int16ToB64(i16): string` / `b64ToInt16(b64): Int16Array` — agent-browser WS transport.
- `bufToInt16(buf: Buffer): Int16Array` / `int16ToBuf(i16): Buffer` — AudioSocket payload
  is **16-bit signed little-endian**; convert explicitly (`readInt16LE`/`writeInt16LE` or
  a guarded typed-array view) so it's correct on any host endianness.

**Audio format reference:**
- AudioSocket sends/receives: SLIN **PCM 16-bit LE, 8kHz, mono, 20ms = 320 bytes/frame**
  (type `0x10`).
- Gemini input: PCM 16-bit LE, 16kHz, mono, `audio/pcm;rate=16000`, ~100ms chunks.
- Gemini output: PCM 16-bit LE, 24kHz, mono, variable chunks.

**Conversion chains:**
- Inbound (Asterisk → Gemini): `0x10 payload → bufToInt16 → pcm8kTo16k → batch 1600 → feed`
- Outbound (Gemini → Asterisk): `b64 → 24k int16 → pcm24kTo8k → int16ToBuf → 320B frames`

---

## Component 2 — audiosocket.js (TLV framing + output pacer)

AudioSocket protocol (verified): TCP, frame = `[type:1][len:2 big-endian][payload:len]`.
Types: `0x00` hangup, `0x01` UUID (first frame, 16 binary bytes = callId), `0x03` DTMF,
`0x10` audio SLIN 8kHz (320B), `0xff` error.

- `createParser(onFrame)` — stateful byte accumulator; TCP frames can split/coalesce, so
  buffer across `data` events and emit complete frames only. `onFrame(type, payload)`.
- `buildAudioFrame(buf320): Buffer` — prefix `0x10` + uint16 length.
- `class OutputPacer` — Gemini returns audio in bursts; Asterisk wants a steady 20ms
  cadence or playback glitches. Pacer accumulates outbound 8k PCM and a `setInterval(20ms)`
  emits exactly one 320-byte frame per tick (silence/underrun = skip). This jitter buffer
  is the AudioSocket-side analog of the browser playHead buffer. **Not in original plan —
  required for clean call-side audio.**

---

## Component 3 — Translator.js (unchanged from original — Gemini API verified correct)

```
class Translator {
  constructor(targetLang, onAudio, onInputText, onOutputText)
  async start()   // ai.live.connect({ model: "gemini-3.5-live-translate-preview",
                  //   config: { responseModalities:["AUDIO"],
                  //     inputAudioTranscription:{}, outputAudioTranscription:{},
                  //     translationConfig:{ targetLanguageCode:this.targetLang,
                  //                         echoTargetLanguage:false } },
                  //   callbacks:{ onopen, onmessage, onerror, onclose } })
                  // onmessage: route serverContent.modelTurn.parts (audio b64) -> onAudio,
                  //   serverContent.inputTranscription.text  -> onInputText,
                  //   serverContent.outputTranscription.text -> onOutputText
  feed(int16_16k)  // accumulate; flush 1600-sample (100ms) chunks via
                   // session.sendRealtimeInput({audio:{data:b64, mimeType:"audio/pcm;rate=16000"}})
  close()
}
```

Two per call: `hiToEn` (targetLang `"en"`), `enToHi` (targetLang `"hi"`). One Gemini
session per direction — never share. `close()` both on call end (leaked sessions = cost).

---

## Component 4 — CallBridge.js

```
class CallBridge {
  constructor(callId)
  sock: net.Socket | null      // AudioSocket TCP connection (replaces fsWs)
  pacer: OutputPacer           // paces audio back to Asterisk
  agentWs: WebSocket | null
  hiToEn, enToHi: Translator

  async init()
  onCallAudio(buf320)          // 0x10 payload: bufToInt16 -> pcm8kTo16k -> hiToEn.feed
  onAgentAudio(b64pcm16k)      // b64ToInt16 -> enToHi.feed
  sendToAgent(pcm24)           // agentWs JSON {type:"audio",rate:24000,data:int16ToB64}; guard OPEN
  sendToCall(pcm24)            // pcm24kTo8k -> pacer.push (pacer emits 320B frames on sock)
  close()                      // close both translators, stop pacer, log duration
}
```

Wiring: `hiToEn.onAudio = sendToAgent`; `enToHi.onAudio = sendToCall`. Transcripts →
forward to agent UI over `agentWs`.

---

## Component 5 — index.js

- **TCP server** (`net.createServer`) on `AUDIOSOCKET_PORT`. Per connection: attach a
  parser. First `0x01` frame → callId → `new CallBridge`, `await init()`, store in
  `activeCalls`. `0x10` → `bridge.onCallAudio`. `0x00`/socket close → `bridge.close()`,
  delete. One call at a time for POC; warn on a second.
- **HTTP server** on `BRIDGE_HTTP_PORT`: `GET /health` → `{status:"ok",activeCalls}`;
  also static-serve `agent-ui/`.
- **WS `/agent`** (on the HTTP server): JSON only. `{type:"join"}` → link to the live
  bridge (single-call POC: whichever exists). `{type:"audio",data}` → `onAgentAudio`.
  Close → detach (call continues).

---

## Component 6 — agent-ui/index.html (mostly unchanged)

Single file, no build. Capture mic via AudioWorklet at 16kHz → 100ms chunks (1600 samp)
→ WS `{type:"audio",data:b64}`. Receive `{type:"audio",rate:24000,data}` → gapless
playback via 24kHz AudioContext with `playHead` + 50ms jitter buffer (pattern from
original plan §5). Do NOT connect capture node to destination (echo). `ctx.resume()`
after gesture. Transcript panel: input = customer Hindi, output = English.

---

## Component 7 — Asterisk config

**extensions.conf** — customer dials `5000` to enter the bridge:
```
[demo]
exten => 5000,1,Answer()
 same  => n,Set(UUID=${SHELL(uuidgen | tr -d '\n')})
 same  => n,AudioSocket(${UUID},host.docker.internal:9092)
 same  => n,Hangup()
```

**pjsip.conf** — transport + one endpoint (customer 1000):
```
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060
external_media_address=<MAC_LAN_IP>      ; needed behind Docker NAT
external_signaling_address=<MAC_LAN_IP>

[1000]
type=endpoint
context=demo
disallow=all
allow=ulaw
auth=1000
aors=1000
[1000]
type=auth
auth_type=userpass
username=1000
password=1234
[1000]
type=aor
max_contacts=1
```

**docker-compose.yml** — mount the two confs, publish `5060/udp` + RTP `10000-10100/udp`,
load modules `res_audiosocket`, `app_audiosocket`, `chan_pjsip`. Verify after boot:
`asterisk -x "module show like audiosocket"`.

---

## package.json

```json
{
  "name": "translation-poc",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node bridge/index.js",
    "dev": "node --watch bridge/index.js",
    "smoke": "node scripts/smoke-gemini.js"
  },
  "dependencies": {
    "@google/genai": "latest",
    "ws": "^8.16.0",
    "dotenv": "^16.0.0"
  }
}
```
(`express` dropped — Node `http` + `ws` is enough; AudioSocket is `net`, not HTTP.)

---

## Gemini preview-access smoke test (user unsure of access)

`scripts/smoke-gemini.js`: open one `ai.live.connect` to
`gemini-3.5-live-translate-preview`, send ~0.5s of silence PCM, confirm `onopen` + a
server message, print OK or the auth/permission error, exit. Run `npm run smoke` BEFORE
wiring a real call — fail fast if the preview model isn't enabled on the key.

---

## Build order (execution)

1. `scripts/smoke-gemini.js` + `.env.example` — confirm Gemini access first.
2. `audio.js` (resample/base64/LE buffer helpers) + `audiosocket.js` (parser, frame
   builder, OutputPacer).
3. `Translator.js` — confirm one-direction Hindi→English against the live model with a
   recorded PCM clip.
4. `CallBridge.js` + `index.js` — TCP + WS + HTTP wiring.
5. `agent-ui/index.html`.
6. `asterisk/` confs + `docker-compose.yml`, `package.json`, `README.md`.

---

## Verification (end-to-end)

1. `npm run smoke` → Gemini preview reachable.
2. `docker compose up` in `asterisk/`; `asterisk -x "module show like audiosocket"` shows
   both modules; `pjsip show endpoints` lists 1000.
3. `npm start` → logs `audiosocket on :9092`, `http on :8080`.
4. Open `http://localhost:8080/` (agent UI), Start mic, WS connects.
5. Zoiper registers as 1000 (pass 1234, domain = Mac LAN IP). Dial **5000**.
6. Bridge logs a new call (UUID frame). Speak Hindi into Zoiper → agent browser hears
   English + sees transcripts. Speak English in browser → Zoiper hears Hindi.
7. Hang up → bridge logs `close` + duration; both Gemini sessions closed; `activeCalls`
   back to 0; `/health` confirms.

---

## Gotchas (revised for AudioSocket)

1. **TCP framing** — AudioSocket frames split/coalesce across `data` events. The parser
   MUST buffer by declared length, not assume one frame per chunk.
2. **Output pacing** — emit 320-byte `0x10` frames on a steady 20ms timer, not as Gemini
   bursts arrive, or call-side audio glitches.
3. **Endianness** — SLIN is 16-bit LE; use `readInt16LE`/`writeInt16LE`, don't blindly
   cast a Buffer to Int16Array.
4. **100ms Gemini chunks** — accumulate in `Translator.pending`; never forward raw 20ms
   frames.
5. **One session per direction**; `close()` both on hangup (cost leak otherwise).
6. **echoTargetLanguage:false** — keep false.
7. **Docker RTP/NAT** — set `external_media_address`; if no audio, use a Linux VM instead.

## Out of scope
Multiple simultaneous calls, WS auth, DTMF/IVR, recording, remote agent UI, Asterisk
hardening (TLS/ACL).
