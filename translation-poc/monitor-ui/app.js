const $ = id => document.getElementById(id);
let snapshot, selectedId, lastUpdate = 0;
let issueSignature = '';
const callRows = new Map();
let transcriptCache = { id: null, version: -1, records: [], omitted: 0 };
let pendingTranscript = null;
let detailTab = 'conversation';
let detailSignature = '';
const languages = new Intl.DisplayNames(['en'], { type: 'language' });
const language = code => {
  if (!code) return '—';
  try { return languages.of(code) || code; } catch { return code; }
};
const stateLabel = state => ({ ready: 'Translating', waiting: 'Waiting for participant', starting: 'Starting translators', ended: 'Ended', failed: 'Failed' })[state] || state;
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text; // Never interpret call metadata as HTML.
  if (className) el.className = className;
  return el;
};
const time = value => value ? new Date(value).toLocaleTimeString() : '—';
const duration = ms => `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;
const badge = (text, type) => node('span', text, `badge ${type}`);
const hasIssues = call => call.issueCount > 0 || Object.values(call.legs).some(l => l.paused || l.queueMs >= 3000 || ['recovering', 'catching_up', 'failed'].includes(l.translator));
const age = at => at ? `${Math.max(0, Math.floor((snapshot.at - at) / 1000))}s ago` : 'No activity yet';
const setText = (el, text) => { if (el.textContent !== String(text)) el.textContent = text; };

const money = value => `$${value.toFixed(4)}`;
const costLabel = cost => !cost?.pricedDirections ? 'Not available' :
  `${money(cost.estimatedUsd)}${cost.unpricedDirections || cost.missingDirections ? ' (partial)' : ''}`;
const usageLabel = cost => !cost?.usageReports ? 'Not reported' :
  `${cost.latestUsage?.totalTokenCount ?? 'Not reported'} (latest report; not a billed total)`;

function matchesScope(call, scope) {
  if (scope === 'active') return call.endedAt === null;
  if (scope === 'ended') return call.endedAt !== null;
  if (scope === 'waiting') return ['waiting', 'starting'].includes(call.state);
  if (scope === 'attention') return call.endedAt === null && hasIssues(call);
  if (scope === 'failed') return call.state === 'failed';
  return true;
}

function clearFilters() {
  $('search').value = ''; $('scope').value = 'all'; $('issues-only').checked = false;
  render();
}

function showGuide(visible) {
  $('setup-guide').hidden = !visible;
  $('show-guide').setAttribute('aria-expanded', String(visible));
  if (visible) {
    $('hide-guide').focus({ preventScroll: true });
    $('setup-guide').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else $('show-guide').focus();
}

function selectCall(id) {
  selectedId = id;
  if (transcriptCache.id !== id) transcriptCache = { id, version: -1, records: [], omitted: 0 };
  render();
  if (id) {
    $('detail-heading').focus({ preventScroll: true });
    if (matchMedia('(max-width: 1050px)').matches) $('detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
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
    `Combined estimated audio cost (USD; not an invoice): ${costLabel(call.cost)}`,
    'PARTICIPANT AND TRANSLATION STATUS',
  ];
  for (const role of ['caller', 'agent']) {
    const leg = call.legs[role];
    lines.push('', `${role.toUpperCase()} → ${role === 'caller' ? 'AGENT' : 'CALLER'}`);
    if (!leg) { lines.push('Participant: Not connected'); continue; }
    lines.push(
      `Model: ${leg.cost?.model || 'Not reported'}; latest token report: ${usageLabel(leg.cost)}`,
      `Audio sent/received minutes: ${leg.cost ? `${(leg.cost.inputSubmittedMs / 60000).toFixed(4)} / ${(leg.cost.outputReceivedMs / 60000).toFixed(4)}` : 'Not reported'}`,
      `Languages: ${leg.sourceLang || '—'} → ${leg.targetLang || '—'}`,
      `Connection: ${leg.connected ? 'Connected' : 'Disconnected'}`,
      `Translator: ${leg.translator || '—'}`,
      `Reconnects: ${leg.reconnectCount ?? 0}; context resets: ${leg.freshFallbackCount ?? 0}`,
      `Input backlog: ${leg.inputQueueMs ?? 0} ms; peak: ${leg.maxInputQueueMs ?? 0} ms`,
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
  const spend = snapshot.cost;
  $('spend-total').textContent = costLabel(spend);
  $('spend-breakdown').textContent = spend ?
    `Active ${money(spend.activeUsd)} · Completed ${money(spend.completedUsd)} · Input ${money(spend.inputUsd)} · Output ${money(spend.outputUsd)}` : 'Waiting for usage data…';
  $('spend-coverage').textContent = spend ?
    `${spend.calls} tracked calls since ${new Date(snapshot.startedAt).toLocaleString()} · ${spend.inputMinutes.toFixed(2)} input / ${spend.outputMinutes.toFixed(2)} output audio minutes · ${spend.unpricedDirections} unpriced / ${spend.missingDirections} unmeasured directions. Includes completed calls removed from history.` : '';
  const calls = snapshot.calls.filter(call =>
    [call.callId, ...Object.values(call.legs).flatMap(leg => [leg.sourceLang, leg.targetLang, language(leg.sourceLang), language(leg.targetLang)])].join(' ').toLowerCase().includes($('search').value.trim().toLowerCase()) &&
    matchesScope(call, $('scope').value) &&
    (!$('issues-only').checked || hasIssues(call)))
    .sort((a, b) => Number(a.endedAt !== null) - Number(b.endedAt !== null) ||
      Number(hasIssues(b)) - Number(hasIssues(a)) || b.startedAt - a.startedAt);
  $('count').textContent = `${calls.length} / ${snapshot.calls.length}`;
  const filtered = $('search').value !== '' || $('scope').value !== 'all' || $('issues-only').checked;
  $('reset-filters').hidden = !filtered;
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === $('scope').value)));
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
    row.children[0].firstChild.setAttribute('aria-pressed', String(call.id === selectedId));
    const caller = call.legs.caller || call.legs.agent;
    setText(row.children[0].lastChild, `${language(caller?.sourceLang)} ↔ ${language(caller?.targetLang)} · ${call.mode}`);
    setText(row.children[1].firstChild, stateLabel(call.state));
    row.children[1].firstChild.className = `badge ${call.state}`;
    setText(row.children[2], duration((call.endedAt ?? snapshot.at) - call.startedAt));
    setText(row.children[3], call.lastIssue?.message || (hasIssues(call) ? 'Playback needs attention' : '—'));
    row.children[3].className = call.lastIssue ? call.lastIssue.severity : 'muted';
    if ($('calls').children[index] !== row) $('calls').insertBefore(row, $('calls').children[index] || null);
  });
  $('empty').hidden = calls.length > 0;
  $('call-table').hidden = !calls.length;
  $('empty-title').textContent = filtered ? 'No matching calls' : 'Ready for your first call';
  $('empty-message').textContent = filtered ? 'Try another call ID or language, or clear the filters to see every call.' : 'Start a call through Asterisk. It will appear here automatically, with live speech and translation.';
  $('empty-action').hidden = false;
  $('empty-action').textContent = filtered ? 'Clear filters' : 'How to connect a call';
  $('empty-hint').hidden = filtered;
  renderDetail(); renderIssues();
  $('retention').textContent = `History: up to ${snapshot.retention.calls} ended calls / ${snapshot.retention.hours} hours. Resets on server restart. Events use your local time.`;
  $('updated').textContent = `Updated ${time(snapshot.at)}`;
}

function renderDetail() {
  const detail = $('detail');
  const call = snapshot.calls.find(c => c.id === selectedId);
  const signature = JSON.stringify([selectedId, detailTab, call?.state, call?.endReason, call?.lastIssue, call && hasIssues(call), call?.transcriptVersion,
    transcriptCache.id, transcriptCache.version, detailTab === 'events' ? call?.events : null,
    detailTab === 'health' ? snapshot.at : null]);
  if (signature === detailSignature) {
    if (call && detailTab === 'conversation') void loadTranscript(call);
    return;
  }
  detailSignature = signature;
  const scroll = detail.querySelector('.timeline')?.scrollTop || 0;
  const previousSpeech = detail.querySelector('.speech-list');
  const speechScroll = previousSpeech?.scrollTop || 0;
  const followSpeech = !previousSpeech || previousSpeech.scrollHeight - previousSpeech.clientHeight - speechScroll < 32;
  detail.replaceChildren();
  $('detail-panel').hidden = !selectedId;
  $('workspace').classList.toggle('has-selection', Boolean(selectedId));
  $('clear-selection').hidden = !selectedId;
  $('export-call').hidden = !call;
  if (!call) {
    detail.append(node('p', selectedId ? 'This call is no longer in retained history.' : 'Select a call to inspect both directions and its event timeline.', 'empty'));
    return;
  }
  detail.append(node('div', call.callId, 'call-title'),
    node('div', `Started ${new Date(call.startedAt).toLocaleString()} · ${call.mode}`, 'detail-meta'));
  detail.append(badge(stateLabel(call.state), call.state));
  if (call.endReason) detail.append(node('p', call.endReason, call.state === 'failed' ? 'error' : 'muted'));
  else if (hasIssues(call)) detail.append(node('p', call.lastIssue?.message || 'Playback needs attention. Check the Health tab.', 'warning'));
  if (detailTab === 'health') {
    detail.append(node('p', `Combined estimated audio cost: ${costLabel(call.cost)} · both directions`, 'detail-note'));
    const directions = node('div', undefined, 'directions');
    for (const role of ['caller', 'agent']) {
      const leg = call.legs[role];
      const card = node('section', undefined, 'direction');
      card.append(node('h3', role === 'caller' ? 'Caller → Agent' : 'Agent → Caller'));
      if (!leg) { card.append(node('p', 'Participant has not connected', 'muted')); directions.append(card); continue; }
      const list = node('dl');
      for (const [label, value] of [
        ['Estimated audio cost', leg.cost?.estimatedUsd == null ? 'Not available' : money(leg.cost.estimatedUsd)],
        ['Model', leg.cost?.model || 'Not reported'],
        ['Audio minutes sent / received', leg.cost ? `${(leg.cost.inputSubmittedMs / 60000).toFixed(2)} / ${(leg.cost.outputReceivedMs / 60000).toFixed(2)}` : 'Not reported'],
        ['Token total', usageLabel(leg.cost)],
        ['Usage reports received', leg.cost?.usageReports ?? 'Not reported'],
        ['Languages', `${language(leg.sourceLang)} → ${language(leg.targetLang)}`],
        ['Connection', leg.connected ? 'Connected' : 'Disconnected'],
        ['Translator', ({ catching_up: 'Catching up', recovering: 'Reconnecting', connecting: 'Connecting', ready: 'Ready', failed: 'Failed', closed: 'Closed' })[leg.translator] || leg.translator || '—'],
        ['Reconnects', leg.reconnectCount ?? 0],
        ['Context resets', leg.freshFallbackCount ?? 0],
        ['Input backlog', `${leg.inputQueueMs ?? 0} ms · peak ${leg.maxInputQueueMs ?? 0} ms`],
        ['Current recovery', `${leg.recoveryMs ?? 0} ms`],
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
  }
  if (detailTab === 'conversation') {
    detail.append(node('h3', 'Speech and translation', 'section-title'));
    const speech = node('div', undefined, 'speech-list');
    if (transcriptCache.id !== call.id || transcriptCache.version < 0) {
      speech.append(node('p', 'Loading speech text…', 'muted'));
    } else {
      if (transcriptCache.omitted) speech.append(node('p', `${transcriptCache.omitted} older or oversized text segments were omitted.`, 'warning'));
      if (!transcriptCache.records.length) speech.append(node('p', call.endedAt !== null ? 'No speech text was recorded for this call.' : 'Listening for speech. Recognized words and translations will appear here as they arrive.', 'muted'));
      for (const entry of transcriptCache.records) {
        const line = node('div', undefined, `speech-entry ${entry.kind}`);
        const words = node('span', entry.text); words.dir = 'auto';
        line.append(node('span', `${time(entry.at)} · ${entry.role} · ${entry.kind === 'translated' ? 'Translation' : 'Original speech'}`, 'speech-label'), words);
        speech.append(line);
      }
    }
    speech.id = 'speech-status';
    detail.append(speech);
    speech.scrollTop = followSpeech ? speech.scrollHeight : speechScroll;
    void loadTranscript(call);
  }
  if (detailTab === 'events') {
    detail.append(node('h3', 'Event timeline', 'section-title'));
    const timeline = node('ol', undefined, 'timeline');
    for (const event of [...call.events].reverse()) {
      const item = node('li'); item.append(node('time', time(event.at)),
        node('span', `${event.role ? `${event.role}: ` : ''}${event.message}`, `event-message ${event.severity}`));
      timeline.append(item);
    }
    detail.append(timeline); timeline.scrollTop = scroll;
  }
}

function renderIssues() {
  const signature = snapshot.issues.slice(0, 30).map(issue => `${issue.id}:${snapshot.calls.some(c => c.id === issue.sessionId)}`).join(',');
  if (signature === issueSignature && $('issue-feed').dataset.rendered) return;
  issueSignature = signature; $('issue-feed').dataset.rendered = 'true';
  $('issue-count').textContent = snapshot.issues.length > 30 ? `Latest 30 of ${snapshot.issues.length}` : snapshot.issues.length;
  $('issue-feed').replaceChildren();
  if (!snapshot.issues.length) { $('issue-feed').append(node('p', '✓ No issues recorded. Connection and translation errors will appear here.', 'empty issues-empty')); return; }
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
$('reset-filters').addEventListener('click', clearFilters);
$('show-guide').addEventListener('click', () => showGuide($('setup-guide').hidden));
$('hide-guide').addEventListener('click', () => showGuide(false));
$('empty-action').addEventListener('click', () => {
  if (!$('reset-filters').hidden) { clearFilters(); $('search').focus(); }
  else showGuide(true);
});
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  const scope = $('scope').value === button.dataset.filter ? 'all' : button.dataset.filter;
  clearFilters(); $('scope').value = scope; render();
}));
const tabs = [...document.querySelectorAll('[data-tab]')];
tabs.forEach((button, index) => {
  button.addEventListener('click', () => {
    detailTab = button.dataset.tab;
    for (const tab of tabs) {
      tab.setAttribute('aria-selected', String(tab === button)); tab.tabIndex = tab === button ? 0 : -1;
    }
    $('detail').setAttribute('aria-labelledby', button.id);
    if (snapshot) renderDetail();
  });
  button.addEventListener('keydown', event => {
    const next = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (next !== undefined) { event.preventDefault(); tabs[next].focus(); tabs[next].click(); }
  });
});
$('clear-selection').addEventListener('click', () => {
  const button = callRows.get(selectedId)?.querySelector('button');
  selectCall(null); (button || $('search')).focus();
});
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
