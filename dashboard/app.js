// GaggleDispatch dashboard frontend.
// Single-page app, plain ES modules, no build step.

const state = {
  gaggles: [], // [{ name, path, color, status, api_url, ... }]
  selected: 'all',
  states: {}, // gaggleName -> latest state snapshot
  logs: [], // newest at the end, capped
  logFilters: { level: '', search: '' },
  autoscroll: true,
  connected: false,
  archon: null, // { status, ui_url, run_path, spawned_by_hub, ... }
};

function archonRunUrl(runId) {
  if (!runId || !state.archon || !state.archon.ui_url || !state.archon.run_path) return null;
  const base = state.archon.ui_url.replace(/\/$/, '');
  const path = state.archon.run_path.replace('{run_id}', encodeURIComponent(runId));
  return `${base}${path}`;
}

function archonRunsIndexUrl() {
  if (!state.archon || !state.archon.ui_url) return null;
  return `${state.archon.ui_url.replace(/\/$/, '')}/workflows/runs`;
}

const MAX_LOGS = 1000;
const COLORS_FALLBACK = ['#4f9cf9', '#f97316', '#10b981', '#a855f7', '#ef4444', '#eab308', '#06b6d4', '#ec4899'];

// ─── DOM helpers ────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function colorFor(gaggleName) {
  const w = state.gaggles.find((x) => x.name === gaggleName);
  if (w && w.color) return w.color;
  const idx = state.gaggles.findIndex((x) => x.name === gaggleName);
  return COLORS_FALLBACK[Math.max(0, idx) % COLORS_FALLBACK.length];
}

function formatAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatAgoMs(ms) {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.floor(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  return `${Math.floor(d / 3_600_000)}h`;
}

// ─── Connection ─────────────────────────────────────────────────────────────
let ws = null;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/ws`);
  ws.onopen = () => {
    state.connected = true;
    renderConnStat();
  };
  ws.onclose = () => {
    state.connected = false;
    renderConnStat();
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };
}

function handleMessage(msg) {
  if (msg.type === 'snapshot') {
    for (const [name, s] of Object.entries(msg.states ?? {})) {
      if (s) state.states[name] = s;
    }
    renderAll();
  } else if (msg.type === 'state') {
    state.states[msg.event.workspace] = msg.event.state;
    renderStats();
    renderPipeline();
    renderWorkers();
    renderGaggles();
  } else if (msg.type === 'log') {
    state.logs.push(msg.event);
    if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
    renderLogs();
  } else if (msg.type === 'gaggles') {
    state.gaggles = msg.gaggles ?? [];
    renderTabs();
    renderGaggles();
  }
}

// ─── Bootstrap fetches ──────────────────────────────────────────────────────
async function bootstrap() {
  try {
    const wsRes = await fetch('/api/gaggles');
    const wsJson = await wsRes.json();
    state.gaggles = wsJson.gaggles ?? [];
  } catch {
    state.gaggles = [];
  }
  try {
    const stRes = await fetch('/api/state');
    const stJson = await stRes.json();
    for (const [name, s] of Object.entries(stJson.states ?? {})) {
      if (s) state.states[name] = s;
    }
  } catch {
    /* ignore */
  }
  try {
    const aRes = await fetch('/api/archon');
    state.archon = await aRes.json();
  } catch {
    /* ignore */
  }
  try {
    const logsRes = await fetch('/api/history/logs?limit=200');
    const logsJson = await logsRes.json();
    // queryLogs returns DESC; reverse so newest is at end.
    state.logs = (logsJson.logs ?? [])
      .slice()
      .reverse()
      .map((r) => ({
        ts: r.ts,
        level: r.level,
        message: r.message,
        context: {
          workspace: state.gaggles.find((w) => w.path && r.workspace_id)?.name,
          issue_id: r.issue_id,
          repo_alias: r.repo_alias,
          session_id: r.session_id,
        },
      }));
  } catch {
    /* ignore */
  }
  renderAll();
  connect();
}

// ─── Renderers ──────────────────────────────────────────────────────────────
function renderAll() {
  renderTabs();
  renderStats();
  renderConnStat();
  renderArchonChip();
  renderPipeline();
  renderWorkers();
  renderGaggles();
  renderLogs();
}

function renderArchonChip() {
  const chip = $('#archon-chip');
  if (!chip) return;
  const a = state.archon;
  chip.className = 'stat archon-chip';
  if (!a) {
    chip.textContent = 'archon: ?';
    chip.removeAttribute('href');
    return;
  }
  chip.classList.add(a.status);
  chip.textContent = `archon: ${a.status}`;
  if (a.status === 'running' && a.ui_url) {
    chip.setAttribute('href', a.ui_url);
  } else {
    chip.removeAttribute('href');
  }
}

function renderTabs() {
  const root = $('#ws-tabs');
  root.innerHTML = '';
  root.appendChild(makeTab('all', 'All projects', null));
  for (const w of state.gaggles) {
    root.appendChild(makeTab(w.name, w.name, w.color || colorFor(w.name)));
  }
}

function makeTab(key, label, color) {
  const cls = `ws-tab${state.selected === key ? ' active' : ''}`;
  return el('div', { class: cls, onclick: () => { state.selected = key; renderAll(); } }, [
    color ? el('span', { class: 'dot', style: { background: color } }) : null,
    label,
  ]);
}

function renderConnStat() {
  const e = $('#conn-stat');
  e.classList.toggle('disconnected', !state.connected);
  e.textContent = state.connected ? '● connected' : '○ disconnected';
}

function visibleWorkspaceNames() {
  if (state.selected === 'all') return state.gaggles.map((w) => w.name);
  return [state.selected];
}

function renderStats() {
  const names = visibleWorkspaceNames();
  let slotsUsed = 0;
  let slotsMax = 0;
  let tokens = 0;
  for (const name of names) {
    const s = state.states[name];
    if (!s) continue;
    slotsUsed += s.slots_used ?? 0;
    slotsMax += s.max_concurrent_agents ?? 0;
    tokens += s.claude_totals?.total_tokens ?? 0;
  }
  $('#slots-stat').textContent = `${slotsUsed}/${slotsMax} slots`;
  $('#tokens-stat').textContent = `${tokens.toLocaleString()} tokens`;
}

function renderPipeline() {
  const names = visibleWorkspaceNames();
  let running = 0, gated = 0, queued = 0, retries = 0, failed = 0;
  const issuesByKey = new Map(); // issue_identifier -> { id, title, workspace, targets: [{repo, status}] }

  for (const name of names) {
    const s = state.states[name];
    if (!s) continue;
    running += s.running?.length ?? 0;
    gated += s.supervised_gates?.length ?? 0;
    queued += (s.pending_targets ?? []).reduce((acc, p) => acc + p.targets.length, 0);
    retries += s.retry_attempts?.length ?? 0;
    failed += s.failed?.length ?? 0;

    for (const w of s.running ?? []) {
      const key = `${name}:${w.issue.identifier}`;
      if (!issuesByKey.has(key)) {
        issuesByKey.set(key, { id: w.issue.identifier, title: w.issue.title, workspace: name, targets: [] });
      }
      issuesByKey.get(key).targets.push({ repo: w.repo_alias, status: 'running' });
    }
    for (const g of s.supervised_gates ?? []) {
      const key = `${name}:${g.issue_identifier}`;
      if (!issuesByKey.has(key)) {
        issuesByKey.set(key, { id: g.issue_identifier, title: g.issue_title, workspace: name, targets: [] });
      }
      issuesByKey.get(key).targets.push({ repo: g.repo_alias, status: 'gate' });
    }
    for (const p of s.pending_targets ?? []) {
      const key = `${name}:${p.issue_identifier ?? p.issue_id}`;
      if (!issuesByKey.has(key)) {
        issuesByKey.set(key, { id: p.issue_identifier ?? p.issue_id, title: p.issue_title ?? '', workspace: name, targets: [] });
      }
      for (const t of p.targets) {
        issuesByKey.get(key).targets.push({ repo: t.repo_alias, status: 'queued' });
      }
    }
  }

  const summary = $('#pipeline-summary');
  summary.innerHTML = '';
  summary.append(
    el('div', { class: 'item' }, [el('span', { class: 'count', style: { color: 'var(--green)' } }, String(running)), el('span', { class: 'label' }, 'running')]),
    el('div', { class: 'item' }, [el('span', { class: 'count', style: { color: 'var(--amber)' } }, String(gated)), el('span', { class: 'label' }, 'gate wait')]),
    el('div', { class: 'item' }, [el('span', { class: 'count', style: { color: 'var(--purple)' } }, String(queued)), el('span', { class: 'label' }, 'queued')]),
    el('div', { class: 'item' }, [el('span', { class: 'count', style: { color: 'var(--red)' } }, String(failed)), el('span', { class: 'label' }, 'failed')]),
  );

  const list = $('#pipeline-list');
  list.innerHTML = '';
  if (issuesByKey.size === 0) {
    list.appendChild(el('div', { class: 'empty' }, 'No active issues.'));
    return;
  }
  for (const { id, title, workspace, targets } of issuesByKey.values()) {
    const chips = targets.map((t) => el('span', { class: `target-chip ${t.status}` }, `${t.repo}`));
    list.appendChild(
      el('div', { class: 'pipeline-issue' }, [
        el('div', { class: 'id', style: { color: colorFor(workspace) } }, id),
        el('div', { class: 'title' }, title || ''),
        el('div', { class: 'targets' }, chips),
      ]),
    );
  }
}

function renderWorkers() {
  const names = visibleWorkspaceNames();
  const root = $('#workers-list');
  root.innerHTML = '';

  const cards = [];
  for (const name of names) {
    const s = state.states[name];
    if (!s) continue;
    for (const w of s.running ?? []) cards.push({ name, kind: 'running', w });
    for (const g of s.supervised_gates ?? []) cards.push({ name, kind: 'gate', w: g });
    for (const f of s.failed ?? []) cards.push({ name, kind: 'failed', w: f });
  }

  if (cards.length === 0) {
    root.appendChild(el('div', { class: 'empty' }, 'No workers.'));
    return;
  }

  for (const { name, kind, w } of cards) {
    if (kind === 'running') {
      const tokens = w.claude_total_tokens ?? 0;
      const pct = Math.min(100, Math.round((tokens / 200000) * 100));
      const directUrl = archonRunUrl(w.archon_db_run_id);
      const indexUrl = archonRunsIndexUrl();
      const linkText = directUrl ? 'View in Archon ↗' : 'Open Archon runs ↗';
      const linkAttrs = directUrl
        ? { href: directUrl, target: '_blank', rel: 'noopener' }
        : indexUrl
          ? {
              href: indexUrl,
              target: '_blank',
              rel: 'noopener',
              class: 'fallback',
              title: 'Run id not captured yet — open Archon runs index',
            }
          : { class: 'disabled', title: 'Archon unavailable' };
      root.appendChild(
        el('div', { class: 'worker-card' }, [
          el('div', { class: 'head' }, [
            el('div', { class: 'who' }, [
              el('span', { class: 'ws-color', style: { background: colorFor(name) } }),
              `${w.issue.identifier} · ${w.repo_alias}`,
            ]),
            el('span', { class: 'badge running' }, 'running'),
          ]),
          el('div', { class: 'meta' }, `turn ${w.turn_count} · ${formatAgo(w.started_at)}`),
          el('div', { class: 'meta' }, `${tokens.toLocaleString()} tokens`),
          el('div', { class: 'token-bar' }, [el('div', { class: 'fill', style: { width: `${pct}%` } })]),
          w.last_archon_message
            ? el('div', { class: 'meta', style: { fontStyle: 'italic', marginTop: '4px' } }, w.last_archon_message.slice(0, 120))
            : null,
          el('div', { class: 'actions' }, [el('a', linkAttrs, linkText)]),
        ]),
      );
    } else {
      const directUrl = archonRunUrl(w.run_id);
      const indexUrl = archonRunsIndexUrl();
      const linkText = directUrl ? 'View in Archon ↗' : 'Open Archon runs ↗';
      const linkAttrs = directUrl
        ? { href: directUrl, target: '_blank', rel: 'noopener' }
        : indexUrl
          ? { href: indexUrl, target: '_blank', rel: 'noopener', class: 'fallback' }
          : { class: 'disabled' };
      root.appendChild(
        el('div', { class: 'worker-card gated' }, [
          el('div', { class: 'head' }, [
            el('div', { class: 'who' }, [
              el('span', { class: 'ws-color', style: { background: colorFor(name) } }),
              `${w.issue_identifier} · ${w.repo_alias}`,
            ]),
            el('span', { class: 'badge gate' }, `gate · ${formatAgoMs(w.paused_at)}`),
          ]),
          el('div', { class: 'meta' }, w.issue_title || ''),
          el('div', { class: 'gate-msg' }, w.gate_message || '(no message)'),
          el('div', { class: 'actions' }, [el('a', linkAttrs, linkText)]),
        ]),
      );
    } else if (kind === 'failed') {
      const agoStr = w.failed_at ? formatAgoMs(w.failed_at) : 'unknown time ago';
      const reasonText = w.reason ?? 'see Linear comment for details';
      const btn = el('button', { class: 'redispatch-btn' }, 'Re-dispatch');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Dispatching…';
        const actionsEl = btn.parentElement;
        const existing = actionsEl?.querySelector('.redispatch-error');
        if (existing) existing.remove();
        try {
          const res = await fetch(
            `/api/gaggles/${encodeURIComponent(name)}/targets/redispatch`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ issue_id: w.issue_id, repo_alias: w.repo_alias }),
            },
          );
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
          btn.closest('.worker-card')?.remove();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Re-dispatch';
          const errEl = el('span', { class: 'redispatch-error' }, err.message ?? 'failed');
          btn.parentElement?.appendChild(errEl);
        }
      });
      root.appendChild(
        el('div', { class: 'worker-card failed' }, [
          el('div', { class: 'head' }, [
            el('div', { class: 'who' }, [
              el('span', { class: 'ws-color', style: { background: colorFor(name) } }),
              `${w.issue_identifier} · ${w.repo_alias}`,
            ]),
            el('span', { class: 'badge failed' }, `failed · ${agoStr}`),
          ]),
          el('div', { class: 'meta' }, w.issue_title || ''),
          el('div', { class: 'fail-reason' }, reasonText),
          el('div', { class: 'actions' }, [btn]),
        ]),
      );
    }
  }
}

// ─── Workspace controls ──────────────────────────────────────────────────────
async function apiPost(path) {
  try {
    await fetch(path, { method: 'POST' });
  } catch {
    /* ignore — server will broadcast the result */
  }
}

function activeArchonCount(workspaceName) {
  const s = state.states[workspaceName];
  return (s?.running?.length ?? 0);
}

function showStopModal(workspace, onConfirm) {
  const count = activeArchonCount(workspace.name);
  const modal = $('#stop-modal');
  $('#modal-title').textContent = `Stop "${workspace.name}"?`;
  if (count > 0) {
    $('#modal-body').textContent =
      `This gaggle has ${count} active Archon ${count === 1 ? 'worker' : 'workers'} running. ` +
      `The orchestrator will stop; Archon workers will continue processing independently and can be cancelled in the Archon UI.`;
  } else {
    $('#modal-body').textContent = `No active Archon workers. The orchestrator will stop cleanly.`;
  }
  modal.classList.remove('hidden');

  const cleanup = () => {
    modal.classList.add('hidden');
    $('#modal-stop').replaceWith($('#modal-stop').cloneNode(true));
    $('#modal-cancel').replaceWith($('#modal-cancel').cloneNode(true));
    rewireModal();
  };

  $('#modal-stop').addEventListener('click', () => { cleanup(); onConfirm(); }, { once: true });
  $('#modal-cancel').addEventListener('click', cleanup, { once: true });
}

function rewireModal() {
  $('#modal-cancel').addEventListener('click', () => $('#stop-modal').classList.add('hidden'), { once: true });
}

function renderGaggles() {
  const root = $('#gaggles-list');
  root.innerHTML = '';
  if (state.gaggles.length === 0) {
    root.appendChild(el('div', { class: 'empty' }, 'No gaggles registered.'));
    return;
  }
  for (const w of state.gaggles) {
    const s = state.states[w.name];
    const slots = s ? `${s.slots_used}/${s.max_concurrent_agents}` : '—';
    const runCount = s?.running?.length ?? 0;
    const gateCount = s?.supervised_gates?.length ?? 0;
    const queuedCount = (s?.pending_targets ?? []).reduce((acc, p) => acc + p.targets.length, 0);
    const isStopped = w.status === 'stopped' || w.status === 'crashed';

    const stopBtn = el('button', {
      class: 'nest-btn stop ws-ctrl',
      title: 'Stop gaggle',
      onclick: (e) => {
        e.stopPropagation();
        showStopModal(w, () => apiPost(`/api/gaggles/${encodeURIComponent(w.name)}/stop`));
      },
    }, '■');

    const startBtn = el('button', {
      class: 'nest-btn start ws-ctrl',
      title: 'Start gaggle',
      onclick: (e) => {
        e.stopPropagation();
        apiPost(`/api/gaggles/${encodeURIComponent(w.name)}/start`);
      },
    }, '▶');

    root.appendChild(
      el('div', { class: 'gaggle-card', onclick: () => { state.selected = w.name; renderAll(); } }, [
        el('div', { class: 'head' }, [
          el('span', { class: 'dot', style: { background: w.color || colorFor(w.name) } }),
          el('span', { class: 'name' }, w.name),
          el('span', { class: `status ${w.status}` }, w.status || 'unknown'),
          el('div', { class: 'ws-ctrl-group' }, isStopped ? [startBtn] : [stopBtn]),
        ]),
        el('div', { class: 'meta' }, w.path),
        el('div', { class: 'summary' }, [
          el('span', { class: 'pill' }, `${slots} slots`),
          el('span', { class: 'pill', style: { color: 'var(--green)' } }, `● ${runCount}`),
          el('span', { class: 'pill', style: { color: 'var(--amber)' } }, `⏸ ${gateCount}`),
          el('span', { class: 'pill', style: { color: 'var(--purple)' } }, `⏳ ${queuedCount}`),
        ]),
      ]),
    );
  }
}

function renderLogs() {
  const root = $('#logs-list');
  root.innerHTML = '';
  const names = state.selected === 'all' ? null : new Set([state.selected]);
  const lvlFilter = state.logFilters.level;
  const search = state.logFilters.search.toLowerCase();

  const filtered = state.logs.filter((ev) => {
    if (names) {
      const w = ev.context?.workspace || ev.workspace;
      if (w && !names.has(w)) return false;
    }
    if (lvlFilter && ev.level !== lvlFilter) return false;
    if (search && !ev.message.toLowerCase().includes(search)) return false;
    return true;
  });

  if (filtered.length === 0) {
    root.appendChild(el('div', { class: 'empty' }, 'No log events.'));
    return;
  }

  for (const ev of filtered.slice(-500)) {
    const wsName = ev.context?.workspace || ev.workspace || '';
    root.appendChild(
      el('div', { class: 'log-line' }, [
        el('span', { class: 'ts' }, (ev.ts || '').slice(11, 19)),
        el('span', { class: 'ws', style: { color: colorFor(wsName) } }, wsName || '—'),
        el('span', { class: `level ${ev.level}` }, ev.level),
        el('span', { class: 'msg' }, ev.message + formatContext(ev.context)),
      ]),
    );
  }

  if (state.autoscroll) {
    root.scrollTop = root.scrollHeight;
  }
}

function formatContext(ctx) {
  if (!ctx) return '';
  const parts = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (k === 'workspace') continue;
    if (v == null) continue;
    if (typeof v === 'object') continue;
    parts.push(` ${k}=${v}`);
  }
  return parts.length ? ' · ' + parts.join('').trim() : '';
}

// ─── Nest-level controls ─────────────────────────────────────────────────────
$('#btn-stop-all').addEventListener('click', () => {
  const running = state.gaggles.filter((w) => w.status !== 'stopped' && w.status !== 'crashed');
  if (running.length === 0) return;
  const workerCount = running.reduce((sum, w) => sum + activeArchonCount(w.name), 0);

  $('#modal-title').textContent = 'Stop all gaggles?';
  $('#modal-body').textContent = workerCount > 0
    ? `${running.length} ${running.length === 1 ? 'gaggle' : 'gaggles'} will stop. ` +
      `There ${workerCount === 1 ? 'is' : 'are'} ${workerCount} active Archon ${workerCount === 1 ? 'worker' : 'workers'} — ` +
      `they will continue running independently and can be cancelled in the Archon UI.`
    : `${running.length} ${running.length === 1 ? 'gaggle' : 'gaggles'} will stop cleanly.`;
  $('#stop-modal').classList.remove('hidden');

  const cleanup = () => {
    $('#stop-modal').classList.add('hidden');
    $('#modal-stop').replaceWith($('#modal-stop').cloneNode(true));
    $('#modal-cancel').replaceWith($('#modal-cancel').cloneNode(true));
    rewireModal();
  };
  $('#modal-stop').addEventListener('click', () => { cleanup(); apiPost('/api/gaggles/stop-all'); }, { once: true });
  $('#modal-cancel').addEventListener('click', cleanup, { once: true });
});

$('#btn-start-all').addEventListener('click', () => {
  apiPost('/api/gaggles/start-all');
});

// ─── Filter wiring ──────────────────────────────────────────────────────────
$('#log-level').addEventListener('change', (e) => {
  state.logFilters.level = e.target.value;
  renderLogs();
});
$('#log-search').addEventListener('input', (e) => {
  state.logFilters.search = e.target.value;
  renderLogs();
});
$('#autoscroll').addEventListener('change', (e) => {
  state.autoscroll = e.target.checked;
});

// Refresh "ago" labels on a steady tick.
setInterval(() => {
  renderWorkers();
}, 5000);

bootstrap();
