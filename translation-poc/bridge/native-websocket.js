// Asterisk chan_websocket: text control events + raw binary slin (8kHz PCM).
// No AudioSocket framing, relay process, or additional network hop.
//
// This build adds transport-close diagnostics only. The media/translation logic
// is preserved while recording transport events and local close requests.
// These observations help distinguish a triggering disconnect from peer-leg cleanup.
import { OutputPacer } from './audiosocket.js';
import { CallTranslationSession, readMediaMetadata } from './MediaTranslation.js';

const MODE = process.env.MEDIA_MODE || (process.env.MEDIA_LOOPBACK === 'true' ? 'loopback' : 'translation');
if (!['translation', 'loopback'].includes(MODE)) throw new Error('MEDIA_MODE must be translation or loopback');

const normalWsClose = code => code === 1000 || code === 1001;

function reasonText(reason) {
  if (!reason) return '';
  if (Buffer.isBuffer(reason)) return reason.toString('utf8');
  return String(reason);
}

function errorInfo(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    address: error.address,
    port: error.port,
  };
}

export function handleNativeConnection(ws, { activeCalls, agents = new Set(), createBridge,
  mode = MODE, createTranslator, setupTimeoutMs, monitor, maxCalls = Infinity }) {
  let bridge, callId, mediaRole, pacer, paused = false, ended = false;

  const connectedAt = Date.now();
  let mediaStartedAt = null;
  let lastRxAt = null;
  let lastTxAt = null;
  let lastControlAt = null;

  // Tracks whether OUR application deliberately requested a WebSocket close.
  // False means this handler did not request a close. It does not identify
  // the cause: the peer, proxy, network, or WebSocket library may be involved.
  let localCloseRequested = false;
  let localCloseSource = null;
  let localCloseCode = null;
  let localCloseReason = '';

  // Raw TCP observations. ws._socket is an internal property of the "ws"
  // package, so every use is guarded. It is diagnostic-only.
  let tcpEnded = false;
  let tcpClosed = false;
  let tcpHadError = false;
  let tcpError = null;

  const stats = { receivedBytes: 0, sentBytes: 0 };

  const label = () =>
    `${callId || 'before MEDIA_START'}${mediaRole ? ` role=${mediaRole}` : ''}`;

  const tcp = ws?._socket;

  const snapshot = () => {
    const now = Date.now();
    return {
      callId: callId || null,
      role: mediaRole || null,
      mode,
      wsReadyState: ws.readyState,
      wsBufferedAmount: ws.bufferedAmount,
      connectedMs: now - connectedAt,
      mediaMs: mediaStartedAt === null ? null : now - mediaStartedAt,
      lastRxAgoMs: lastRxAt === null ? null : now - lastRxAt,
      lastTxAgoMs: lastTxAt === null ? null : now - lastTxAt,
      lastControlAgoMs: lastControlAt === null ? null : now - lastControlAt,
      receivedBytes: stats.receivedBytes,
      sentBytes: stats.sentBytes,
      paused,
      ended,
      localCloseRequested,
      localCloseSource,
      localCloseCode,
      localCloseReason,
      activeCalls: activeCalls.size,
      tcpEnded,
      tcpClosed,
      tcpHadError,
      tcpError,
      tcp: tcp ? {
        destroyed: tcp.destroyed,
        readable: tcp.readable,
        writable: tcp.writable,
        bytesRead: tcp.bytesRead,
        bytesWritten: tcp.bytesWritten,
        remoteAddress: tcp.remoteAddress,
        remotePort: tcp.remotePort,
        localAddress: tcp.localAddress,
        localPort: tcp.localPort,
      } : null,
    };
  };

  const markLocalClose = (source, code, reason) => {
    // Preserve the FIRST local close request; it is the useful causal signal.
    if (localCloseRequested) return;
    localCloseRequested = true;
    localCloseSource = source;
    localCloseCode = code;
    localCloseReason = reasonText(reason);
    console.log(`[media-diag ${label()}] local WebSocket close requested`, snapshot());
  };

  const closeWs = (source, code = 1000, reason) => {
    markLocalClose(source, code, reason);
    // Preserve existing ws.close behavior, including thrown errors.
    ws.close(code, reason);
  };

  const sock = {
    get destroyed() { return ended || ws.readyState !== 1; },
    get writable() { return !ended && !paused && ws.readyState === 1; },

    write(pcm) {
      if (!this.writable) return;
      if (ws.bufferedAmount > 16000 * 5)
        return fail('WebSocket send buffer exceeded five seconds');

      stats.sentBytes += pcm.length;
      lastTxAt = Date.now();
      bridge?.onTransport?.({
        sentBytes: stats.sentBytes,
        lastSentAt: lastTxAt,
      });

      ws.send(pcm, { binary: true });
    },

    flushPlayback() {
      if (ws.readyState !== 1 || ended) return;
      ws.send(JSON.stringify({ command: 'FLUSH_MEDIA' }));
      paused = false; pacer?.resetClock(); bridge?.onPause?.(false);
    },
    end(code = 1000, reason) {
      if (ended) return;
      markLocalClose('sock.end', code, reason);
      cleanup();
      closeWs('sock.end', code, reason);
    },
  };

  const cleanup = (reason, failed = false) => {
    if (ended) return;
    ended = true;
    clearTimeout(startTimer);

    bridge?.close(reason, failed);

    if (bridge && activeCalls.get(callId) === bridge)
      activeCalls.delete(callId);

    console.log(`[media] closed ${callId || 'before MEDIA_START'}`, stats);
  };

  const fail = (reason) => {
    if (ended) return;

    console.warn(`[media] ${reason}`);
    if (!bridge) monitor?.event(null, 'error', reason);

    // Mark this BEFORE cleanup(). cleanup may cause the session/leg to call
    // sock.end(), and we want the original cause preserved as "fail".
    markLocalClose('fail', 1008, reason);
    cleanup(reason, true);
    closeWs('fail', 1008, reason);
  };

  // Temporary debugging window for Asterisk MEDIA_START (normally 5000ms).
  const startTimer = setTimeout(() => fail('MEDIA_START timeout'), 30000);
  startTimer.unref?.();

  // ----- Raw TCP diagnostics -------------------------------------------------
  // These do not modify socket behavior; they only record how the transport dies.
  if (tcp?.on) {
    tcp.on('end', () => {
      tcpEnded = true;
      console.warn(`[media-diag ${label()}] TCP end received (peer/proxy sent FIN)`, snapshot());
    });

    tcp.on('error', error => {
      tcpError = errorInfo(error);
      console.error(`[media-diag ${label()}] TCP error`, {
        ...errorInfo(error),
        ...snapshot(),
      });
    });

    tcp.on('close', hadError => {
      tcpClosed = true;
      tcpHadError = !!hadError;
      console.warn(`[media-diag ${label()}] TCP close`, {
        hadError: !!hadError,
        ...snapshot(),
      });
    });

    tcp.on('timeout', () => {
      console.warn(`[media-diag ${label()}] TCP timeout event`, snapshot());
    });
  }

  ws.on('message', async (data, isBinary) => {
    if (ended) return;

    try {
      if (isBinary) {
        if (!bridge) return fail('Audio before MEDIA_START');
        if (data.length % 2) return fail('PCM must contain complete 16-bit samples');

        stats.receivedBytes += data.length;
        lastRxAt = Date.now();

        bridge.onTransport?.({
          receivedBytes: stats.receivedBytes,
          lastInputAt: lastRxAt,
        });

        bridge.onCallAudio(data);
        return;
      }

      lastControlAt = Date.now();

      const text = data.toString().trim();
      let event;

      if (text.startsWith('{')) {
        event = JSON.parse(text);
      } else {
        const [name, ...fields] = text.split(/\s+/);
        event = { event: name };

        for (const field of fields) {
          const colon = field.indexOf(':');
          if (colon > 0)
            event[field.slice(0, colon)] = field.slice(colon + 1);
        }
      }

      if (event.event === 'MEDIA_START') {
        if (bridge) return fail('Duplicate MEDIA_START');

        if (event.format !== 'slin' ||
            Number(event.optimal_frame_size) !== 320 ||
            (event.ptime !== undefined && Number(event.ptime) !== 20)) {
          return fail('Expected slin 8kHz mono with 320-byte 20ms frames');
        }

        if (!event.connection_id)
          return fail('Missing connection_id');

        if (mode === 'translation') {
          let metadata;

          try {
            metadata = readMediaMetadata(event.channel_variables);
          } catch (error) {
            return fail(error.message);
          }

          // Set identity BEFORE session setup so every failure/close diagnostic
          // from this point includes CALL_ID and role.
          callId = metadata.callId;
          mediaRole = metadata.role;
          mediaStartedAt = Date.now();

          let session = activeCalls.get(metadata.callId);

          if (session && !(session instanceof CallTranslationSession))
            return fail('CALL_ID collision');

          if (!session) {
            if (activeCalls.size >= maxCalls) return fail('Call capacity reached');
            // Each CALL_ID owns an independent caller/agent pair and translators.
            session = new CallTranslationSession(metadata.callId, {
              createTranslator,
              setupTimeoutMs,
              monitor,
              onClose: () => {
                if (activeCalls.get(metadata.callId) === session) {
                  activeCalls.delete(metadata.callId);
                  console.log(
                    `[media ${metadata.callId}] session removed activeCalls=${activeCalls.size}`
                  );
                }
              },
            });

            activeCalls.set(metadata.callId, session);
            console.log(
              `[media ${metadata.callId}] new translation session activeCalls=${activeCalls.size}`
            );
          }

          pacer = new OutputPacer(sock, {
            encodeFrame: pcm => pcm,
            sendSilence: false,
          });

          try {
            bridge = session.addLeg(metadata, sock, pacer);
          } catch (error) {
            return fail(error.message);
          }

          clearTimeout(startTimer);

          console.log(
            `[media] call up: ${callId} role=${metadata.role} (slin 8000Hz, mode=translation)`
          );
          return;
        }

        if (activeCalls.size)
          return fail('Single-call POC is busy');

        clearTimeout(startTimer);

        callId = event.connection_id;
        mediaRole = mode === 'loopback' ? 'loopback' : 'native';
        mediaStartedAt = Date.now();

        if (mode === 'loopback') {
          // Temporary phone echo test: no Gemini sessions and no browser agent audio.
          let packets = 0;
          stats.droppedBytes = 0;

          const monitorId = monitor?.start(callId, 'loopback');
          monitor?.update(monitorId, { state: 'ready' });
          monitor?.leg(monitorId, 'caller', {
            connected: true,
            translator: 'not used',
          });

          bridge = {
            ready: false,
            async init() {},
            attachAgent() {},
            detachAgent() {},

            close(reason, failed) {
              monitor?.end(
                monitorId,
                reason || 'Loopback ended',
                failed
              );
            },

            onTransport(values) {
              monitor?.leg(monitorId, 'caller', values);
            },

            onPause(isPaused) {
              monitor?.leg(monitorId, 'caller', { paused: isPaused });
            },

            onCallAudio(pcm) {
              // During XOFF discard live echo input rather than accumulating delay.
              if (sock.writable) sock.write(pcm);
              else stats.droppedBytes += pcm.length;

              if (++packets === 1 || packets % 100 === 0)
                console.log(`[media] loopback ${callId} packets=${packets}`, stats);
            },
          };
        } else {
          pacer = new OutputPacer(sock, {
            encodeFrame: pcm => pcm,
            sendSilence: false,
          });

          // Injected audio source used by the transport-only smoke test.
          bridge = createBridge(callId, sock, { pacer });
        }

        activeCalls.set(callId, bridge);

        console.log(
          `[media] call up: ${callId} (slin 8000Hz, native WebSocket, mode=${mode})`
        );

        await bridge.init();

        if (ended) return;

        for (const agent of agents)
          bridge.attachAgent(agent);

      } else if (event.event === 'MEDIA_XOFF') {
        if (!paused)
          pacer?.resetClock();

        paused = true;
        bridge?.onPause?.(true);

      } else if (event.event === 'MEDIA_XON') {
        if (paused)
          pacer?.resetClock();

        paused = false;
        bridge?.onPause?.(false);

      } else if (event.event === 'DTMF_END') {
        console.log(`[media] dtmf ${callId}: ${event.digit}`);
      }

    } catch (error) {
      console.error('[media] connection failed:', error.message);
      console.error(`[media-diag ${label()}] message-processing exception`, {
        ...errorInfo(error),
        ...snapshot(),
      });
      fail('Media setup or processing failed');
    }
  });

  // IMPORTANT:
  // Log BEFORE cleanup() so closing the other leg cannot obscure this event.
  // localCloseRequested tracks this handler only; it does not prove remote fault.
  ws.on('close', (code, reasonBuffer) => {
    const reason = reasonText(reasonBuffer);
    const abnormal = !!code && !normalWsClose(code);

    const details = {
      code,
      reason,
      normal: !abnormal,
      ...snapshot(),
    };

    if (abnormal)
      console.warn(`[media-diag ${label()}] WebSocket close`, details);
    else
      console.log(`[media-diag ${label()}] WebSocket close`, details);

    cleanup(
      abnormal ? 'Media connection closed unexpectedly' : undefined,
      abnormal
    );
  });

  ws.on('error', error => {
    console.error(`[media-diag ${label()}] WebSocket error`, {
      ...errorInfo(error),
      ...snapshot(),
    });

    if (!bridge && !ended)
      monitor?.event(null, 'error', 'Media socket error before call setup');

    cleanup('Media socket error', true);
  });

  console.log('[media] Asterisk WebSocket connected; waiting for MEDIA_START');
}
