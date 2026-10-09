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
npm ci --ignore-scripts
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

The `/media` endpoint retains its existing unauthenticated connection contract.
Call-ingress authentication is deferred to a coordinated release; call IDs are not
credentials. Multi-instance routing remains unsupported.

## Automated checks

```bash
npm test                    # offline regressions; fake translators, no network/API key
npm run test:media-ws        # real localhost WebSockets, fake translator; no Asterisk/Gemini
npm run test:ws-hardening    # real bridge: malformed traffic cannot crash healthy connections
npm run test:monitor-http    # real localhost HTTP: auth, SSE, logout and session expiry
npm run smoke:asterisk-ws    # existing real Asterisk single-connection transport smoke
```

The offline tests cover opposite-side audio routing, either connection order,
metadata rejection, startup/hangup races, model failures, flow control and cleanup.
They also cover monitor authentication, rate limits, sanitized failure causes,
bounded history and native-call telemetry.
The localhost test negotiates `media` and exchanges real WebSocket frames through
the native handler. Its deterministic fake model verifies routing, not language quality.

WebSocket messages are limited to 64 KiB for `/agent`, 128 KiB for the legacy
`/audiosocket` relay, and 65,500 bytes for `/media`. Limits apply to the complete
message, including fragmented messages. Oversized messages close that connection.
The hardening check starts isolated bridge processes with a dummy API key and
loopback media; it sends invalid upgrade URLs, invalid protocol frames, and oversized
messages while checking that an existing media connection continues passing audio.

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
  credentials are not captured. Console transcript logging is disabled by default (`LOG_TRANSCRIPTS=false`).
- Audio activity may be silence. Status does not prove translation quality or
  audio delivery at the far endpoint. A lost live stream marks the page as stale.
  Terminal legacy translator errors end the call and release resources.
- Select a call and choose **Export .txt** to download its current status, direction
  details, counters, event timeline, retained issues, recognized speech and
  translations. The export excludes audio and cannot include history already lost
  to a restart or retention limit. Treat downloaded files as sensitive call data.

Monitor authentication protects `/monitor` and its subroutes. Native media, legacy
browser and AudioSocket endpoints retain their existing access behavior.

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
Close confirmation and backoff reduce potential overlap; they are not proof that
GoAway caused dashboard 409 counts. Validate against the same live test window.
Playback backlog trimming remains disabled, preserving queued speech.

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

Initial setup must receive `setupComplete` within five seconds before audio
is sent. Recovery shares a deadline across all attempts, reserving 250ms of headroom
below the smaller audio-byte or message-count buffer budget. Each attempt gets its
share of the remaining deadline, capped by `GEMINI_CONNECT_TIMEOUT_MS`, so fresh
fallback is attempted before continuous input fills the buffer. Recovery requests closure of the previous SDK session and waits for its close event
before opening a replacement. The wait is bounded by `GEMINI_CLOSE_WAIT_MS` and
the remaining recovery budget; a missing acknowledgement is logged and does not
block recovery forever. Callbacks from replaced sockets cannot affect the new session.
Resume attempts use 500/1000/2000ms backoff plus up to 250ms jitter, shortened when
necessary to reserve setup time and later attempts within the same audio-buffer
deadline. Telephone hangup cancels these waits. It tries resumption up to three
times, then one fresh session without an additional backoff. The fresh fallback logs a warning because it resets
translation context. Exhausted recovery or buffer overflow reports terminal
failure through the existing call teardown path.

During recovery, telephone media continues and the translator buffers up to thirty
seconds of PCM per direction (960,000 bytes), with a separate 3,000-message bound.
Buffered speech drains in order faster than real time while new speech joins
behind it: 1.5x below 500ms queued, 2x from 500ms, and 4x from 2000ms. These
rates describe local send pacing; event-loop delays can reduce actual throughput.
Catch-up sends bounded bursts targeting 160ms of audio, capped at eight messages
per callback (normally four 40ms chunks), then paces the entire burst at the
applicable catch-up factor. Once the queue empties, live input returns immediately
to direct sending.
Synthetic PTT release silence pauses until that backlog drains, then continues
in real time. Speech already sent to a lost connection is not replayed locally,
so recovery does not guarantee lossless or duplicate-free audio at the handoff.

Logs include call ID, direction, reconnect count, queue high-water marks, and
backlog-drained events. Fatal errors record queue state before cleanup, and
transport errors retain available error/status and WebSocket close codes.
`Translator.getStats()` exposes recovery and queue counters for consumers; these
counters are displayed in the monitor Health tab and exports. `catchupMs` includes time spent
waiting for reconnection, and `maxQueuedMs` is the lifetime high-water mark.

Burst diagnostics (`drainBursts`, `maxDrainBurstMessages`, `maxDrainBurstMs`)
are available in translator stats and fatal/backlog-drained logs.

Existing environment overrides take precedence: remove or update old chunk-size
and reconnect-limit overrides when testing these defaults.

### Test-only speech gate

