# Live Call Translation POC (Asterisk AudioSocket + Zoiper + Gemini)

Customer speaks **Hindi** into a softphone → a human **agent in the browser** hears live
**English**. Agent replies in English → customer hears live **Hindi**. Translation by
Gemini Live (`gemini-3.5-live-translate-preview`).

Media transport is **Asterisk AudioSocket** (free, natively full-duplex, raw PCM over TCP)
— not FreeSWITCH mod_audio_stream (whose two-way playback is commercial-only).

```
Customer (Zoiper 1000) --SIP/RTP--> Asterisk --AudioSocket(TCP 9092)--> Node bridge
                                                                          |   ^
                                                       hi->en translator  |   | en->hi translator
                                                                          v   |
                                                              Agent browser UI (mic + speakers)
```

The **agent is the browser UI**, not a second phone. Only one softphone is needed.

## Layout

- `bridge/` — Node bridge: AudioSocket TCP server + agent WebSocket + HTTP/UI host
- `agent-ui/index.html` — browser agent (mic capture + gapless playback + transcripts)
- `asterisk/` — `pjsip.conf`, `extensions.conf`, `docker-compose.yml`
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
# http on :8080 (agent ui + ws /agent)
```

## Step 2 — Start Asterisk

Edit `asterisk/pjsip.conf`: replace `<MAC_LAN_IP>` with your Mac's LAN IP (`ipconfig getifaddr en0`).

```bash
cd asterisk
docker compose up -d
docker compose exec asterisk asterisk -x "module show like audiosocket"   # expect res_/app_audiosocket
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

From Zoiper, dial **5000**. Bridge logs `call up: <uuid>`.

- Speak Hindi into Zoiper → agent browser hears English + sees transcripts.
- Speak English into the browser mic → Zoiper hears Hindi.

Hang up → bridge logs `closed, duration Ns`; `curl localhost:8080/health` shows
`activeCalls: 0`.

## Gotchas

- **Docker RTP/NAT (Mac):** Docker Desktop has no host networking. If SIP registers but
  there's no audio, the `external_media_address` in `pjsip.conf` is wrong/missing. If it
  still won't flow, run Asterisk in a Linux VM (multipass/UTM, bridged networking) instead.
  AudioSocket (TCP 9092 to the host) is unaffected.
- **One call at a time** — POC scope; a second concurrent call logs a warning.
- **Languages** configurable via `SRC_LANG`/`DST_LANG` in `.env` (BCP-47).

## Out of scope

Multiple simultaneous calls, WS auth, DTMF/IVR, recording, remote agent UI, Asterisk
hardening (TLS/ACL).
