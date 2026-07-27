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
};



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
  } else if (msg.type === 'control-changed') {
    // Someone acted on a ticket — refresh now instead of waiting for the poll.
    void refreshBoard();
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
  renderWorkers();
  renderGaggles();
  renderLogs();
  // The board is workspace-scoped, so a tab change has to refetch rather than
  // re-render what is already in memory.
  void refreshBoard();
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

// The Pipeline panel is gone: it summarised queued targets, open gates, retries
// and failures from each gaggle's in-memory state, all of which the Board and
// Gates panels now show from the control plane — with real statuses, and even
// when no gaggle process is running.

/**
 * Live workers: what each subprocess is doing right now.
 *
 * Deliberately only the live half. Queued, gated and failed work belongs to the
 * Board, which reads the durable record; this reads per-process telemetry that
 * exists nowhere else and disappears when the process does.
 */
function renderWorkers() {
  const names = visibleWorkspaceNames();
  const root = $('#workers-list');
  root.innerHTML = '';

  const cards = [];
  for (const name of names) {
    for (const w of state.states[name]?.running ?? []) cards.push({ name, w });
  }

  if (cards.length === 0) {
    root.appendChild(el('div', { class: 'empty' }, 'No workers running.'));
    return;
  }

  for (const { name, w } of cards) {
    const tokens = w.claude_total_tokens ?? 0;
    const pct = Math.min(100, Math.round((tokens / 200000) * 100));
    // The engine runs in this process, so there is no external run page to
    // link to. The run id is still worth showing: it is what `workflow_runs`
    // is keyed by, and what an operator needs to grep a log with.
    const runLabel = w.run_id ? `run ${w.run_id.slice(0, 8)}` : 'starting…';
    const runAttrs = w.run_id
      ? { class: 'run-id', title: w.run_id }
      : { class: 'run-id disabled', title: 'Run not started yet' };

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
        w.last_message
          ? el('div', { class: 'meta', style: { fontStyle: 'italic', marginTop: '4px' } }, w.last_message.slice(0, 120))
          : null,
        el('div', { class: 'actions' }, [el('span', runAttrs, runLabel)]),
      ]),
    );
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

function activeWorkerCount(workspaceName) {
  const s = state.states[workspaceName];
  return (s?.running?.length ?? 0);
}

