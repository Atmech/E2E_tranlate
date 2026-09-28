# Live Call Translation POC (Asterisk WebSocket + Zoiper + Gemini)

Customer speaks **Hindi** into a softphone → a human **agent in the browser** hears live
**English**. Agent replies in English → customer hears live **Hindi**. Translation by
Gemini Live (`gemini-3.5-live-translate-preview`).

Media transport is **Asterisk native media WebSocket** (`chan_websocket`). Asterisk
connects directly to the bridge's `/media` endpoint; `relay.js` is not used.
Both sides exchange raw signed 16-bit little-endian mono PCM at 8kHz (`slin`).

```
Customer (Zoiper 1000) --SIP/RTP--> Asterisk --WebSocket /media--> Node bridge
                                                                          |   ^
                                                       hi->en translator  |   | en->hi translator
                                                                          v   |
                                                              Agent browser UI (mic + speakers)
```

The **agent is the browser UI**, not a second phone. Only one softphone is needed.

## Layout

- `bridge/` — Node bridge: native media WebSocket + agent WebSocket + HTTP/UI host;
  legacy AudioSocket TCP and relay WebSocket endpoints remain for comparison
- `agent-ui/index.html` — browser agent (mic capture + gapless playback + transcripts)
- `asterisk/` — SIP, dialplan, WebSocket client, and Docker Compose configuration
- `scripts/smoke-gemini.js` — verify Gemini model access **before** anything else

## Step 0 — Gemini smoke test (do this FIRST)

`gemini-3.5-live-translate-preview` is an **allowlist preview** — not enabled on every key.

```bash
cp .env.example .env          # add GEMINI_API_KEY
npm install
npm run smoke
```

- `OK` → model works, proceed.
- `FAIL ... 403 / NOT_FOUND` → preview not on your key. Set
  `GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001` in `.env` and re-run. That model is
  generally accessible; the bridge auto-switches to prompt-driven translation for it.

## Step 1 — Start the bridge

```bash
npm start
# audiosocket on :9092
# http on :8080 (agent ui + ws /agent + audiosocket ws /audiosocket + native ws /media)
```

## Step 2 — Start Asterisk

Edit `asterisk/pjsip.conf`: set `external_media_address` and
`external_signaling_address` to your Mac's LAN IP (`ipconfig getifaddr en0`).
Native media WebSocket requires Asterisk 20.16+, 21.11+, 22.6+, or 23+.
The local setup was verified with Asterisk 22.9.0.

```bash
cd asterisk
docker compose up -d
docker compose exec asterisk asterisk -x "module show like websocket"    # expect chan_websocket + res_websocket_client
docker compose exec asterisk asterisk -x "pjsip show endpoints"           # expect 1000
```

If your image stores configs elsewhere than `/etc/asterisk`, adjust the volume mounts.

## Step 3 — Open the agent UI

Browser → `http://localhost:8080/` → **Start mic** (allow mic permission). Dot turns green.

## Step 4 — Register Zoiper as the customer

```
Account type: SIP
Username: 1000
Password: 1234
Domain:   <MAC_LAN_IP>:5060
```

## Step 5 — Call

From Zoiper, dial **5000**. Bridge logs `[media] Asterisk WebSocket connected`, then
`[media] call up: <connection-id>` and the translators becoming ready.
Dial **5001** only if you want to compare the legacy AudioSocket connection.

- Speak Hindi into Zoiper → agent browser hears English + sees transcripts.
- Speak English into the browser mic → Zoiper hears Hindi.

Hang up → bridge logs `closed, duration Ns`; `curl localhost:8080/health` shows
`activeCalls: 0`.

## Temporary phone loopback test

Set the bridge's runtime environment variable `MEDIA_LOOPBACK=true` and restart or
redeploy it. The `/media` handler then echoes each received binary PCM message back
to the same Asterisk connection, without creating Gemini translation sessions.
Rajiv bhai should hear the original voice back on the phone with network delay.
The browser agent is not needed. Existing startup requirements, including the
configured API key, remain in place.

Use the same `/media` URL, `media` subprotocol, and `slin` codec. A valid `MEDIA_START`
is still required. Runtime Logs show `mode=loopback`, followed by received/sent byte
counts on the first audio packet and every 100 packets (about two seconds at 20ms).
Text control messages are never echoed. During Asterisk's `MEDIA_XOFF`, live echo
audio is discarded and counted as `droppedBytes`; sending resumes on `MEDIA_XON`.

For DigitalOcean, add the variable to the translation component's runtime environment
in Settings and let it redeploy after this code has been deployed. Set it to `false`
or remove it and redeploy to restore translation. Loopback is off by default.
Do not connect Asterisk's `Echo` application to this mode: use a normal phone call,
otherwise both sides can repeatedly echo the same audio.

## Gotchas

- **Docker RTP/NAT (Mac):** Docker Desktop has no host networking. If SIP registers but
  there's no audio, the `external_media_address` in `pjsip.conf` is wrong/missing. If it
  still won't flow, run Asterisk in a Linux VM (multipass/UTM, bridged networking) instead.
  The native media WebSocket connection to the host does not depend on SIP/RTP NAT.
