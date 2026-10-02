// Asterisk chan_websocket: text control events + raw binary slin (8kHz PCM).
// No AudioSocket framing, relay process, or additional network hop.
import { OutputPacer } from './audiosocket.js';
import { CallTranslationSession, readMediaMetadata } from './MediaTranslation.js';

const MODE = process.env.MEDIA_MODE || (process.env.MEDIA_LOOPBACK === 'true' ? 'loopback' : 'translation');
if (!['translation', 'loopback'].includes(MODE)) throw new Error('MEDIA_MODE must be translation or loopback');

export function handleNativeConnection(ws, { activeCalls, agents = new Set(), createBridge,
  mode = MODE, createTranslator, setupTimeoutMs, monitor }) {
  let bridge, callId, paused = false, ended = false;
  const stats = { receivedBytes: 0, sentBytes: 0 };
  const sock = {
    get destroyed() { return ended || ws.readyState !== 1; },
    get writable() { return !ended && !paused && ws.readyState === 1; },
    write(pcm) {
      if (!this.writable) return;
      if (ws.bufferedAmount > 16000 * 5) return fail('WebSocket send buffer exceeded five seconds');
      stats.sentBytes += pcm.length;
      bridge?.onTransport?.({ sentBytes: stats.sentBytes, lastSentAt: Date.now() });
      ws.send(pcm, { binary: true });
    },
    end(code = 1000, reason) { if (ended) return; cleanup(); ws.close(code, reason); },
  };
  const cleanup = (reason, failed = false) => {
    if (ended) return;
    ended = true;
    clearTimeout(startTimer);
    bridge?.close(reason, failed);
    if (bridge && activeCalls.get(callId) === bridge) activeCalls.delete(callId);
    console.log(`[media] closed ${callId || 'before MEDIA_START'}`, stats);
  };
  const fail = (reason) => {
    if (ended) return;
    console.warn(`[media] ${reason}`);
    if (!bridge) monitor?.event(null, 'error', reason);
    cleanup(reason, true);
    ws.close(1008, reason);
  };
  // Temporary debugging window for Rajiv bhai's Asterisk connection (normally 5000ms).
  const startTimer = setTimeout(() => fail('MEDIA_START timeout'), 30000);
  startTimer.unref?.();

  ws.on('message', async (data, isBinary) => {
    if (ended) return;
    try {
      if (isBinary) {
        if (!bridge) return fail('Audio before MEDIA_START');
        if (data.length % 2) return fail('PCM must contain complete 16-bit samples');
        stats.receivedBytes += data.length;
        bridge.onTransport?.({ receivedBytes: stats.receivedBytes, lastInputAt: Date.now() });
        bridge.onCallAudio(data);
        return;
      }
      const text = data.toString().trim();
      let event;
      if (text.startsWith('{')) event = JSON.parse(text);
      else {
        const [name, ...fields] = text.split(/\s+/);
        event = { event: name };
        for (const field of fields) {
          const colon = field.indexOf(':');
          if (colon > 0) event[field.slice(0, colon)] = field.slice(colon + 1);
        }
      }
      if (event.event === 'MEDIA_START') {
        if (bridge) return fail('Duplicate MEDIA_START');
        if (event.format !== 'slin' || Number(event.optimal_frame_size) !== 320 ||
            (event.ptime !== undefined && Number(event.ptime) !== 20)) {
          return fail('Expected slin 8kHz mono with 320-byte 20ms frames');
        }
        if (!event.connection_id) return fail('Missing connection_id');
        if (mode === 'translation') {
          let metadata;
          try { metadata = readMediaMetadata(event.channel_variables); }
          catch (error) { return fail(error.message); } // Fixed validation messages, no supplied values.
          let session = activeCalls.get(metadata.callId);
          if (session && !(session instanceof CallTranslationSession)) return fail('CALL_ID collision');
          if (!session) {
            // Each CALL_ID owns an independent caller/agent pair and translators.
            session = new CallTranslationSession(metadata.callId, {
              createTranslator, setupTimeoutMs, monitor,
              onClose: () => {
                if (activeCalls.get(metadata.callId) === session) {
                  activeCalls.delete(metadata.callId);
                  console.log(`[media ${metadata.callId}] session removed activeCalls=${activeCalls.size}`);
                }
              },
            });
            activeCalls.set(metadata.callId, session);
            console.log(`[media ${metadata.callId}] new translation session activeCalls=${activeCalls.size}`);
          }
          const pacer = new OutputPacer(sock, { encodeFrame: pcm => pcm, sendSilence: false });
          try { bridge = session.addLeg(metadata, sock, pacer); }
          catch (error) { return fail(error.message); }
          callId = metadata.callId;
          clearTimeout(startTimer);
          console.log(`[media] call up: ${callId} role=${metadata.role} (slin 8000Hz, mode=translation)`);
          return;
        }
        if (activeCalls.size) return fail('Single-call POC is busy');
        clearTimeout(startTimer);
        callId = event.connection_id;
        if (mode === 'loopback') {
          // Temporary phone echo test: no Gemini sessions and no browser agent audio.
          let packets = 0;
          stats.droppedBytes = 0;
          const monitorId = monitor?.start(callId, 'loopback');
          monitor?.update(monitorId, { state: 'ready' });
          monitor?.leg(monitorId, 'caller', { connected: true, translator: 'not used' });
          bridge = {
            ready: false,
            async init() {},
            attachAgent() {},
            detachAgent() {},
            close(reason, failed) { monitor?.end(monitorId, reason || 'Loopback ended', failed); },
            onTransport(values) { monitor?.leg(monitorId, 'caller', values); },
            onPause(paused) { monitor?.leg(monitorId, 'caller', { paused }); },
            onCallAudio(pcm) {
              // During XOFF discard live echo input rather than accumulating delay.
              if (sock.writable) sock.write(pcm);
              else stats.droppedBytes += pcm.length;
              if (++packets === 1 || packets % 100 === 0)
                console.log(`[media] loopback ${callId} packets=${packets}`, stats);
            },
          };
        } else {
          const pacer = new OutputPacer(sock, { encodeFrame: pcm => pcm, sendSilence: false });
          // Injected audio source used by the transport-only smoke test.
          bridge = createBridge(callId, sock, { pacer });
        }
        activeCalls.set(callId, bridge);
        console.log(`[media] call up: ${callId} (slin 8000Hz, native WebSocket, mode=${mode})`);
        await bridge.init();
        if (ended) return;
        for (const agent of agents) bridge.attachAgent(agent);
      } else if (event.event === 'MEDIA_XOFF') {
        paused = true;
        bridge?.onPause?.(true);
      } else if (event.event === 'MEDIA_XON') {
        paused = false;
        bridge?.onPause?.(false);
      } else if (event.event === 'DTMF_END') {
        console.log(`[media] dtmf ${callId}: ${event.digit}`);
      }
    } catch (error) {
      console.error('[media] connection failed:', error.message);
      fail('Media setup or processing failed');
    }
  });
  ws.on('close', code => cleanup(code && ![1000, 1001].includes(code) ? 'Media connection closed unexpectedly' : undefined,
    !!code && ![1000, 1001].includes(code)));
  ws.on('error', () => {
    if (!bridge && !ended) monitor?.event(null, 'error', 'Media socket error before call setup');
    cleanup('Media socket error', true);
  });
  console.log('[media] Asterisk WebSocket connected; waiting for MEDIA_START');
}
