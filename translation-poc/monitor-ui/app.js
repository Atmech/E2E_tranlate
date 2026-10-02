const $ = id => document.getElementById(id);
let snapshot, selectedId, lastUpdate = 0;
let issueSignature = '';
const callRows = new Map();
let transcriptCache = { id: null, version: -1, records: [], omitted: 0 };
let pendingTranscript = null;
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text; // Never interpret call metadata as HTML.
  if (className) el.className = className;
  return el;
};
const time = value => value ? new Date(value).toLocaleTimeString() : '—';
const duration = ms => `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;
const badge = (text, type) => node('span', text, `badge ${type}`);
const hasIssues = call => call.issueCount > 0 || Object.values(call.legs).some(l => l.paused || l.queueMs >= 3000);
const age = at => at ? `${Math.max(0, Math.floor((snapshot.at - at) / 1000))}s ago` : 'No activity yet';
const setText = (el, text) => { if (el.textContent !== String(text)) el.textContent = text; };

function selectCall(id) {
  selectedId = id;
  if (transcriptCache.id !== id) transcriptCache = { id, version: -1, records: [], omitted: 0 };
  render();
}

const transcriptPath = id => `/monitor/api/calls/${encodeURIComponent(id)}/transcript`;
async function loadTranscript(call) {
  if (transcriptCache.id === call.id && transcriptCache.version === call.transcriptVersion) return;
  const request = `${call.id}:${call.transcriptVersion}`;
  if (pendingTranscript === request) return;
  pendingTranscript = request;
  try {
    const response = await fetch(transcriptPath(call.id));
    if (response.status === 401) { location.replace('/monitor/login'); return; }
    if (!response.ok) throw new Error('Could not load speech text');
    const history = await response.json();
    if (selectedId !== call.id) return;
    transcriptCache = { id: call.id, version: call.transcriptVersion, ...history };
    renderDetail();
  } catch {
    const text = $('speech-status');
    if (selectedId === call.id && text) text.textContent = 'Could not load speech text. Waiting to retry…';
  } finally { if (pendingTranscript === request) pendingTranscript = null; }
}

async function exportCall(call) {
  if (!call) return;
  const button = $('export-call');
  button.disabled = true;
  button.textContent = 'Preparing…';
  let history;
  try {
    const response = await fetch(transcriptPath(call.id));
    if (response.status === 401) { location.replace('/monitor/login'); return; }
    if (!response.ok) throw new Error('Speech text unavailable');
    history = await response.json();
  } catch {
    button.textContent = 'Export failed · retry';
    button.disabled = false;
    return;
  }
  const iso = value => value ? new Date(value).toISOString() : 'Not recorded';
  const seconds = Math.max(0, Math.round(((call.endedAt ?? snapshot.at) - call.startedAt) / 1000));
  const lines = [
    'CALL SESSION REPORT',
    `Call ID: ${call.callId}`,
    `Session ID: ${call.id}`,
    `Mode: ${call.mode}`,
    `Status: ${call.state}`,
    `Started: ${iso(call.startedAt)}`,
    `Ended: ${iso(call.endedAt)}`,
    `Duration: ${Math.floor(seconds / 60)}m ${seconds % 60}s`,
    `End reason: ${call.endReason || 'Call is still active'}`,
    '',
    'PARTICIPANT AND TRANSLATION STATUS',
  ];
  for (const role of ['caller', 'agent']) {
    const leg = call.legs[role];
    lines.push('', `${role.toUpperCase()} → ${role === 'caller' ? 'AGENT' : 'CALLER'}`);
    if (!leg) { lines.push('Participant: Not connected'); continue; }
    lines.push(
      `Languages: ${leg.sourceLang || '—'} → ${leg.targetLang || '—'}`,
      `Connection: ${leg.connected ? 'Connected' : 'Disconnected'}`,
      `Translator: ${leg.translator || '—'}`,
      `Translator setup: ${leg.setupMs == null ? '—' : `${leg.setupMs} ms`}`,
      `Incoming audio: ${((leg.receivedBytes || 0) / 1024).toFixed(1)} KiB`,
      `Last incoming audio: ${iso(leg.lastInputAt)}`,
      `Last translated output: ${iso(leg.lastOutputAt)}`,
      `Playback queue: ${leg.queueMs ?? 0} ms${leg.paused ? ' (paused)' : ''}`,
      `Audio dropped before ready: ${leg.droppedBytes || 0} bytes`,
    );
  }
  lines.push('', 'EVENT TIMELINE');
  for (const event of call.events) {
    lines.push(`[${iso(event.at)}] ${event.severity.toUpperCase()}${event.role ? ` (${event.role})` : ''}: ${event.message}`);
  }
  lines.push('', 'RECORDED ISSUES');
  const issues = snapshot.issues.filter(issue => issue.sessionId === call.id);
  if (!issues.length) lines.push('None');
  else for (const issue of [...issues].reverse())
    lines.push(`[${iso(issue.at)}] ${issue.severity.toUpperCase()}${issue.role ? ` (${issue.role})` : ''}: ${issue.message}`);
  lines.push('', 'RECOGNIZED SPEECH AND TRANSLATION');
  if (history.omitted) lines.push(`Earlier or oversized text segments omitted: ${history.omitted}`);
  if (!history.records.length) lines.push('No speech text recorded.');
  else for (const entry of history.records)
    lines.push(`[${iso(entry.at)}] ${entry.role.toUpperCase()} ${entry.kind === 'translated' ? 'TRANSLATION' : 'RECOGNIZED'}: ${entry.text}`);
  lines.push('', 'Privacy: this report contains recognized speech and translation text. It does not contain audio.');

  const safeCallId = call.callId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'call';
  const filename = `call-${safeCallId}-${new Date(call.startedAt).toISOString().replace(/[:.]/g, '-')}.txt`;
  const url = URL.createObjectURL(new Blob([`${lines.join('\n')}\n`], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  button.textContent = 'Export .txt';
  button.disabled = false;
}

function render() {
  if (!snapshot) return;
  for (const key of ['active', 'waiting', 'attention', 'failed']) $(key).textContent = snapshot.counts[key];
  const calls = snapshot.calls.filter(call =>
    call.callId.toLowerCase().includes($('search').value.toLowerCase()) &&
    ($('scope').value === 'all' || ($('scope').value === 'active' ? call.endedAt === null : call.endedAt !== null)) &&
    (!$('issues-only').checked || hasIssues(call)))
    .sort((a, b) => Number(hasIssues(b)) - Number(hasIssues(a)) ||
      Number(a.endedAt !== null) - Number(b.endedAt !== null) || b.startedAt - a.startedAt);
  $('count').textContent = `${calls.length} shown`;
  // Retain buttons across live updates so clicks and keyboard focus remain stable.
  for (const [id, row] of callRows) if (!calls.some(call => call.id === id)) { row.remove(); callRows.delete(id); }
  calls.forEach((call, index) => {
    let row = callRows.get(call.id);
    if (!row) {
      row = node('tr');
      const idCell = node('td');
      const button = node('button', call.callId, 'call-button');
      button.addEventListener('click', () => selectCall(call.id));
      idCell.append(button, node('span', '', 'call-subtitle'));
      const state = node('td'); state.append(badge('', ''));
      row.append(idCell, state, node('td'), node('td'));
      callRows.set(call.id, row);
    }
    row.className = call.id === selectedId ? 'selected' : '';
    const caller = call.legs.caller;
    setText(row.children[0].lastChild, `${caller?.sourceLang || '—'} ↔ ${caller?.targetLang || '—'} · ${call.mode}`);
    setText(row.children[1].firstChild, call.state);
    row.children[1].firstChild.className = `badge ${call.state}`;
    setText(row.children[2], duration((call.endedAt ?? snapshot.at) - call.startedAt));
    setText(row.children[3], call.lastIssue?.message || (hasIssues(call) ? 'Playback needs attention' : '—'));
    row.children[3].className = call.lastIssue ? call.lastIssue.severity : 'muted';
    if ($('calls').children[index] !== row) $('calls').insertBefore(row, $('calls').children[index] || null);
  });
  $('empty').hidden = calls.length > 0;
  $('empty').textContent = snapshot.calls.length ? 'No calls match these filters.' : 'No calls yet. New calls will appear here automatically.';
  renderDetail(); renderIssues();
  $('retention').textContent = `History: up to ${snapshot.retention.calls} ended calls / ${snapshot.retention.hours} hours. Resets on server restart. Events use your local time.`;
  $('updated').textContent = `Updated ${time(snapshot.at)}`;
}

function renderDetail() {
  const detail = $('detail');
  const scroll = detail.querySelector('.timeline')?.scrollTop || 0;
  const speechScroll = detail.querySelector('.speech-list')?.scrollTop || 0;
  detail.replaceChildren();
  const call = snapshot.calls.find(c => c.id === selectedId);
  $('clear-selection').hidden = !selectedId;
  $('export-call').hidden = !call;
  if (!call) {
    detail.append(node('p', selectedId ? 'This call is no longer in retained history.' : 'Select a call to inspect both directions and its event timeline.', 'empty'));
    return;
  }
  detail.append(node('div', call.callId, 'call-title'),
    node('div', `Started ${new Date(call.startedAt).toLocaleString()} · ${call.mode}`, 'detail-meta'));
  const directions = node('div', undefined, 'directions');
  for (const role of ['caller', 'agent']) {
    const leg = call.legs[role];
    const card = node('section', undefined, 'direction');
    card.append(node('h3', role === 'caller' ? 'Caller → Agent' : 'Agent → Caller'));
    if (!leg) { card.append(node('p', 'Participant has not connected', 'muted')); directions.append(card); continue; }
    const list = node('dl');
    for (const [label, value] of [
      ['Languages', `${leg.sourceLang || '—'} → ${leg.targetLang || '—'}`],
      ['Connection', leg.connected ? 'Connected' : 'Disconnected'],
      ['Translator', leg.translator || '—'],
      ['Setup time', leg.setupMs == null ? '—' : `${leg.setupMs} ms`],
      ['Last incoming audio', age(leg.lastInputAt)],
      ['Last translated output', age(leg.lastOutputAt)],
      ['Incoming audio', `${((leg.receivedBytes || 0) / 1024).toFixed(1)} KiB`],
      ['Playback to this participant', `${leg.queueMs ?? 0} ms queued${leg.paused ? ' · PAUSED' : ''}`],
      ['Audio dropped during setup', `${leg.droppedBytes || 0} bytes`],
    ]) list.append(node('dt', label), node('dd', value));
    card.append(list); directions.append(card);
  }
  detail.append(directions, node('p', 'Audio activity includes silence. A connected socket or recent audio does not verify translation quality.', 'detail-note'));
  if (call.endReason) detail.append(node('p', call.endReason, call.state === 'failed' ? 'error' : 'muted'));
  detail.append(node('h3', 'Speech and translation', 'section-title'));
  const speech = node('div', undefined, 'speech-list');
  if (transcriptCache.id !== call.id || transcriptCache.version < 0) {
    speech.append(node('p', 'Loading speech text…', 'muted'));
  } else {
    if (transcriptCache.omitted) speech.append(node('p', `${transcriptCache.omitted} older or oversized text segments were omitted.`, 'warning'));
    if (!transcriptCache.records.length) speech.append(node('p', 'No speech text recorded yet.', 'muted'));
    for (const entry of transcriptCache.records) {
      const line = node('div', undefined, 'speech-entry');
      line.append(node('span', `${time(entry.at)} · ${entry.role} · ${entry.kind}`, 'speech-label'), node('span', entry.text));
      speech.append(line);
    }
  }
  speech.id = 'speech-status';
  detail.append(speech);
  speech.scrollTop = speechScroll;
  detail.append(node('h3', 'Event timeline', 'section-title'));
  const timeline = node('ol', undefined, 'timeline');
  for (const event of [...call.events].reverse()) {
    const item = node('li'); item.append(node('time', time(event.at)),
      node('span', `${event.role ? `${event.role}: ` : ''}${event.message}`, `event-message ${event.severity}`));
    timeline.append(item);
  }
  detail.append(timeline); timeline.scrollTop = scroll;
  void loadTranscript(call);
}

function renderIssues() {
  const signature = snapshot.issues.slice(0, 30).map(issue => `${issue.id}:${snapshot.calls.some(c => c.id === issue.sessionId)}`).join(',');
  if (signature === issueSignature && $('issue-feed').dataset.rendered) return;
  issueSignature = signature; $('issue-feed').dataset.rendered = 'true';
  $('issue-feed').replaceChildren();
  if (!snapshot.issues.length) { $('issue-feed').append(node('p', 'No issues recorded in the retained history.', 'empty')); return; }
  for (const issue of snapshot.issues.slice(0, 30)) {
    const row = node('div', undefined, 'issue-item');
    const call = issue.sessionId && snapshot.calls.find(c => c.id === issue.sessionId);
    const label = node(call ? 'button' : 'span', issue.callId || 'Before call setup', call ? 'call-button' : 'muted');
    if (call) label.addEventListener('click', () => selectCall(call.id));
    row.append(node('time', time(issue.at)), label,
      node('span', `${issue.role ? `${issue.role}: ` : ''}${issue.message}`, issue.severity));
    $('issue-feed').append(row);
  }
}

for (const id of ['search', 'scope', 'issues-only']) $(id).addEventListener('input', render);
$('clear-selection').addEventListener('click', () => selectCall(null));
$('export-call').addEventListener('click', () => exportCall(snapshot?.calls.find(c => c.id === selectedId)));
function stale(message) {
  $('connection').textContent = 'Updates disconnected'; $('connection').className = 'badge error';
  $('notice').hidden = false; $('notice').textContent = message;
}
const events = new EventSource('/monitor/events');
events.onmessage = event => {
  snapshot = JSON.parse(event.data); lastUpdate = Date.now();
  $('connection').textContent = 'Live'; $('connection').className = 'badge ready'; $('notice').hidden = true;
  render();
};
events.addEventListener('expired', () => { events.close(); location.replace('/monitor/login'); });
events.onerror = async () => {
  stale('Live updates disconnected. Displayed values may be stale. Reconnecting…');
  try {
    const response = await fetch('/monitor/api/snapshot');
    if (response.status === 401) { events.close(); location.replace('/monitor/login'); }
  } catch { /* EventSource reconnects automatically. */ }
};
setInterval(() => {
  if (lastUpdate && Date.now() - lastUpdate > 5000) stale('No update in over five seconds. Displayed values may be stale.');
}, 2000);
$('logout').addEventListener('click', async () => {
  try {
    const response = await fetch('/monitor/logout', { method: 'POST', headers: { 'x-monitor-request': '1' } });
    if (!response.ok) throw new Error('Sign-out failed');
    events.close(); location.replace('/monitor/login');
  } catch { stale('Could not sign out. Check your connection and try again.'); }
});