function showStopModal(workspace, onConfirm) {
  const count = activeWorkerCount(workspace.name);
  const modal = $('#stop-modal');
  $('#modal-title').textContent = `Stop "${workspace.name}"?`;
  if (count > 0) {
    $('#modal-body').textContent =
      `This gaggle has ${count} active ${count === 1 ? 'worker' : 'workers'} running. ` +
      `They will be suspended, not cancelled — starting this gaggle again resumes them where they stopped.`;
  } else {
    $('#modal-body').textContent = `No active workers. The orchestrator will stop cleanly.`;
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
    // Gate and queue counts come from the board, which is workspace-scoped and
    // read from the control plane — a stopped gaggle still has queued work, and a
    // count taken from its (absent) in-memory state would read zero.
    const gateCount = state.board.gates.filter((g) => g.workspace === w.name).length;
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
  const workerCount = running.reduce((sum, w) => sum + activeWorkerCount(w.name), 0);

  $('#modal-title').textContent = 'Stop all gaggles?';
  $('#modal-body').textContent = workerCount > 0
    ? `${running.length} ${running.length === 1 ? 'gaggle' : 'gaggles'} will stop. ` +
      `There ${workerCount === 1 ? 'is' : 'are'} ${workerCount} active ${workerCount === 1 ? 'worker' : 'workers'} — ` +
      `they will be suspended and resume when the gaggle starts again.`
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
$('#btn-clear-logs').addEventListener('click', () => {
  state.logs = [];
  renderLogs();
});

// ─── Board: tickets and their statuses ──────────────────────────────────────
//
// The control plane is the source of truth, so the board reads straight from it
// rather than from any gaggle's in-memory state. That is why it still renders
// with every gaggle process stopped.

const TICKET_STATUS_ORDER = [
  'running',
  'analyzed',
  'analysis_requested',
  'analyzing',
  'analysis_failed',
  'imported',
  'done',
  'cancelled',
  'archived',
];

const STATUS_COLOR = {
  imported: 'var(--gray)',
  analysis_requested: 'var(--purple)',
  analyzing: 'var(--purple)',
  analyzed: 'var(--accent)',
  analysis_failed: 'var(--red)',
  running: 'var(--green)',
  done: 'var(--text-faint)',
  cancelled: 'var(--text-faint)',
  archived: 'var(--text-faint)',
  // targets
  excluded: 'var(--text-faint)',
  blocked: 'var(--amber)',
  ready: 'var(--accent)',
  dispatching: 'var(--purple)',
  gate_waiting: 'var(--amber)',
  succeeded: 'var(--green)',
  failed: 'var(--red)',
};

/** Actions offered per ticket status. Keeps the UI and the state machine aligned. */
const TICKET_ACTIONS = {
  imported: [
    ['analyze', 'Analyze', 'primary'],
    ['archive', 'Archive', ''],
  ],
  analysis_failed: [
    ['analyze', 'Retry analysis', 'primary'],
    ['archive', 'Archive', ''],
  ],
  analyzed: [
    ['start', 'Start', 'primary'],
    ['analyze', 'Re-analyze', ''],
    ['archive', 'Archive', ''],
  ],
  running: [['cancel', 'Cancel', 'stop']],
  archived: [['restore', 'Restore', '']],
  // Both of these are waiting on a daemon. A ticket whose workspace is stopped or
  // misconfigured would sit here with no way out at all if Cancel were missing.
  analysis_requested: [['cancel', 'Cancel', 'stop']],
  analyzing: [['cancel', 'Cancel', 'stop']],
};

state.board = { tickets: [], counts: {}, gates: [], cursor: 0, filter: '', search: '', expanded: new Set(), available: true };

async function controlGet(path) {
  const res = await fetch(`/api/control${path}`);
  if (res.status === 503) {
    state.board.available = false;
    return null;
  }
  state.board.available = true;
  if (!res.ok) return null;
  return res.json();
}

async function controlPost(path, body) {
  const res = await fetch(`/api/control${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A 409 is the normal answer when the world moved on — surface it rather than
    // silently doing nothing, so the operator knows their click was rejected.
    alert(data.error ?? `Request failed (HTTP ${res.status})`);
  }
  await refreshBoard();
  return res.ok;
}

async function refreshBoard() {
  const ws = state.selected === 'all' ? '' : `?workspace=${encodeURIComponent(state.selected)}`;
  const [board, gates] = await Promise.all([
    controlGet(`/board${ws}`),
    controlGet(`/gates${ws}`),
  ]);
  if (board) {
    state.board.tickets = board.tickets ?? [];
    state.board.counts = board.counts ?? {};
    state.board.cursor = board.latest_event_id ?? 0;
  }
  if (gates) state.board.gates = gates.gates ?? [];
  renderBoard();
  renderGates();
}

function statusPill(status) {
  return el('span', {
    class: 'status-pill',
    style: { color: STATUS_COLOR[status] ?? 'var(--text-dim)', borderColor: STATUS_COLOR[status] ?? 'var(--border)' },
  }, status.replace(/_/g, ' '));
}

function renderBoard() {
  const list = $('#board-list');
  list.innerHTML = '';

  if (!state.board.available) {
    list.appendChild(el('div', { class: 'empty' },
      'Control plane unavailable — check database.url and run `gaggle doctor`.'));
    $('#board-filters').innerHTML = '';
    return;
  }

  renderBoardFilters();

  const term = state.board.search.toLowerCase();
  const rows = state.board.tickets
    .filter((r) => !state.board.filter || r.ticket.status === state.board.filter)
    .filter((r) => !term
      || r.ticket.identifier.toLowerCase().includes(term)
      || r.ticket.title.toLowerCase().includes(term))
    .sort((a, b) =>
      TICKET_STATUS_ORDER.indexOf(a.ticket.status) - TICKET_STATUS_ORDER.indexOf(b.ticket.status)
      || (a.ticket.priority ?? 99) - (b.ticket.priority ?? 99)
      || a.ticket.identifier.localeCompare(b.ticket.identifier));

  if (rows.length === 0) {
    list.appendChild(el('div', { class: 'empty' },
      state.board.tickets.length === 0
        ? 'No tickets imported yet. Press Sync to import from the tracker.'
        : 'No tickets match the current filter.'));
    return;
  }

  for (const row of rows) list.appendChild(ticketRow(row));
}

function renderBoardFilters() {
  const box = $('#board-filters');
  box.innerHTML = '';
  const total = Object.values(state.board.counts).reduce((a, b) => a + b, 0);
  const chips = [['', 'all', total], ...TICKET_STATUS_ORDER
    .filter((s) => (state.board.counts[s] ?? 0) > 0)
    .map((s) => [s, s.replace(/_/g, ' '), state.board.counts[s]])];

  for (const [value, label, count] of chips) {
    box.appendChild(el('button', {
      class: `filter-chip${state.board.filter === value ? ' active' : ''}`,
      onclick: () => {
        state.board.filter = value;
        renderBoard();
      },
    }, `${label} ${count}`));
  }
}

function ticketRow({ ticket, targets }) {
  const expanded = state.board.expanded.has(ticket.id);
  const head = el('div', { class: 'ticket-head' }, [
    el('button', {
      class: 'ticket-toggle',
      title: expanded ? 'Collapse' : 'Expand',
      onclick: () => {
        if (expanded) state.board.expanded.delete(ticket.id);
        else state.board.expanded.add(ticket.id);
        renderBoard();
      },
    }, expanded ? '▾' : '▸'),
    ticket.url
      ? el('a', { class: 'ticket-key', href: ticket.url, target: '_blank', rel: 'noopener' }, ticket.identifier)
      : el('span', { class: 'ticket-key' }, ticket.identifier),
    el('span', { class: 'ticket-title', title: ticket.title }, ticket.title),
    statusPill(ticket.status),
    el('span', { class: 'target-chips' }, targets.map((t) =>
      el('span', {
        class: 'target-chip',
        title: `${t.repo_alias}: ${t.status}${t.failure_reason ? ` — ${t.failure_reason}` : ''}`,
        style: { color: STATUS_COLOR[t.status] ?? 'var(--text-dim)' },
      }, t.repo_alias))),
    el('span', { class: 'ticket-actions' }, (TICKET_ACTIONS[ticket.status] ?? []).map(([action, label, kind]) =>
      el('button', {
        class: `nest-btn ${kind}`,
        onclick: () => controlPost(`/tickets/${ticket.id}/${action}`),
      }, label))),
  ]);

  const badges = [];
  if (ticket.external_terminal_at) {
    badges.push(el('span', { class: 'badge warn' },
      'closed in the tracker while running — cancel it or let it finish'));
  }
  if (ticket.analysis_error) {
    badges.push(el('span', { class: 'badge err' }, ticket.analysis_error));
  }

  const children = [head];
  if (badges.length) children.push(el('div', { class: 'ticket-badges' }, badges));
  if (expanded) children.push(ticketDetail(ticket, targets));
  return el('div', { class: 'ticket-row' }, children);
}

function ticketDetail(ticket, targets) {
  const parts = [];
  if (ticket.analysis_summary) {
    parts.push(el('div', { class: 'detail-summary' }, ticket.analysis_summary));
  }
  if (targets.length === 0) {
    parts.push(el('div', { class: 'empty' }, 'No targets yet — press Analyze to work out which repos are involved.'));
  } else {
    parts.push(el('div', { class: 'target-table' }, targets.map((t) => targetRow(ticket, t))));
  }
  return el('div', { class: 'ticket-detail' }, parts);
}

function targetRow(ticket, t) {
  const actions = [];
  const push = (action, label, kind) => actions.push(el('button', {
    class: `nest-btn ${kind ?? ''}`,
    onclick: () => controlPost(`/targets/${t.id}/${action}`),
  }, label));

  if (t.status === 'failed' || t.status === 'cancelled') {
    push('redispatch', 'Re-dispatch', 'primary');
    // The only way to resolve a target you have decided not to pursue. Without it
    // one permanently-failed target keeps its ticket `running` forever.
    push('exclude', 'Give up on this');
  }
  if (['blocked', 'ready'].includes(t.status)) push('exclude', 'Exclude');
  if (t.status === 'excluded') push('include', 'Include');
  if (['dispatching', 'running', 'gate_waiting'].includes(t.status)) {
    push('cancel', t.cancel_requested ? 'Cancelling…' : 'Cancel', 'stop');
  }

  return el('div', { class: 'target-line' }, [
    el('span', { class: 'target-alias' }, t.repo_alias),
    statusPill(t.status),
    el('span', { class: 'target-workflow', title: t.workflow }, t.workflow),
    el('span', { class: 'target-meta' },
      [t.attempt > 0 ? `attempt ${t.attempt + 1}` : '', t.failure_reason ?? '']
        .filter(Boolean).join(' · ')),
    el('span', { class: 'target-actions' }, actions),
  ]);
}

// ─── Gates: the only place a gate gets answered ──────────────────────────────

function renderGates() {
  const panel = $('#gates-panel');
  const list = $('#gates-list');
  const gates = state.board.gates;
  panel.classList.toggle('hidden', gates.length === 0);
  $('#gates-count').textContent = gates.length ? `${gates.length} waiting` : '';
  list.innerHTML = '';

  for (const g of gates) {
    const input = el('textarea', {
      class: 'gate-input',
      rows: '2',
      placeholder: 'Your answer, or a reason for rejecting…',
    });
    const pending = g.pending_decision;

    list.appendChild(el('div', { class: 'gate-card' }, [
      el('div', { class: 'gate-head' }, [
        el('span', { class: 'ticket-key' }, `${g.identifier} · ${g.repo_alias}`),
        el('span', { class: 'gate-age' }, formatAgo(g.gate_opened_at)),
        g.rework_attempts > 0
          ? el('span', { class: 'badge' }, `revision ${g.rework_attempts}`)
          : null,
        pending ? el('span', { class: 'badge warn' }, `${pending} — waiting for the daemon`) : null,
      ]),
      el('pre', { class: 'gate-message' }, g.gate_message),
      pending ? null : el('div', { class: 'gate-actions' }, [
        input,
        el('button', {
          class: 'nest-btn primary',
          onclick: () => controlPost(`/gates/${g.target_id}/approve`, { comment: input.value || null }),
        }, 'Approve'),
        el('button', {
          class: 'nest-btn stop',
          onclick: () => {
            if (!input.value.trim()) {
              alert('A rejection needs a reason so the rework has something to act on.');
              return;
            }
            controlPost(`/gates/${g.target_id}/reject`, { reason: input.value });
          },
        }, 'Reject'),
        // The third answer to a gate: this work is blocked on a change somewhere
        // else. Files a blocker issue in the tracker and parks the target until it
        // is resolved. The whole path existed server-side with nothing to trigger it.
        el('button', {
          class: 'nest-btn',
          title: 'File a blocker and park this target until it is resolved',
          onclick: () => {
            const title = prompt('What is blocking this? (becomes the blocker issue title)');
            if (!title || !title.trim()) return;
            controlPost(`/gates/${g.target_id}/create-blocker`, {
              title: title.trim(),
              description: input.value || '',
            });
          },
        }, 'Blocked by…'),
      ]),
    ]));
  }
}

// ─── Board wiring ───────────────────────────────────────────────────────────

$('#board-search').addEventListener('input', (e) => {
  state.board.search = e.target.value;
  renderBoard();
});

$('#btn-sync').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = '⟳ Syncing…';
  try {
    const ws = state.selected === 'all' ? '' : `?workspace=${encodeURIComponent(state.selected)}`;
    const res = await fetch(`/api/control/sync${ws}`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error ?? 'Sync failed — is a gaggle running?');
    }
    await refreshBoard();
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ Sync';
  }
});

// Poll the cursor rather than the whole board: it is one integer, and refetching
// only when it moves keeps a large board cheap.
setInterval(async () => {
  const ws = state.selected === 'all' ? '' : `?workspace=${encodeURIComponent(state.selected)}`;
  const cur = await controlGet(`/cursor${ws}`);
  if (cur && cur.latest_event_id !== state.board.cursor) await refreshBoard();
}, 3000);

// Refresh "ago" labels on a steady tick.
setInterval(() => {
  renderWorkers();
  renderGates();
}, 5000);

// bootstrap() ends in renderAll(), which refreshes the board — no second call.
bootstrap();
