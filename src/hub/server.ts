/**
 * Hub HTTP server.
 *
 * Serves the dashboard SPA and an aggregate API that fans out across
 * managed workspaces. Receives WS events from each child gaggle, persists
 * relevant events to the shared SQLite history DB, and rebroadcasts to
 * dashboard clients.
 */

import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import type { HubConfig } from './config.ts';
import { HubProcessManager } from './process-manager.ts';
import type { HistoryStore } from './history.ts';
import type { ArchonSupervisor } from './archon-supervisor.ts';
import type { ControlApi } from '../control/api.ts';
import { crossSiteWrite } from './cross-site.ts';
import { logger } from '../util/logger.ts';

interface DashWsData {
  id: number;
}

interface AggregateLogEvent {
  workspace: string;
  ts: string;
  level: string;
  message: string;
  context: Record<string, unknown>;
}

interface AggregateStateEvent {
  workspace: string;
  state: unknown;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface HubServerOptions {
  cfg: HubConfig;
  manager: HubProcessManager;
  archon: ArchonSupervisor;
  dashboardDir: string;
  /**
   * The control plane's read/intent half.
   *
   * Optional so the hub still starts without a database — the dashboard then
   * serves everything except the board, and `/api/control/*` answers 503 rather
   * than failing to boot. That matters because losing the board should not cost
   * you the process controls you need to fix it.
   */
  control?: ControlApi | null;
  /**
   * Log-history store. Optional for the same reason as `control`: the nest is
   * still worth running without it.
   */
  history?: HistoryStore | null;
}

export interface HubServerHandle {
  url: string;
  stop: () => Promise<void>;
}

export function startHubServer(opts: HubServerOptions): HubServerHandle {
  const db = opts.history ?? null;

  // Workspace row ids, resolved in the background. History is optional, so the
  // server must come up whether or not the database answers.
  const wsRowByName = new Map<string, number>();
  if (db) {
    void (async () => {
      for (const w of opts.cfg.workspaces) {
        try {
          const row = await db.upsertWorkspace(w.name, w.path, w.color ?? null);
          wsRowByName.set(w.name, row.id);
        } catch (e) {
          logger.warn('Could not register workspace for history', {
            workspace: w.name,
            error: (e as Error).message,
          });
        }
      }
    })();
  }

  // Periodic log retention pass.
  const pruneTimer = setInterval(() => {
    if (!db) return;
    void db
      .pruneOldLogs()
      .then((removed) => {
        if (removed > 0) logger.debug('Pruned old log events', { removed });
      })
      .catch((e: Error) => {
        logger.warn('Log retention pass failed', { error: e.message });
      });
  }, 60 * 60 * 1000);

  // Dashboard clients (websocket subscribers).
  const dashClients = new Map<number, ServerWebSocket<DashWsData>>();
  let nextClientId = 1;

  // Track open gates per workspace so we can record gate resolution events.
  const openGates = new Map<string, Map<string, { paused_at: string; message: string }>>();

  function broadcast(payload: unknown): void {
    if (dashClients.size === 0) return;
    const json = JSON.stringify(payload);
    for (const ws of dashClients.values()) {
      try {
        ws.send(json);
      } catch {
        /* ignore */
      }
    }
  }

  function broadcastGaggles(): void {
    const list = opts.manager.list().map((w) => ({
      name: w.entry.name,
      path: w.entry.path,
      color: w.entry.color ?? null,
      status: w.status,
      api_url: w.api_url,
      pid: w.pid,
      started_at: w.started_at,
      restart_count: w.restart_count,
      last_exit_code: w.last_exit_code,
      last_exit_at: w.last_exit_at,
    }));
    broadcast({ type: 'gaggles', gaggles: list });
  }

  function recordLog(workspaceName: string, ev: { ts: string; level: string; message: string; context: Record<string, unknown> }): void {
    const wsId = wsRowByName.get(workspaceName);
    if (!db || !wsId) return;
    // Fire and forget: a log event that fails to persist must never delay the
    // broadcast that puts it in front of the operator.
    void db
      .appendLog({
        workspace_id: wsId,
        ts: ev.ts,
        level: ev.level,
        message: ev.message,
        session_id: (ev.context?.session_id as string) ?? null,
        issue_id: (ev.context?.issue_id as string) ?? null,
        repo_alias: (ev.context?.repo_alias as string) ?? null,
        fields: ev.context ?? null,
      })
      .catch((e: Error) => {
        logger.warn('Failed to persist log event', { error: e.message });
      });
  }

  // `diffGates` lived here. It inferred gate history by watching gates appear and
  // disappear in state snapshots, and could not tell how one had resolved — the
  // original comment said as much. `control_events` records the resolution, the
  // actor, and the comment, so there is nothing left to infer.

  // Hook child gaggle streams: forward all events to dashboard clients +
  // persist logs / gate transitions.
  for (const w of opts.cfg.workspaces) {
    void waitAndAttach(w.name);
  }

  async function waitAndAttach(name: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      const m = opts.manager.get(name);
      if (m?.api_url) {
        broadcastGaggles();
        opts.manager.attachStream(name, (workspaceName, ev) => {
          const e = ev as { type: string; event?: { ts: string; level: string; message: string; context: Record<string, unknown> }; state?: unknown };
          if (e.type === 'log' && e.event) {
            recordLog(workspaceName, e.event);
            const out: AggregateLogEvent = {
              workspace: workspaceName,
              ts: e.event.ts,
              level: e.event.level,
              message: e.event.message,
              context: e.event.context,
            };
            broadcast({ type: 'log', event: out });
          } else if (e.type === 'state' && e.state) {
            const out: AggregateStateEvent = { workspace: workspaceName, state: e.state };
            broadcast({ type: 'state', event: out });
          }
        });
        return;
      }
      await Bun.sleep(500);
    }
  }

