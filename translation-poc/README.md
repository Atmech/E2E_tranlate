# Asterisk call translation POC

Both the caller and the human agent are connected to Asterisk. Asterisk opens two
WebSockets to the Node backend's `/media` endpoint, one per participant. Node pairs
them by `CALL_ID` and uses a separate Gemini Live translator for each direction:

```text
Caller microphone -> caller WebSocket -> Hindi to English -> agent WebSocket -> agent hears English
Agent microphone  -> agent WebSocket  -> English to Hindi -> caller WebSocket -> caller hears Hindi
```

Each socket is bidirectional. Input is that participant's microphone; output is
translated speech from the other participant. The native path uses no browser
agent and no `relay.js`. Audio is raw signed 16-bit little-endian mono PCM at 8kHz
(`slin`), with 320 bytes per 20ms frame.

## Start the backend

```bash
cp .env.example .env       # fill in GEMINI_API_KEY; do not overwrite an existing .env
npm install
npm start
```

Set `MEDIA_MODE=translation` (default). `MEDIA_SOURCE_LANG` and `MEDIA_TARGET_LANG`
are no longer used: each connection must provide its languages. The existing Gemini
Live model performs transcription and translated speech generation; this is not a
separate Google Cloud Streaming STT service. `npm run smoke` checks model access.

## Connection contract for Rajiv bhai

Connect both participants to `wss://<app-domain>/media` using the WebSocket
subprotocol `media`. Use JSON control messages (`f(json)` on Asterisk). Set the four
variables on the corresponding WebSocket channel before Asterisk emits its
`MEDIA_START`, so they appear in `channel_variables`.

Caller example (other standard Asterisk event fields may also be present):

```json
{
  "event": "MEDIA_START",
  "connection_id": "translation_media",
  "format": "slin",
  "optimal_frame_size": 320,
  "ptime": 20,
  "channel_variables": {
    "CALL_ID": "abc123",
    "ROLE": "caller",
    "SOURCE_LANG": "hi",
    "TARGET_LANG": "en"
  }
}
```

Agent uses the same event format, with:

```json
"channel_variables": {
  "CALL_ID": "abc123",
  "ROLE": "agent",
  "SOURCE_LANG": "en",
  "TARGET_LANG": "hi"
}
```

- Use a unique `CALL_ID` for each phone conversation, identical on its two sockets.
  Allowed characters: letters, digits, underscore, dot, colon and hyphen; 1–128 characters.
  `connection_id` is transport metadata, not the pairing key.
- Roles must be exactly `caller` and `agent`. Languages must be reciprocal, as above.
  Language codes must be supported by the configured model.
- Either participant can connect first. The backend waits up to 30 seconds for the
  other, then up to 30 seconds for both translators to start.
- Audio arriving before `translation ready` is dropped and counted at hangup.
  Start speaking after readiness during testing. There is no custom readiness
  control message sent to Asterisk.
- A missing/invalid field or duplicate role rejects that new connection.
  Concurrent native translation calls are supported: each unique `CALL_ID` owns
  two sockets and two independent translators. Calls share the server's resources
  and Gemini account limits; no concurrent-call capacity has been load-tested.
- If either participant disconnects, startup times out, or a translator fails,
  both sockets and translators close. Reconnecting requires a fresh pair.
- `MEDIA_XOFF` pauses output only to that participant; `MEDIA_XON` resumes it.
  Queued output is bounded to 30 seconds and a slow WebSocket send buffer to five
  seconds; exceeding either ends the call rather than accumulating audio indefinitely.

Rajiv bhai's Asterisk routing must send each participant's microphone separately,
play returned audio only to that participant, and exclude translated playback from
microphone input. Pairing in Node does not configure Asterisk bridges or isolate
mixed audio automatically.

## DigitalOcean deployment and call test

Deploy this code with `MEDIA_MODE=translation` and the existing Gemini API key/model.
Use **one running app instance**: pairing is stored in process memory. Multiple
instances or a rolling deployment can split the two sockets; wait until deployment
is complete before testing. Restarting the process ends active calls.

1. Rajiv bhai connects both participant channels with the metadata above.
2. Runtime Logs should show `joined role=caller`, `joined role=agent`, then
   `translation ready: caller->agent and agent->caller` for the same call ID.
3. Caller speaks Hindi: logs show `[stt <id> caller]` and
   `[translation <id> caller->agent]`; only the agent should hear English.
4. Agent speaks English: the caller should hear Hindi. Check that neither party
   hears their own translated voice and translated playback does not start another
   translation cycle.
