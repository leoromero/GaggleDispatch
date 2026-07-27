/**
 * Per-gaggle HTTP API.
 *
 * Each `gaggle start` process brings this up on a local port. It serves two
 * distinct things, and the split matters:
 *
 *   - **Live worker telemetry** — pids, token counts, the current output line.
 *     High-frequency, per-process, and meaningless once the process exits, which
 *     is exactly why it is served from memory here rather than written to the
 *     database.
 *   - **The control plane**, mounted at `/api/control/*`. The same routes the hub
 *     serves, so a single gaggle is usable without a nest.
 *
 * What it no longer serves is the board's state: pending targets, gates, retry
 * queues and state-machine maps used to be reported from memory here, and are now
 * read from Postgres by whoever is asking.
 */

import type { Server, ServerWebSocket } from 'bun';
import type { LiveSession, OrchestratorState } from '../domain/types.ts';
import { subscribeLogs, type LogEvent } from '../util/logger.ts';
import type { ControlApi } from '../control/api.ts';
import { crossSiteWrite } from './cross-site.ts';

export interface GaggleApiOptions {
  port: number;
  host?: string;
  workspaceName: string;
  getState: () => OrchestratorState;
  /** The control plane, when it is open. Absent until `start()` completes. */
  control?: () => ControlApi | null;
  /** Re-dispatch a target by id. */
  onRedispatch?: (target_id: string) => Promise<void>;
  /** Run a ticket-sync pass now — needs this process's tracker credentials. */
  onSync?: () => Promise<unknown>;
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
    run_id: s.run_id,
    workflow: s.workflow,
    last_event: s.last_event,
    last_event_at: s.last_event_at,
    last_message: s.last_message,
    claude_input_tokens: s.claude_input_tokens,
    claude_output_tokens: s.claude_output_tokens,
    claude_total_tokens: s.claude_total_tokens,
    turn_count: s.turn_count,
    started_at: s.started_at,
    attempt: s.attempt,
  };
}

function stateToJson(workspaceName: string, state: OrchestratorState): unknown {
  return {
    workspace: workspaceName,
    poll_interval_ms: state.poll_interval_ms,
    max_concurrent_agents: state.max_concurrent_agents,
    slots_used: state.running.size,
    running: Array.from(state.running.entries()).map(([target_id, s]) => ({
      target_id,
      ...(liveSessionToJson(s) as object),
    })),
    claude_totals: state.claude_totals,
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
      // Same reasoning as the hub's: this surface also mounts /api/control/*, and
      // it binds loopback with no auth in front of it. See `crossSiteWrite`.
      if (crossSiteWrite(req)) {
        return Response.json({ error: 'cross-site requests are not accepted' }, { status: 403 });
      }
      if (url.pathname === '/api/stream') {
        const ok = srv.upgrade(req, { data: { kind: 'stream' } });
        if (ok) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      if (url.pathname === '/healthz') {
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      }
      if (url.pathname === '/api/state') {
        return Response.json(stateToJson(opts.workspaceName, opts.getState()));
      }
      if (url.pathname === '/api/logs') {
        const since = url.searchParams.get('since');
        const events = since ? logBuffer.filter((e) => e.ts > since) : logBuffer.slice();
        return Response.json({ workspace: opts.workspaceName, events });
      }

      // ── control plane ─────────────────────────────────────────────────
      if (url.pathname.startsWith('/api/control/')) {
        const api = opts.control?.() ?? null;
        if (!api) {
          return Response.json({ error: 'control plane not open' }, { status: 503 });
        }
        let body: unknown;
        if (req.method === 'POST' || req.method === 'PATCH') {
          const raw = await req.text();
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw);
            } catch {
              return Response.json({ error: 'invalid JSON body' }, { status: 400 });
            }
          }
        }
        const res = await api.handle({
          method: req.method,
          path: url.pathname.slice('/api/control'.length) || '/',
          query: Object.fromEntries(url.searchParams),
          body,
        });
        return Response.json(res.body, { status: res.status });
      }

      if (url.pathname === '/sync' && req.method === 'POST') {
        if (!opts.onSync) {
          return Response.json({ error: 'sync not configured' }, { status: 503 });
        }
        try {
          return Response.json({ ok: true, result: await opts.onSync() });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }

      if (url.pathname === '/redispatch' && req.method === 'POST') {
        if (!opts.onRedispatch) {
          return Response.json({ error: 'redispatch not configured' }, { status: 503 });
        }
        let body: { target_id?: string };
        try {
          body = (await req.json()) as { target_id?: string };
        } catch {
          return Response.json({ error: 'invalid JSON body' }, { status: 400 });
        }
        if (!body.target_id) {
          return Response.json({ error: 'target_id required' }, { status: 400 });
        }
        try {
          await opts.onRedispatch(body.target_id);
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
        /* clients are read-only on this socket */
      },
    },
  });

  // Push state on an interval so the dashboard reflects live changes even when
  // no log events fire.
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
