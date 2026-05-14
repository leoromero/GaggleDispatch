/**
 * Per-gaggle HTTP API server.
 *
 * Each `gaggle start` process can optionally bring up this server on a
 * local port (assigned by the hub or auto-allocated). It exposes:
 *
 *   GET  /healthz                — liveness probe
 *   GET  /api/state              — JSON snapshot of OrchestratorState
 *   GET  /api/logs?since=<iso>   — recent log events (in-memory ring buffer)
 *   GET  /api/stream             — WebSocket: live state + log events
 *
 * The server is read-only by design. The hub aggregates from this API to
 * build the unified dashboard.
 */

import type { Server, ServerWebSocket } from 'bun';
import type { OrchestratorState, LiveSession, SupervisedGateEntry, FailedTargetSummary } from '../domain/types.ts';
import { subscribeLogs, type LogEvent } from '../util/logger.ts';

export interface GaggleApiOptions {
  port: number;
  host?: string;
  workspaceName: string;
  getState: () => OrchestratorState;
  onRedispatch?: (issue_id: string, repo_alias: string) => Promise<void>;
  /** How many log events to retain in memory (ring buffer). Default 1000. */
  logBufferSize?: number;
}

interface ApiWsData {
  kind: 'stream';
}

export interface GaggleApiHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

function liveSessionToJson(s: LiveSession): unknown {
  return {
    session_id: s.session_id,
    issue: {
      id: s.issue.id,
      identifier: s.issue.identifier,
      title: s.issue.title,
      state: s.issue.state,
      url: s.issue.url,
    },
    repo_alias: s.repo_alias,
    archon_pid: s.archon_pid,
    archon_db_run_id: s.archon_db_run_id,
    archon_workflow: s.archon_workflow,
    last_archon_event: s.last_archon_event,
    last_archon_timestamp: s.last_archon_timestamp,
    last_archon_message: s.last_archon_message,
    claude_input_tokens: s.claude_input_tokens,
    claude_output_tokens: s.claude_output_tokens,
    claude_total_tokens: s.claude_total_tokens,
    turn_count: s.turn_count,
    started_at: s.started_at,
    attempt: s.attempt,
  };
}

function gateToJson(g: SupervisedGateEntry): unknown {
  return {
    run_id: g.run_id,
    issue_id: g.issue_id,
    issue_identifier: g.issue.identifier,
    issue_title: g.issue.title,
    repo_alias: g.repo_alias,
    paused_at: g.paused_at,
    gate_message: g.gate_message,
    comment_id: g.comment_id,
    attempt: g.attempt,
  };
}

function stateToJson(workspaceName: string, state: OrchestratorState): unknown {
  return {
    workspace: workspaceName,
    poll_interval_ms: state.poll_interval_ms,
    max_concurrent_agents: state.max_concurrent_agents,
    slots_used: state.running.size,
    running: Array.from(state.running.entries()).map(([key, s]) => ({
      worker_key: key,
      ...(liveSessionToJson(s) as object),
    })),
    supervised_gates: Array.from(state.supervised_gates.entries()).map(([key, g]) => ({
      worker_key: key,
      ...(gateToJson(g) as object),
    })),
    pending_targets: Array.from(state.pending_targets.entries()).map(([issue_id, targets]) => ({
      issue_id,
      issue_identifier: state.pending_issues.get(issue_id)?.identifier ?? null,
      issue_title: state.pending_issues.get(issue_id)?.title ?? null,
      targets: targets.map((t) => ({
        repo_alias: t.repo_alias,
        archon_workflow: t.archon_workflow,
        depends_on: t.depends_on ?? [],
      })),
    })),
    retry_attempts: Array.from(state.retry_attempts.entries()).map(([key, r]) => ({
      worker_key: key,
      issue_identifier: r.identifier,
      repo_alias: r.repo_alias,
      attempt: r.attempt,
      due_at_ms: r.due_at_ms,
      error: r.error,
    })),
    claimed: (() => {
      const out: string[] = [];
      for (const [pid, sm] of state.parent_machine_states) {
        if (sm === 'analyzing' || sm === 'claimed') out.push(pid);
      }
      return out;
    })(),
    completed_count: (() => {
      let n = 0;
      for (const [, sm] of state.target_machine_states) if (sm === 'succeeded') n++;
      return n;
    })(),
    claude_totals: state.claude_totals,
    detached_archon_runs: Array.from(state.detached_archon_runs.entries()).map(([key, d]) => ({
      worker_key: key,
      archon_run_id: d.archon_run_id,
      issue_identifier: d.parent_issue.identifier,
      repo_alias: d.repo_alias,
      recovered_at: d.recovered_at,
    })),
    failed: Array.from(state.failed_targets.values()).map((info): FailedTargetSummary => ({
      issue_id: info.issue.id,
      issue_identifier: info.issue.identifier,
      issue_title: info.issue.title,
      repo_alias: info.repo_target.repo_alias,
      reason: info.reason,
      failed_at: info.failed_at,
    })),
  };
}