5. Hang up either side: both sockets close; `/health` returns `activeCalls: 0`.
   Repeat with another call to check cleanup. Also run two calls simultaneously
   with different `CALL_ID`s: verify each participant hears only their own peer's
   translation, then end one call and confirm the other continues in both directions.

The `/media` endpoint remains unauthenticated in this POC. Call IDs identify sessions;
they are not credentials. Production authentication and multi-instance routing are
outside this change.

## Automated checks

```bash
npm test                    # offline regressions; fake translators, no network/API key
npm run test:media-ws        # real localhost WebSockets, fake translator; no Asterisk/Gemini
npm run test:monitor-http    # real localhost HTTP: auth, SSE, logout and session expiry
npm run smoke:asterisk-ws    # existing real Asterisk single-connection transport smoke
```

The offline tests cover opposite-side audio routing, either connection order,
metadata rejection, startup/hangup races, model failures, flow control and cleanup.
They also cover monitor authentication, rate limits, sanitized failure causes,
bounded history and native-call telemetry.
The localhost test negotiates `media` and exchanges real WebSocket frames through
the native handler. Its deterministic fake model verifies routing, not language quality.

For `smoke:asterisk-ws`, start the Docker setup in `asterisk/` and stop `npm start`
first: the script owns port 8080. It makes two sequential calls through `5000@demo`,
using Asterisk Echo and an injected audio source. This is a single-connection
transport check, not a paired call or live translation check.

The bundled `5000` dialplan does not set the four pairing fields. Use it for the
transport smoke or loopback test; a paired phone test requires Rajiv bhai's two-leg
Asterisk routing and metadata. Local Asterisk was previously verified at 22.9.0.

## Temporary phone loopback test

Set `MEDIA_MODE=loopback` and restart. This echoes binary PCM to the same socket
without Gemini. It needs a valid `MEDIA_START` but not the four pairing fields;
plain-text and JSON control events work for loopback. Only one connection is allowed.
During `MEDIA_XOFF`, input is discarded rather than queued.

Use a normal phone call, not Asterisk Echo, to avoid repeated echoes. Restore
`MEDIA_MODE=translation` and restart for paired translation. `MEDIA_LOOPBACK=true`
is supported only when `MEDIA_MODE` is unset; explicit `MEDIA_MODE` takes precedence.

## Private Call Monitor

Open `/monitor` to see active calls, participant and translator status, audio
activity, playback queues, recent issues, and per-call event timelines. Native
paired calls, the legacy browser flow, and loopback calls are included. Rejected
connections appear in the issue feed even when no valid call ID was supplied.
The monitor is read-only and does not create a browser-agent audio connection.

Use the summary cards to filter ongoing, waiting, attention-needed, or failed
calls. Search by call ID or language name; **Clear filters** restores all calls.
Select a call to open **Conversation**, **Health**, and **Events** tabs. Conversation
follows new speech while you are at the bottom; scroll up to read earlier text.
The **Connection guide** explains how to start a paired call when the list is empty.

**Access is disabled by default.** There is no default username or password.
Leave the monitor settings blank until you are ready to configure access; all
monitor routes return 503 in that state, while calls continue normally.

### Set credentials later

1. From `translation-poc`, run `npm run monitor:password`. Enter and confirm a
   password of at least 14 characters. Input is hidden; the command prints only
   the salted scrypt hash. Do not pass a password as a command-line argument.
2. Set the following in your deployment's secret environment settings, or your
   existing local `.env` (do not overwrite the rest of that file):

   ```dotenv
   MONITOR_USERNAME=your-chosen-username
   MONITOR_PASSWORD_HASH=scrypt-v1:...paste-the-generated-hash...
   MONITOR_ORIGIN=https://your-app.example.com
   MONITOR_TRUST_PROXY=true
   ```

   `MONITOR_ORIGIN` is the exact public origin, including a nonstandard port if
   needed, with no path or trailing slash. HTTPS is required for remote access.
   The current Node server serves HTTP; use your platform's HTTPS reverse proxy.
   Set `MONITOR_TRUST_PROXY=true` **only** when that proxy overwrites
   `X-Forwarded-Proto` and the backend cannot be reached directly from the public
   internet. Keep it false for a direct TLS server.
3. Restart the backend, visit `https://your-app.example.com/monitor`, and sign in.

For local development, use `MONITOR_ORIGIN=http://localhost:8080` and
`MONITOR_TRUST_PROXY=false`, and open that exact host/port. This HTTP exception
accepts only loopback client connections. It does not enable HTTP access over LAN.

