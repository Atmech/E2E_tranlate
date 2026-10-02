import { randomUUID } from 'node:crypto';

// Provider messages may contain request bodies, URLs or credentials. Keep a safe
// classification, never the raw message, transcript, audio, stack or SDK object.
export function failureCause(error) {
  const text = String(error?.message || error || '').toLowerCase();
  if (/quota|resource.exhausted|429|rate.limit/.test(text)) return 'Provider quota or rate limit';
  if (/unauth|permission|api.key|401|403/.test(text)) return 'Provider authentication or permission denied';
  if (/timeout|timed out|deadline/.test(text)) return 'Provider request timed out';
  if (/not.found|404|unsupported|not supported/.test(text)) return 'Model or configuration unavailable';
  if (/closed|disconnect|econnreset/.test(text)) return 'Translation connection closed';
  if (/unavailable|503|overloaded/.test(text)) return 'Provider temporarily unavailable';
  return 'Translation operation failed (inspect server logs for details)';
}

export class CallMonitor {
  constructor({ now = Date.now, historyLimit = 200, eventLimit = 100, issueLimit = 200,
    retentionMs = 24 * 60 * 60 * 1000, maxTextChars = 64000,
    maxTextEntries = 400, maxTextChunkChars = 2000 } = {}) {
    Object.assign(this, { now, historyLimit, eventLimit, issueLimit, retentionMs,
      maxTextChars, maxTextEntries, maxTextChunkChars });
    this.startedAt = now();
    this.calls = new Map();
    this.readers = new Map();
    // Speech text stays out of the broad snapshot and live event stream.
    this.transcripts = new Map();
    this.issues = [];
  }

  start(callId, mode = 'translation') {
    const id = randomUUID(); // A reused Asterisk call ID must not overwrite history.
    this.calls.set(id, { id, callId: String(callId).slice(0, 128), mode,
      state: 'waiting', startedAt: this.now(), endedAt: null, legs: {}, events: [],
      issueCount: 0, lastIssue: null, transcriptVersion: 0 });
    this.transcripts.set(id, { records: [], chars: 0, omitted: 0 });
    this.event(id, 'info', 'Call connected');
    this.prune();
    return id;
  }

  update(id, values) {
    const call = this.calls.get(id);
    if (call && call.endedAt === null) Object.assign(call, values);
  }

  leg(id, role, values) {
    const call = this.calls.get(id);
    if (!call || call.endedAt !== null) return;
    call.legs[role] = { ...call.legs[role], ...values };
  }

  transcript(id, role, kind, text) {
    const call = this.calls.get(id);
    const history = this.transcripts.get(id);
    if (!call || call.endedAt !== null || !history ||
        !['caller', 'agent'].includes(role) || !['recognized', 'translated'].includes(kind) ||
        typeof text !== 'string') return;
    const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
    if (!clean) return;
    const entry = { at: this.now(), role, kind, text: clean.slice(0, this.maxTextChunkChars) };
    history.records.push(entry);
    history.chars += entry.text.length;
    if (clean.length > this.maxTextChunkChars) history.omitted++;
    while (history.records.length > this.maxTextEntries || history.chars > this.maxTextChars) {
      history.chars -= history.records.shift().text.length;
      history.omitted++;
    }
    call.transcriptVersion++;
  }

  getTranscript(id) {
    if (!this.calls.has(id)) return null;
    const history = this.transcripts.get(id);
    return { records: history.records, omitted: history.omitted };
  }

  watch(id, read) { this.readers.set(id, read); }
  sample(id) {
    const read = this.readers.get(id);
    if (!read) return;
    for (const [role, values] of Object.entries(read())) {
      const previous = this.calls.get(id)?.legs[role];
      if (values.queueMs >= 3000 && !(previous?.queueMs >= 3000))
        this.event(id, 'warning', 'Playback queue reached three seconds', role);
      this.leg(id, role, values);
    }
  }

  event(id, severity, message, role = null) {
    const event = { at: this.now(), severity, message, role };
    const call = this.calls.get(id);
    if (call) {
      call.events.push(event);
      if (call.events.length > this.eventLimit) call.events.shift();
      if (severity !== 'info') { call.issueCount++; call.lastIssue = event; }
    }
    if (severity !== 'info') {
      this.issues.unshift({ ...event, id: randomUUID(), sessionId: call?.id || null,
        callId: call?.callId || null });
      this.issues.length = Math.min(this.issues.length, this.issueLimit);
    }
  }

  end(id, reason = 'Call ended', failed = false) {
    const call = this.calls.get(id);
    if (!call || call.endedAt !== null) return;
    this.sample(id);
    this.readers.delete(id);
    this.event(id, failed ? 'error' : 'info', reason);
    call.endedAt = this.now();
    call.state = failed ? 'failed' : 'ended';
    call.endReason = reason;
    for (const leg of Object.values(call.legs)) leg.connected = false;
    this.prune();
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    const ended = [...this.calls.values()].filter(call => call.endedAt !== null)
      .sort((a, b) => b.endedAt - a.endedAt);
    ended.forEach((call, i) => {
      if (i >= this.historyLimit || call.endedAt < cutoff) {
        this.calls.delete(call.id);
        this.transcripts.delete(call.id);
      }
    });
    this.issues = this.issues.filter(issue => issue.at >= cutoff);
  }

  snapshot() {
    this.prune();
    for (const id of this.readers.keys()) this.sample(id);
    const calls = [...this.calls.values()];
    return { at: this.now(), startedAt: this.startedAt,
      retention: { hours: this.retentionMs / 3600000, calls: this.historyLimit },
      counts: {
        active: calls.filter(c => c.endedAt === null).length,
        waiting: calls.filter(c => ['waiting', 'starting'].includes(c.state)).length,
        attention: calls.filter(c => c.endedAt === null && (c.issueCount ||
          Object.values(c.legs).some(l => l.paused || l.queueMs >= 3000))).length,
        failed: calls.filter(c => c.state === 'failed').length,
      }, calls, issues: this.issues };
  }
}
