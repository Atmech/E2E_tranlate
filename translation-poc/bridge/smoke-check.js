// The smoke check uses the production Translator, including setup acceptance and recovery config.
export async function runSmoke(createTranslator, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  durationMs = 1500, timeoutMs = 8000 } = {}) {
  let rejectFailure, timer, failureError;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});
  const translator = createTranslator(error => { failureError = error || new Error('Smoke session failed'); rejectFailure(failureError); });
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Smoke setup timed out')), timeoutMs);
  });
  try {
    await Promise.race([translator.start(), failure, deadline]);
    translator.feed(new Int16Array(8000)); // Synthetic 0.5 seconds only; never user speech.
    await Promise.race([wait(durationMs), failure, deadline]);
    if (failureError) throw failureError;
    const stats = translator.getStats();
    if (stats.closed || stats.failureRaised || !stats.hasSession) throw new Error('Smoke session closed prematurely');
    return stats;
  } finally { clearTimeout(timer); translator.close(); }
}