### Access and retention

- The page, application JavaScript, snapshot API and SSE live stream require a
  valid session. Only the sign-in page and its static assets are public once
  configuration is valid. Monitor files are outside the legacy public UI folder.
- Sessions are random, stored server-side, and expire after eight hours. Cookies
  are `HttpOnly`, `SameSite=Strict`, scoped to `/monitor`, and `Secure` for HTTPS.
  Logout revokes the session and its live streams. Restarts invalidate all sessions.
- Login accepts five attempts per socket IP and thirty globally per fifteen
  minutes, including successful logins. Forwarded client IP headers are ignored;
  users behind the same proxy may share the lower limit. Password verification
  is serialized to bound its CPU/memory cost. No password is logged or returned.
- The monitor checks the configured host and origin, rejects cross-origin writes,
  disables caching and framing, and uses a restrictive content security policy.
  Session controls follow the [OWASP session management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
- History is **in memory**: up to 200 ended calls for up to 24 hours, 100 events
  per call, and 200 recent issues. Speech and translation text are limited to
  400 segments or 64,000 characters per call; older segments are omitted when
  that limit is reached. The page shows the latest 30 issues. History resets on
  restart; it is not a durable audit log. Use one backend instance.
- The monitor retains call IDs, languages, counters, timestamps, safe error
  categories, recognized speech text and translated text. Speech text is fetched
  only for the selected call through an authenticated endpoint; it is not sent
  to every live viewer in the all-calls stream. Audio, raw provider errors and
  credentials are not captured. Existing server console logging is unchanged.
- Audio activity may be silence. Status does not prove translation quality or
  audio delivery at the far endpoint. A lost live stream marks the page as stale.
  Legacy translator errors are reported without adding automatic call termination.
- Select a call and choose **Export .txt** to download its current status, direction
  details, counters, event timeline, retained issues, recognized speech and
  translations. The export excludes audio and cannot include history already lost
  to a restart or retention limit. Treat downloaded files as sensitive call data.

Monitor authentication protects `/monitor` and its subroutes. The existing
`/media`, `/agent`, `/audiosocket`, TCP AudioSocket and legacy browser demo retain
their existing access behavior; call-ingress authentication is a separate change.

## Legacy browser demo

The older caller-phone to browser-agent flow remains on AudioSocket TCP port 9092
or `/audiosocket` via `relay.js`. Register Zoiper as extension 1000, open
`http://localhost:8080/` for the browser agent, and dial **5001**. Set
`CUSTOMER_LANG` and `AGENT_LANG` for this legacy flow. Browser audio cannot attach
to a native paired call.

For Docker SIP/RTP on Mac, set `external_media_address` and
`external_signaling_address` in `asterisk/pjsip.conf` to the Mac's LAN IP before
starting `docker compose up -d` in `asterisk/`.

Protocol reference: [Asterisk native media WebSocket](https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket/).

## Output playback clock

Native paired calls and legacy AudioSocket playback share `OutputPacer`. Normal
playback submits one 20ms frame per callback. A late callback can recover up to
four extra queued audio frames (five frames / 100ms total). If the stall exceeds
that limit, audio runs out, or writes overrun the next deadline, the scheduler
re-anchors to the current time plus 20ms. Recovery preserves sample order and
does not discard speech. It does not recover an arbitrarily large backlog.

Catch-up never adds silence or pads an incomplete tail before its normal
commit/timeout. `MEDIA_XOFF` / `MEDIA_XON` transitions suppress catch-up on the
next callback, even if both events occur between ticks. A sampled blocked socket
also resumes with a single frame. Queued speech remains available after a pause.
The constructor option `maxCatchUpFrames` defaults to 4; 0 disables recovery.
No environment-variable changes are required.

Periodic playback samples and hangup statistics include:

- `recoveredFrames`: extra audio frames submitted during scheduler catch-up.
- `schedulerResyncs`: clock re-anchors, including flow control and occasions when
  the available audio or catch-up limit cannot service every missed deadline.
- `maxSchedulerLatenessMs`: largest callback delay relative to its scheduled time.

Before increasing concurrency, repeat the five-call / five-minute phone test and
compare each direction's `queuedMs`, `inputAudioMs`, `submittedAudioMs`,
`delayedTicks`, `observedBlockedMs`, and the new counters. Check that speech stays
intact and scheduling-related backlog does not keep climbing. Measure heard
delay at the receiving endpoint too: pacer submission is not proof of playback
or end-to-end translation latency. The offline clock regression simulates ten
directions with shared stalls; it does not measure Asterisk or Gemini capacity.

## Gemini connection recovery for long calls

Each translation direction keeps its own logical Gemini session across WebSocket
rotations. The translator enables `sessionResumption` and sliding-window context
compression, saves the latest resumable handle, and reconnects on `GoAway`, socket
error/close, or a synchronous send failure. This follows Google's
[Live API session management](https://ai.google.dev/gemini-api/docs/live-api/session-management).
No environment-variable changes are required.

Every connection must receive `setupComplete` within five seconds before audio
is sent. Recovery closes the previous SDK session before opening a replacement;
callbacks from replaced sockets are ignored. It tries resumption up to three
times, then one fresh session. The fresh fallback logs a warning because it resets
translation context. Exhausted recovery or buffer overflow reports terminal
failure through the existing call teardown path.

During recovery, telephone media continues and the translator buffers up to ten
seconds of PCM per direction (320,000 bytes), with a separate 1,000-message bound.
Buffered speech drains in order faster than real time while new speech joins
behind it: 1.5x below 500ms queued, 2x from 500ms, and 4x from 2000ms. These
rates describe local send pacing; event-loop delays can reduce actual throughput.
Once the queue empties, live input returns immediately to direct sending.
Synthetic PTT release silence pauses until that backlog drains, then continues
in real time. Speech already sent to a lost connection is not replayed locally,
so recovery does not guarantee lossless or duplicate-free audio at the handoff.

Logs include call ID, direction, reconnect count, queue high-water marks, and
backlog-drained events. Fatal errors record queue state before cleanup, and
transport errors retain available error/status and WebSocket close codes.
`Translator.getStats()` exposes recovery and queue counters for consumers; these
counters are not yet displayed in the monitor UI. `catchupMs` includes time spent
waiting for reconnection, and `maxQueuedMs` is the lifetime high-water mark.

Optional recovery settings (defaults require no `.env` changes):

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_RECONNECT_BUFFER_SECONDS` | `10` | Queued PCM limit, 1–60 seconds |
| `GEMINI_RECONNECT_MAX_MESSAGES` | `1000` | Queue message limit, 100–10000 |
| `GEMINI_CONNECT_TIMEOUT_MS` | `5000` | Setup timeout, integer 1–60000 ms |
| `GEMINI_RESUME_ATTEMPTS` | `3` | Resumption attempts before fresh fallback, 0–10 |
| `GEMINI_CATCHUP_FACTOR_LOW` | `1.5` | Drain multiplier below the medium threshold |
| `GEMINI_CATCHUP_FACTOR_MEDIUM` | `2` | Drain multiplier at the medium threshold |
| `GEMINI_CATCHUP_FACTOR_HIGH` | `4` | Drain multiplier at the high threshold |
| `GEMINI_CATCHUP_MEDIUM_MS` | `500` | Medium queue threshold |
| `GEMINI_CATCHUP_HIGH_MS` | `2000` | High queue threshold |
| `GEMINI_MIN_DRAIN_DELAY_MS` | `2` | Minimum interval between queued sends |

Factors must be finite, greater than 1, at most 10, and ordered low ≤ medium ≤ high.
Thresholds must be positive and finite, with medium < high. Minimum drain delay
must be finite, at least 1ms, and less than `GEMINI_CHUNK_SAMPLES / 16` milliseconds;
otherwise startup fails because catch-up cannot outrun continuous full-chunk input.

`npm test` includes deterministic recovery tests for setup races, retries,
fallback, stale callbacks, catch-up during continuous input, sample order, invalid
timing settings, transport diagnostics, hangup, and four rotations across ten
independent translator directions. These use fake Gemini sessions and do not
prove live model compatibility or phone-call quality.

Before deployment acceptance, repeat five concurrent 30-minute phone calls using
the configured model. Verify both directions continue through multiple `GoAway`
events, logs show `ready resumed=true`, and healthy rotations do not produce
`Translator failed` or fresh-fallback warnings. Speak across each handoff and
check for missing/repeated words, audible gaps, and accumulated delay, alongside
the playback queue and pacing counters above. Confirm the reconnect input queue
returns to zero without shifting persistent delay into translated playback, and
check translation quality while accelerated input is sent. Also test hangup during recovery.

## Legacy browser demo latency tuning

These browser/PTT settings apply to the legacy AudioSocket demo. Open the agent
page and wait for it to connect before placing that demo call.

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