The gate is **off by default**. Enable it only in an isolated synthetic load-test
instance, never one serving real user calls: quiet speech below the peak threshold
can be discarded. Existing reconnect, burst catch-up, and cost accounting stay active.

```dotenv
LOAD_TEST_SPEECH_GATE=true
LOAD_TEST_SPEECH_GATE_THRESHOLD=128
LOAD_TEST_SPEECH_GATE_HANGOVER_MS=600
LOAD_TEST_SPEECH_GATE_LOG_INTERVAL_MS=60000
```

At 16kHz, an incoming frame with any sample magnitude at least 128 opens the gate.
It forwards subsequent silence for 600ms (rounded up to an incoming frame boundary),
then skips silent frames before they enter pending/reconnect queues. A remaining
partial Gemini chunk is flushed on the first skipped frame, preserving audio order.
The gate leaves the session connected and does not call `endInput()` or inject the
PTT synthetic tail at each silent gap. Explicit PTT release retains its existing
behavior. Threshold accepts integer 0–32767; hangover accepts 0–5000ms; log interval
accepts 1000–3600000ms. Threshold 0 forwards all frames.

Startup, periodic, and final logs identify the enabled test gate. Translator stats
include `speechGateInputMs`, `speechForwardedMs`, `silenceSkippedMs`, frame counts,
and forwarding/saving ratios. **Forwarded means admitted by the gate, not accepted
by Gemini or billed.** Existing cost counters separately track received audio,
SDK-accepted audio (including queued replay), and synthetic silence. The gate's
saved percentage describes source audio volume, not invoice savings.

First run 2 calls for 2 minutes with the low-speech WAVs. Check both translation
directions, quiet onsets/final words, skipped audio, submitted-audio counters, and
absence of translator failures. If final words are clipped, test a 1000ms hangover.
Then repeat 15 calls for 10 minutes to exercise session rotation. This reduced-audio
workload does not establish continuous-audio CPU capacity. Remove the flag or set
`LOAD_TEST_SPEECH_GATE=false` and restart to restore normal input forwarding.

