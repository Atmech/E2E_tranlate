import 'dotenv/config';
import { Translator } from '../bridge/Translator.js';
import { runSmoke } from '../bridge/smoke-check.js';
import { failureCause } from '../bridge/CallMonitor.js';
try {
  await runSmoke(onFailure => new Translator(process.env.DST_LANG || 'en', {
    sourceLang: process.env.SRC_LANG || 'hi', onFailure, callId: 'synthetic-smoke',
  }));
  console.log('OK: production translator received setupComplete and remained connected during synthetic input.');
} catch (error) {
  console.error(`FAIL: ${failureCause(error)}`);
  process.exitCode = 1;
}
