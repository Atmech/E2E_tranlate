// Smoke test: verify GEMINI_API_KEY + Live model access BEFORE building anything else.
//
//   npm run smoke
//
// Opens one Live session, sends ~0.5s of silence, waits for a server message.
// Prints OK or the exact error. If you get 403 / NOT_FOUND on the preview translate
// model, set GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001 in .env and re-run.
import 'dotenv/config';
import { GoogleGenAI, Modality } from '@google/genai';

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.5-live-translate-preview';
const DST_LANG = process.env.DST_LANG || 'en';

if (!API_KEY) {
  console.error('FAIL: GEMINI_API_KEY missing in .env');
  process.exit(1);
}

const isTranslateModel = MODEL.includes('translate');

function buildConfig() {
  const config = {
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  if (isTranslateModel) {
    // Dedicated translate model: native translationConfig.
    config.translationConfig = { targetLanguageCode: DST_LANG, echoTargetLanguage: false };
  } else {
    // Generic live model fallback: drive translation via system instruction.
    config.systemInstruction = {
      parts: [{ text: `You are a live interpreter. Translate all incoming speech to ${DST_LANG}. Output only the translation as speech. Do not add commentary.` }],
    };
  }
  return config;
}

async function main() {
  console.log(`smoke: model=${MODEL} mode=${isTranslateModel ? 'translationConfig' : 'systemInstruction'}`);
  const ai = new GoogleGenAI({ apiKey: API_KEY });

  let opened = false;
  let erred = false;
  const done = (code, msg) => { console.log(msg); process.exit(code); };

  // Reachability = onopen without an error. Silence carries nothing to translate, so a
  // translate model legitimately stays quiet — don't wait for a server turn.
  const passTimer = setTimeout(() => {
    if (opened && !erred) {
      done(0, `OK: model "${MODEL}" reachable (session opened, no auth error). Use this model.`);
    } else if (!opened) {
      done(1, 'FAIL: session never opened within 8s');
    }
  }, 8000);

  let session;
  try {
    session = await ai.live.connect({
      model: MODEL,
      config: buildConfig(),
      callbacks: {
        onopen: () => { opened = true; console.log('  onopen: session established'); },
        onmessage: (m) => {
          const sc = m.serverContent;
          if (sc?.inputTranscription?.text) console.log('  input  :', sc.inputTranscription.text);
          if (sc?.outputTranscription?.text) console.log('  output :', sc.outputTranscription.text);
        },
        onerror: (e) => { erred = true; clearTimeout(passTimer); done(1, `FAIL onerror: ${e?.message || e}`); },
        onclose: (e) => {
          if (!opened) { clearTimeout(passTimer); done(1, `FAIL onclose before open: ${e?.reason || ''}`); }
        },
      },
    });
  } catch (e) {
    clearTimeout(timeout);
    const msg = e?.message || String(e);
    if (/403|PERMISSION|NOT_FOUND|not found|allowlist/i.test(msg)) {
      done(1, `FAIL: model "${MODEL}" not accessible on this key (${msg}).\n` +
              `  -> set GEMINI_LIVE_MODEL=gemini-2.0-flash-live-001 in .env and re-run.`);
    }
    done(1, `FAIL connect: ${msg}`);
  }

  // ~0.5s of 16kHz silence to nudge a response.
  const samples = 16000 / 2;
  const silence = Buffer.alloc(samples * 2); // int16 LE zeros
  session.sendRealtimeInput({ audio: { data: silence.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  // Some models only emit on turn end; give a short tail then mark turn complete if supported.
  setTimeout(() => {
    try { session.sendRealtimeInput({ audioStreamEnd: true }); } catch { /* ignore */ }
  }, 1500);
}

main();