Optional recovery settings (defaults require no `.env` changes):

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_RECONNECT_BUFFER_SECONDS` | `30` | Queued PCM limit, 1–60 seconds |
| `GEMINI_RECONNECT_MAX_MESSAGES` | `3000` | Queue message limit, 100–10000 |
| `GEMINI_CONNECT_TIMEOUT_MS` | `5000` | Setup timeout, integer 1–60000 ms |
| `GEMINI_CLOSE_WAIT_MS` | `1000` | Maximum close-acknowledgement wait, 0–5000 ms; capped by recovery budget |
| `GEMINI_RETRY_BASE_MS` | `500` | Base resume backoff, 0–5000 ms; exponential delay capped at 2000 ms before jitter and budget caps |
| `GEMINI_RETRY_JITTER_MS` | `250` | Maximum additional resume jitter, 0–5000 ms |
| `GEMINI_RESUME_ATTEMPTS` | `3` | Resumption attempts before fresh fallback, 0–10 |
| `GEMINI_CATCHUP_FACTOR_LOW` | `1.5` | Drain multiplier below the medium threshold |
| `GEMINI_CATCHUP_FACTOR_MEDIUM` | `2` | Drain multiplier at the medium threshold |
| `GEMINI_CATCHUP_FACTOR_HIGH` | `4` | Drain multiplier at the high threshold |
| `GEMINI_CATCHUP_MEDIUM_MS` | `500` | Medium queue threshold |
| `GEMINI_CATCHUP_HIGH_MS` | `2000` | High queue threshold |
| `GEMINI_MIN_DRAIN_DELAY_MS` | `2` | Minimum interval between queued bursts |
| `GEMINI_CATCHUP_BURST_TARGET_MS` | `160` | Audio target per burst, 20–1000 ms |
| `GEMINI_CATCHUP_BURST_MAX_MESSAGES` | `8` | Maximum messages per burst, integer 1–64 |

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
| `GEMINI_CHUNK_SAMPLES` | `640` | Gemini input batch size at 16kHz (640 = 40ms) |

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

## Connection compatibility and optional limits

This release requires no changes to the existing Asterisk connection configuration.
The `/media` URL, `media` subprotocol, JSON `MEDIA_START`, four pairing fields
(`CALL_ID`, `ROLE`, `SOURCE_LANG`, `TARGET_LANG`), and `slin` 8kHz mono PCM with
320-byte 20ms frames remain the same. No new credentials, tokens, or proxy settings
are required. Native, browser-agent, relay, and TCP AudioSocket endpoints remain
available, with the original bind behavior. Legacy browsers remain connected across
sequential calls.

Authentication and default heartbeat enforcement are deferred. Optional backend
limits `MAX_ACTIVE_CALLS`, `MAX_MEDIA_CONNECTIONS`, `MAX_UPGRADES_PER_MINUTE`,
and `WS_HEARTBEAT_MS` default to **0 (disabled)**. No new admission cap or pong
requirement is imposed unless the backend operator explicitly enables one. Measure
capacity and confirm the existing client's pong behavior before enabling them.
When limits are enabled, sockets waiting for metadata count toward the connection
cap, rate limits apply globally to upgrades, and existing calls can acquire their
missing peer at the call-count cap (subject to the socket cap). Disconnected sockets
release their slots. Playback and transport buffer bounds still protect the process.

## Audio and readiness checks

General Live models use `NO_INTERRUPTION` so continued source speech does not cut
off the interpreter's current translation. Explicit provider interruption events
clear the destination playback queue and filter state; native Asterisk receives
`FLUSH_MEDIA`, and browser playback is cancelled. Legacy TCP cannot retract audio
already submitted to Asterisk. Each translation direction owns a stateful 63-tap
low-pass downsampler, retaining history and phase across chunks (~1.3ms filter delay
at 24kHz). Speech-band gain, alias rejection, sample counts, and irregular chunks
are covered by regression tests.

The monitor shows reconnecting, catching-up, ready and failed states, input backlog
and its peak, reconnect counts, and context resets. Speech text stays within the
authenticated transcript endpoint; console transcript logging is opt-in.

```bash
npm test
npm run test:integration
npm audit --omit=dev
npm run smoke   # real provider: production config, setup acceptance, synthetic silence
```

CI runs offline regressions, real localhost media/HTTP/crash checks, and the
dependency audit on Node 22 with `npm ci`. The real-provider smoke is manual and
uses the actual Translator configuration; it fails on rejected setup, timeout,
or premature closure and always closes its session. The SDK is pinned to the
tested version in package.json; the lockfile pins transitive dependencies.

Production acceptance still requires five concurrent 30-minute paired phone calls
on the actual Asterisk routing and configured model, with speech through rotations,
flow-control pauses, and hangup during recovery. Record heard latency, gaps,
missing/repeated words, cross-call isolation, backlog drainage and resource
cleanup against agreed thresholds. Local fake-model tests and synthetic silence
are not evidence of phone audio quality or long-call capacity.

## Cost-analysis logs

The backend emits single-line JSON records prefixed `[gemini-cost]` at translator
start, approximately once per minute while input arrives, and once at shutdown.
Each record includes the actual configured model, UTC timestamp, call ID,
direction, languages, connection-attempt number, elapsed time, reconnect/fallback
counts, and cumulative audio durations in milliseconds:

- `inputReceivedMs`: phone audio accepted by this translator, including silence.
- `inputSubmittedMs`: audio accepted by the SDK send method, including replay of
  buffered input and synthetic tail silence. Failed send calls are not counted;
  successful SDK submission does not prove Google received or billed the audio.
- `syntheticInputSubmittedMs`: synthetic tail silence, already included in inputSubmittedMs.
- `outputReceivedMs`: audio received from Gemini (24kHz PCM), including audio in
  interrupted messages. It does not prove delivery or playback to the listener.
- `queuedInputMs` / `pendingInputMs`: unsent input remaining at snapshot time.
- `usageReports`: number of usage metadata messages received; zero means missing
  usage reports, not zero billed tokens.

`[gemini-usage]` logs each received usageMetadata report separately, with token
counts and modality breakdowns only. No transcript, audio payload, API key, or
resumption handle is included. Reports are not summed or differenced: reconcile
their semantics and actual model/SKU with Google billing before assigning a cost.
The connection-attempt number distinguishes rotations and fresh fallbacks.

For test analysis, export from before the first call through after the last call.
Use one `end` record per call ID/direction; sample records are cumulative and must
not be added to end records. Sum both directions' audio usage, but count each
phone call's elapsed duration only once. An abruptly terminated process may lack
end records; samples then provide partial coverage. Local counters exclude audio
that was discarded before reaching Translator (see startupDroppedBytes).

Audio-minute estimates can be calculated offline as submitted input minutes ×
the model's input rate + received output minutes × its output rate. These are
estimates, not invoices; pricing, context billing, credits, taxes, transcription,
and other services must be reconciled separately. Pricing reference:
https://ai.google.dev/gemini-api/docs/pricing

The `/monitor` dashboard also displays a combined **Estimated Gemini audio spend**
widget and per-call Health usage details. Estimates currently price only
`gemini-3.5-live-translate-preview` at $0.00525/input minute and $0.0315/output
minute (rates checked 2026-10-09). Unknown models are unpriced, missing measurements
are flagged, and missing token reports show “Not reported”. Token counts shown are
the latest report, not an accumulated bill. The estimate uses audio durations even
when token metadata is absent. Hosting, telephony, taxes and other API charges are
excluded. Rates should be reviewed when pricing changes.

The dashboard total covers all tracked translation calls **since this server
process started**, regardless of table filters. Completed-call totals survive
history pruning, but all totals reset on process restart/redeploy. This is not an
account-wide or historical billing ledger. Export server logs before redeploying
for reconciliation across runs; individual call exports include model, audio
minutes, latest token total, and combined estimated cost.