- **One call at a time** — POC scope; a second concurrent call logs a warning.
- **Languages** configurable via `CUSTOMER_LANG`/`AGENT_LANG` in `.env` (BCP-47).

## Test the direct connection without a phone or Gemini

Start Asterisk using the Compose configuration above, and stop `npm start` if it is
running: the smoke test temporarily listens on the same port 8080.
From `translation-poc/`, run:

```bash
npm test
npm run smoke:asterisk-ws
```

The smoke test places two sequential real Asterisk calls through `5000@demo`, with
Asterisk's `Echo` application on the other leg. It sends known PCM from the bridge,
checks that Asterisk returns the exact samples over WebSocket, and checks cleanup
on both sides. It uses the production native media handler with a test audio source
in place of Gemini. This proves transport and call lifecycle, not translation quality.
After it exits, run `npm start` for the normal browser/Zoiper translation demo.

Connection sequence:

1. Dial 5000: Asterisk connects to `ws://host.docker.internal:8080/media` using the
   `translation` client in `asterisk/websocket_client.conf`.
2. Asterisk sends `MEDIA_START`; the bridge validates `slin`, 320-byte frames, and
   20ms packetization, reserves the single call, and starts the two translators.
3. Binary WebSocket messages carry raw PCM in both directions. Text events carry
   call metadata, DTMF, and playback flow control. Both plain-text and JSON control
   events are accepted. AudioSocket headers are never sent on this endpoint.
4. Translated audio uses the existing 20ms pacer with raw PCM output. Asterisk
   generates idle silence; `MEDIA_XOFF` pauses queue consumption until `MEDIA_XON`.
5. Hangup closes the socket, stops playback/translators, frees the call, and lets
   the same browser join the next call.

For a later hosted test, change the client's URI to `wss://<app-domain>/media` and
set `tls_enabled = yes`, keeping certificate and hostname verification enabled.
The app's HTTP ingress must route WebSocket upgrades to the bridge's HTTP port.
This is a local POC: the media endpoint is currently unauthenticated; access control
must be added before exposing it for unrestricted remote use.

Protocol/config reference: [Asterisk native media WebSocket](https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket/).

## Out of scope

Multiple simultaneous calls, WS auth, DTMF/IVR, recording, remote agent UI, Asterisk
hardening (TLS/ACL).

## Latency tuning for the Render POC

The bridge still runs on the existing free Render service. No hosting migration is
required for these changes. Open the agent page and wait for it to connect before
placing the demo call; this keeps initial service startup separate from call timing.

Optional environment variables (defaults apply without editing Render settings):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PACER_PREBUFFER_MS` | `80` | Amount of phone playback audio to buffer before starting |
| `PACER_MAX_WAIT_MS` | `120` | Maximum initial queue wait, also releases partial tails after an input gap |
| `PACER_END_GAP_MS` | `200` | Silence to bridge before returning to prebuffering |
| `AGENT_CHUNK_MS` | `20` | Browser mic batching; accepts 20, 40, or 100 |
| `GEMINI_CHUNK_SAMPLES` | `320` | Gemini input batch size at 16kHz (320 = 20ms) |

The pacer checks every 20ms, so a timeout is serviced on the next tick; a busy event
loop can delay it further. Short responses no longer depend on reaching a minimum
audio quantity or receiving a model turn-end. Final partial frames are zero-padded.
The smaller buffer favors responsiveness and may expose more gaps on slow delivery.
For a comparison with Google's documented 100ms input chunks, set
`AGENT_CHUNK_MS=100` and `GEMINI_CHUNK_SAMPLES=1600`. Increase the pacer buffer and
maximum wait together if recordings show repeated playback gaps. No setting can
make persistently slow model output both immediate and gapless.

Push-to-talk release sends remaining captured samples. With Live Translate, the bridge
then sends two seconds of synthetic silence in 100ms chunks before `audioStreamEnd`.
This addresses final words staying pending until the next input, reproduced with a
synthetic speech test against the preview model. Microphone audio stops on release;
only generated silence continues. A new press cancels the tail; hangup cancels it too.
General Live models send `audioStreamEnd` immediately after the captured samples.
The customer remains muted while the agent holds PTT, as in the original demo.
Queued browser audio is cancelled when the call ends or the connection closes.
A second concurrent phone call is rejected; sequential calls reuse the browser safely.

Diagnostics (no audio content):
- `[translator ...] setupMs`: Gemini connection setup.
- `firstInputToOutputMs`: first accepted input to first returned audio, once per
  session. Includes silence, source phrase duration, network and model delay; this
  is **not** an inference measurement or an end-to-end speech latency metric.
- `[pacer] playback stats` on hangup: maximum queued audio, maximum initial wait,
  audio frames, and silence-fill frames. Silence fills can include ordinary pauses.
- Browser console `[playback] maxQueuedMs` on hangup: maximum audio scheduled ahead
  of a newly received chunk. Queues are measured, not silently truncated.

Run offline regression tests with `npm test` (no Gemini calls). For the demo, test
short replies, long sentences, PTT release mid-batch, hangup during speech, and two
consecutive calls without refreshing. Compare the same phrases in both directions.
