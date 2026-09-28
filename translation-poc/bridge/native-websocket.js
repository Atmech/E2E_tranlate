// Asterisk chan_websocket: text control events + raw binary slin (8kHz PCM).
// No AudioSocket framing, relay process, or additional network hop.
import { OutputPacer } from './audiosocket.js';

export function handleNativeConnection(ws, { activeCalls, agents, createBridge }) {
  let bridge, callId, paused = false, ended = false;
  const stats = { receivedBytes: 0, sentBytes: 0 };
  const sock = {
    get destroyed() { return ended || ws.readyState !== 1; },
    get writable() { return !ended && !paused && ws.readyState === 1; },
    write(pcm) {
      if (!this.writable) return;
      if (ws.bufferedAmount > 16000 * 5) return fail('WebSocket send buffer exceeded five seconds');
      stats.sentBytes += pcm.length;
      ws.send(pcm, { binary: true });
    },
    end() { cleanup(); ws.close(1000); },
  };
  const cleanup = () => {
    if (ended) return;
    ended = true;
    clearTimeout(startTimer);
    bridge?.close();
    if (bridge && activeCalls.get(callId) === bridge) activeCalls.delete(callId);
    console.log(`[media] closed ${callId || 'before MEDIA_START'}`, stats);
  };
  const fail = (reason) => {
    console.warn(`[media] ${reason}`);
    cleanup();
    ws.close(1008, reason);
  };
  const startTimer = setTimeout(() => fail('MEDIA_START timeout'), 5000);
  startTimer.unref?.();

  ws.on('message', async (data, isBinary) => {
    if (ended) return;
    try {
      if (isBinary) {
        if (!bridge) return fail('Audio before MEDIA_START');
        if (data.length % 2) return fail('PCM must contain complete 16-bit samples');
        stats.receivedBytes += data.length;
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
        if (activeCalls.size) return fail('Single-call POC is busy');
        clearTimeout(startTimer);
        callId = event.connection_id;
        const pacer = new OutputPacer(sock, { encodeFrame: pcm => pcm, sendSilence: false });
        bridge = createBridge(callId, sock, { pacer });
        activeCalls.set(callId, bridge);
        console.log(`[media] call up: ${callId} (slin 8000Hz, native WebSocket)`);
        await bridge.init();
        if (ended) return;
        for (const agent of agents) bridge.attachAgent(agent);
      } else if (event.event === 'MEDIA_XOFF') {
        paused = true;
      } else if (event.event === 'MEDIA_XON') {
        paused = false;
      } else if (event.event === 'DTMF_END') {
        console.log(`[media] dtmf ${callId}: ${event.digit}`);
      }
    } catch (error) {
      console.error('[media] connection failed:', error.message);
      fail('Media setup or processing failed');
    }
  });
  ws.on('close', cleanup);
  ws.on('error', cleanup);
  console.log('[media] Asterisk WebSocket connected; waiting for MEDIA_START');
}