  function serveStatic(pathname: string): Response {
    let rel = pathname === '/' ? '/index.html' : pathname;
    if (rel.includes('..')) return new Response('forbidden', { status: 403 });
    const filePath = join(opts.dashboardDir, rel);
    if (!existsSync(filePath)) {
      // Fall back to index.html for SPA routing.
      const indexPath = join(opts.dashboardDir, 'index.html');
      if (existsSync(indexPath)) {
        return new Response(readFileSync(indexPath), {
          headers: { 'content-type': MIME['.html']! },
        });
      }
      return new Response('not found', { status: 404 });
    }
    const ext = extname(filePath).toLowerCase();
    return new Response(readFileSync(filePath), {
      headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' },
    });
  }

  const server: Server<DashWsData> = Bun.serve<DashWsData>({
    port: opts.cfg.ui.port,
    hostname: opts.cfg.ui.host ?? '127.0.0.1',
    async fetch(req, srv) {
      const url = new URL(req.url);
      // Before routing, so it covers the process controls too — those start and
      // stop daemons, which is no less consequential than the board's verbs.
      if (crossSiteWrite(req)) {
        return Response.json({ error: 'cross-site requests are not accepted' }, { status: 403 });
      }
      if (url.pathname === '/api/ws') {
        const id = nextClientId++;
        const ok = srv.upgrade(req, { data: { id } });
        if (ok) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      if (url.pathname === '/api/archon') {
        return Response.json(opts.archon.getState());
      }
      // ── control plane: the board, and operator actions ──────────────────
      if (url.pathname.startsWith('/api/control/')) {
        if (!opts.control) {
          return Response.json(
            { error: 'the control plane is not configured — check database.url and run `gaggle doctor`' },
            { status: 503 },
          );
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
        try {
          const res = await opts.control.handle({
            method: req.method,
            path: url.pathname.slice('/api/control'.length) || '/',
            query: Object.fromEntries(url.searchParams),
            body,
          });
          if (res.status < 300 && req.method !== 'GET') {
            // An operator action moved something; nudge the dashboard rather than
            // making it wait for the next poll.
            broadcast({ type: 'control-changed' });
          }
          return Response.json(res.body, { status: res.status });
        } catch (err) {
          logger.error('Control API error', {
            method: req.method,
            path: url.pathname,
            error: (err as Error).message,
          });
          return Response.json({ error: (err as Error).message }, { status: 500 });
        }
      }
      if (url.pathname === '/api/gaggles') {
        const list = opts.manager.list().map((w) => ({
          name: w.entry.name,
          path: w.entry.path,
          color: w.entry.color ?? null,
          status: w.status,
          api_url: w.api_url,
          pid: w.pid,
          started_at: w.started_at,
          restart_count: w.restart_count,
          last_exit_code: w.last_exit_code,
          last_exit_at: w.last_exit_at,
        }));
        return Response.json({ gaggles: list });
      }
      // ── Gaggle control endpoints ─────────────────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/api/gaggles/stop-all') {
        void opts.manager.stopAllWorkspaces().then(() => {
          setTimeout(broadcastGaggles, 200);
        });
        return Response.json({ ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/gaggles/start-all') {
        for (const entry of opts.cfg.workspaces) {
          void opts.manager.startWorkspace(entry).then(() => {
            setTimeout(broadcastGaggles, 200);
          });
        }
        return Response.json({ ok: true });
      }
      const stopMatch = req.method === 'POST' && url.pathname.match(/^\/api\/gaggles\/([^/]+)\/stop$/);
      if (stopMatch) {
        const name = decodeURIComponent(stopMatch[1]!);
        void opts.manager.stopWorkspace(name).then(() => {
          setTimeout(broadcastGaggles, 200);
        });
        return Response.json({ ok: true });
      }
      const startMatch = req.method === 'POST' && url.pathname.match(/^\/api\/gaggles\/([^/]+)\/start$/);
      if (startMatch) {
        const name = decodeURIComponent(startMatch[1]!);
        const entry = opts.cfg.workspaces.find((w) => w.name === name);
        if (!entry) return Response.json({ error: 'gaggle not found' }, { status: 404 });
        void opts.manager.startWorkspace(entry).then(() => {
          setTimeout(broadcastGaggles, 200);
          void waitAndAttach(name);
        });
        return Response.json({ ok: true });
      }
      const redispatchMatch = req.method === 'POST' && url.pathname.match(/^\/api\/gaggles\/([^/]+)\/targets\/redispatch$/);
      if (redispatchMatch) {
        const name = decodeURIComponent(redispatchMatch[1]!);
        const workspace = opts.manager.get(name);
        if (!workspace || !workspace.api_url) {
          return Response.json({ error: 'gaggle not found or not running' }, { status: 404 });
        }
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: 'invalid JSON body' }, { status: 400 });
        }
        try {
          const res = await fetch(`${workspace.api_url}/redispatch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          return Response.json(data, { status: res.status });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 502 });
        }
      }
      if (url.pathname === '/api/state') {
        const states = await opts.manager.fetchAllStates();
        return Response.json({ states });
      }
      // Run and gate history are served from the control plane now:
      // `/api/control/tickets/:id` carries a target's full event timeline, with
      // statuses that are recorded rather than inferred.
      if (url.pathname === '/api/history/logs') {
        if (!db) return Response.json({ logs: [] });
        const wsName = url.searchParams.get('workspace');
        return Response.json({
          logs: await db.queryLogs({
            workspace_id: wsName ? wsRowByName.get(wsName) : undefined,
            since: url.searchParams.get('since') ?? undefined,
            level: url.searchParams.get('level') ?? undefined,
            issue_id: url.searchParams.get('issue') ?? undefined,
            repo_alias: url.searchParams.get('repo') ?? undefined,
            limit: Number(url.searchParams.get('limit') ?? 200),
          }),
        });
      }
      if (url.pathname === '/api/history/tokens') {
        if (!db) return Response.json({ tokens: [] });
        const wsName = url.searchParams.get('workspace');
        const wsId = wsName ? wsRowByName.get(wsName) ?? null : null;
        return Response.json({
          tokens: await db.tokenHistory(wsId, Number(url.searchParams.get('days') ?? 30)),
        });
      }
      return serveStatic(url.pathname);
    },
    websocket: {
      open(ws) {
        dashClients.set(ws.data.id, ws);
        // Send initial workspace list.
        void (async () => {
          const states = await opts.manager.fetchAllStates();
          try {
            ws.send(JSON.stringify({ type: 'snapshot', states }));
          } catch {
            /* ignore */
          }
        })();
      },
      close(ws) {
        dashClients.delete(ws.data.id);
      },
      message() {
        /* dashboard is read-only at the moment */
      },
    },
  });

  return {
    url: `http://${opts.cfg.ui.host ?? '127.0.0.1'}:${server.port}`,
    async stop(): Promise<void> {
      clearInterval(pruneTimer);
      for (const ws of dashClients.values()) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      server.stop(true);
      await db?.close();
    },
  };
}