export function startGaggleApi(opts: GaggleApiOptions): GaggleApiHandle {
  const bufferSize = opts.logBufferSize ?? 1000;
  const logBuffer: LogEvent[] = [];
  const subs = new Set<ServerWebSocket<ApiWsData>>();

  const unsubscribeLogs = subscribeLogs((ev) => {
    logBuffer.push(ev);
    if (logBuffer.length > bufferSize) logBuffer.shift();
    if (subs.size === 0) return;
    const payload = JSON.stringify({ type: 'log', event: ev });
    for (const ws of subs) {
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  });

  const host = opts.host ?? '127.0.0.1';
  const server: Server<ApiWsData> = Bun.serve<ApiWsData>({
    port: opts.port,
    hostname: host,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/api/stream') {
        const ok = srv.upgrade(req, { data: { kind: 'stream' } });
        if (ok) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      if (url.pathname === '/healthz') {
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      }
      if (url.pathname === '/api/state') {
        const json = stateToJson(opts.workspaceName, opts.getState());
        return Response.json(json);
      }
      if (url.pathname === '/api/logs') {
        const since = url.searchParams.get('since');
        const events = since ? logBuffer.filter((e) => e.ts > since) : logBuffer.slice();
        return Response.json({ workspace: opts.workspaceName, events });
      }
      if (url.pathname === '/redispatch' && req.method === 'POST') {
        if (!opts.onRedispatch) {
          return Response.json({ error: 'redispatch not configured' }, { status: 503 });
        }
        let body: { issue_id?: string; repo_alias?: string };
        try {
          body = await req.json() as { issue_id?: string; repo_alias?: string };
        } catch {
          return Response.json({ error: 'invalid JSON body' }, { status: 400 });
        }
        const { issue_id, repo_alias } = body;
        if (!issue_id || !repo_alias) {
          return Response.json({ error: 'issue_id and repo_alias required' }, { status: 400 });
        }
        try {
          await opts.onRedispatch(issue_id, repo_alias);
          return Response.json({ ok: true });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400 });
        }
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        subs.add(ws);
        try {
          ws.send(
            JSON.stringify({
              type: 'state',
              state: stateToJson(opts.workspaceName, opts.getState()),
            }),
          );
        } catch {
          /* ignore */
        }
      },
      close(ws) {
        subs.delete(ws);
      },
      message() {
        /* clients are read-only */
      },
    },
  });

  // Push state updates on an interval so the dashboard reflects live changes
  // even when no log events fire.
  const ticker = setInterval(() => {
    if (subs.size === 0) return;
    const payload = JSON.stringify({
      type: 'state',
      state: stateToJson(opts.workspaceName, opts.getState()),
    });
    for (const ws of subs) {
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }, 2000);

  const resolvedPort = server.port ?? opts.port;
  return {
    port: resolvedPort,
    url: `http://${host}:${resolvedPort}`,
    async stop(): Promise<void> {
      clearInterval(ticker);
      unsubscribeLogs();
      for (const ws of subs) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      server.stop(true);
    },
  };
}
