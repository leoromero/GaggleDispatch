/**
 * The `/api/control/*` HTTP boundary, over a real server.
 *
 * `ControlApi` itself is covered by control-api.test.ts, which drives it directly.
 * What that cannot cover is the mount: request-body parsing, the 503 when no
 * control plane is configured, status pass-through, and the broadcast that tells
 * connected dashboards to refresh. This is the surface the dashboard actually
 * talks to, and it had no tests at all.
 *
 * Both surfaces are exercised, because both mount the same routes: the hub (which
 * serves the nest dashboard) and each gaggle's own API (so a single gaggle is
 * usable without a nest).
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { startHubServer, type HubServerHandle } from '../hub/server.ts';
import { startGaggleApi, type GaggleApiHandle } from '../hub/gaggle-api.ts';
import type { HubConfig } from '../hub/config.ts';
import { createInitialState } from '../orchestrator/state.ts';
import { makeServiceConfig } from './helpers/fixtures.ts';
import { harness, startedTicket, ticketInput, WS, type Harness } from './helpers/control-fixtures.ts';
import type { ControlApi } from '../control/api.ts';

// ─── harnesses ──────────────────────────────────────────────────────────────

const hubCfg = (): HubConfig => ({
  workspaces: [],
  // Port 0 lets the OS pick, so these never collide with a running nest.
  ui: { port: 0, host: '127.0.0.1' },
  archon: { autostart: false, ui_url: 'http://localhost:3090', run_path: '/r/{run_id}', serve_command: 'x' },
});

/** Just enough HubProcessManager for the routes under test. */
const fakeManager = () =>
  ({
    list: () => [],
    get: () => undefined,
    attachStream: () => {},
    async fetchAllStates() {
      return {};
    },
    async startWorkspace() {},
    async stopWorkspace() {},
    async stopAllWorkspaces() {},
    async stopAll() {},
  }) as never;

const fakeArchon = () => ({ getState: () => ({ status: 'disabled' }) }) as never;

const servers: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.stop().catch(() => {});
});

function hub(control: ControlApi | null): HubServerHandle {
  const h = startHubServer({
    cfg: hubCfg(),
    manager: fakeManager(),
    archon: fakeArchon(),
    dashboardDir: '/nonexistent-dashboard-dir',
    control,
    history: null,
  });
  servers.push(h);
  return h;
}

function gaggle(control: ControlApi | null, hooks: Partial<{ onSync: () => Promise<unknown>; onRedispatch: (id: string) => Promise<void> }> = {}): GaggleApiHandle {
  const h = startGaggleApi({
    port: 0,
    workspaceName: WS,
    getState: () => createInitialState(makeServiceConfig()),
    control: () => control,
    ...hooks,
  });
  servers.push(h);
  return h;
}

const get = (base: string, path: string) => fetch(`${base}/api/control${path}`);
const post = (base: string, path: string, body?: unknown) =>
  fetch(`${base}/api/control${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// ─── the mount, on both surfaces ────────────────────────────────────────────

for (const surface of ['hub', 'gaggle'] as const) {
  describe(`/api/control on the ${surface}`, () => {
    const serve = (h: ApiHarness, hooks = {}) =>
      surface === 'hub' ? hub(h.api).url : gaggle(h.api, hooks).url;

    test('serves the board', async () => {
      const h = await apiHarness();
      const base = serve(h);

      const res = await get(base, `/board?workspace=${WS}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tickets: unknown[]; counts: Record<string, number> };
      expect(body.tickets).toHaveLength(1);
      expect(body.counts.running).toBe(1);
    });

    test('an operator action moves the ticket', async () => {
      const h = await apiHarness({ started: false });
      const base = serve(h);
      const ticket = (await h.store.listTickets({ workspace: WS }))[0]!;

      const res = await post(base, `/tickets/${ticket.id}/analyze`);
      expect(res.status).toBe(200);
      expect((await h.store.getTicket(ticket.id))!.status).toBe('analysis_requested');
    });

    test('an illegal action is a 409 with the reason, not a 500', async () => {
      const h = await apiHarness({ started: false });
      const base = serve(h);
      const ticket = (await h.store.listTickets({ workspace: WS }))[0]!;

      const res = await post(base, `/tickets/${ticket.id}/start`);
      expect(res.status).toBe(409);
      expect(String(((await res.json()) as { error: string }).error)).toContain('imported');
    });

    test('an unknown id is a 404', async () => {
      const base = serve(await apiHarness());
      const res = await post(base, '/tickets/00000000-0000-4000-8000-000000000000/analyze');
      expect(res.status).toBe(404);
    });

    test('a malformed JSON body is a 400, not an unhandled throw', async () => {
      const h = await apiHarness();
      const base = serve(h);
      const target = (await h.store.listTargets((await h.store.listTickets({}))[0]!.id))[0]!;

      const res = await fetch(`${base}/api/control/gates/${target.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ this is not json',
      });
      expect(res.status).toBe(400);
    });

    test('a POST with no body at all is accepted — most actions take none', async () => {
      const h = await apiHarness({ started: false });
      const base = serve(h);
      const ticket = (await h.store.listTickets({ workspace: WS }))[0]!;

      const res = await fetch(`${base}/api/control/tickets/${ticket.id}/analyze`, { method: 'POST' });
      expect(res.status).toBe(200);
    });

    test('every write route is reachable and returns JSON', async () => {
      // A smoke sweep: the router matches on path segments, so a typo in a route
      // shows up as a 404 for one action while the rest keep working.
      const h = await apiHarness();
      const base = serve(h);
      const ticket = (await h.store.listTickets({ workspace: WS }))[0]!;
      const target = (await h.store.listTargets(ticket.id))[0]!;

      for (const [method, path] of [
        ['GET', `/board?workspace=${WS}`],
        ['GET', `/gates?workspace=${WS}`],
        ['GET', `/cursor?workspace=${WS}`],
        ['GET', `/tickets/${ticket.id}`],
        ['POST', `/targets/${target.id}/exclude`],
        ['POST', `/targets/${target.id}/include`],
        ['POST', `/targets/${target.id}/cancel`],
        ['POST', `/tickets/${ticket.id}/cancel`],
      ] as const) {
        const res = await fetch(`${base}/api/control${path}`, { method });
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
        expect(res.headers.get('content-type')).toContain('application/json');
      }
    });

    test('with no control plane configured, every route answers 503 with a pointer', async () => {
      // The nest and a lone gaggle both have to keep serving without a database —
      // losing the board should not cost the operator their process controls.
      const base = surface === 'hub' ? hub(null).url : gaggle(null).url;

      for (const path of ['/board', '/gates', '/cursor']) {
        const res = await get(base, path);
        expect(res.status).toBe(503);
        expect(String(((await res.json()) as { error: string }).error)).toMatch(/control/i);
      }
      const write = await post(base, '/tickets/x/analyze');
      expect(write.status).toBe(503);
    });

    test('an unknown control route is a 404, not a fall-through', async () => {
      const res = await get(serve(await apiHarness()), '/nonsense');
      expect(res.status).toBe(404);
    });
  });
}

// ─── surface-specific ───────────────────────────────────────────────────────

describe('gaggle API — sync and redispatch', () => {
  test('POST /sync runs a pass and returns its result', async () => {
    const h = await apiHarness();
    let called = 0;
    const base = gaggle(h.api, {
      onSync: async () => {
        called++;
        return { imported: 3 };
      },
    }).url;

    const res = await fetch(`${base}/sync`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ ok: true, result: { imported: 3 } });
    expect(called).toBe(1);
  });

  test('POST /sync is a 503 when the daemon has no sync wired', async () => {
    const base = gaggle((await apiHarness()).api).url;
    expect((await fetch(`${base}/sync`, { method: 'POST' })).status).toBe(503);
  });

  test('a sync that throws is a 500 carrying the reason', async () => {
    const base = gaggle((await apiHarness()).api, {
      onSync: async () => {
        throw new Error('tracker 503');
      },
    }).url;
    const res = await fetch(`${base}/sync`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(String(((await res.json()) as { error: string }).error)).toContain('tracker 503');
  });

  test('POST /redispatch takes a target id, and rejects a request without one', async () => {
    const seen: string[] = [];
    const base = gaggle((await apiHarness()).api, {
      onRedispatch: async (id) => {
        seen.push(id);
      },
    }).url;

    const ok = await fetch(`${base}/redispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_id: 'tg-1' }),
    });
    expect(ok.status).toBe(200);
    expect(seen).toEqual(['tg-1']);

    // The old shape was `{issue_id, repo_alias}`; targets are rows now.
    const bad = await fetch(`${base}/redispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issue_id: 'i', repo_alias: 'api' }),
    });
    expect(bad.status).toBe(400);
  });

  test('/api/state reports live workers and nothing that moved to Postgres', async () => {
    const base = gaggle((await apiHarness()).api).url;
    const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;

    expect(Object.keys(state).sort()).toEqual([
      'claude_totals',
      'max_concurrent_agents',
      'poll_interval_ms',
      'running',
      'slots_used',
      'workspace',
    ]);
  });

  test('/healthz answers without a control plane', async () => {
    const res = await fetch(`${gaggle(null).url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('hub — write actions notify connected dashboards', () => {
  test('a control write broadcasts control-changed; a read does not', async () => {
    const h = await apiHarness({ started: false });
    const handle = hub(h.api);
    const ticket = (await h.store.listTickets({ workspace: WS }))[0]!;

    const messages: string[] = [];
    const ws = new WebSocket(`${handle.url.replace('http', 'ws')}/api/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws failed to open'));
    });
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)).type);

    await fetch(`${handle.url}/api/control/board?workspace=${WS}`);
    await Bun.sleep(50);
    expect(messages).not.toContain('control-changed');

    await fetch(`${handle.url}/api/control/tickets/${ticket.id}/analyze`, { method: 'POST' });
    await Bun.sleep(50);
    // Otherwise the operator waits out the poll interval to see their own click.
    expect(messages).toContain('control-changed');

    ws.close();
  });

  test('a rejected write does not broadcast — nothing changed', async () => {
    const h = await apiHarness({ started: false });
    const handle = hub(h.api);
    const ticket = (await h.store.listTickets({ workspace: WS }))[0]!;

    const messages: string[] = [];
    const ws = new WebSocket(`${handle.url.replace('http', 'ws')}/api/ws`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)).type);

    const res = await fetch(`${handle.url}/api/control/tickets/${ticket.id}/start`, { method: 'POST' });
    expect(res.status).toBe(409);
    await Bun.sleep(50);
    expect(messages).not.toContain('control-changed');

    ws.close();
  });
});

// ─── helper ─────────────────────────────────────────────────────────────────

type ApiHarness = Harness & { api: ControlApi };

/** A harness with its ControlApi attached, seeded with one ticket. */
async function apiHarness(opts: { started?: boolean } = {}): Promise<ApiHarness> {
  const h = await harness();
  if (opts.started === false) await h.store.upsertTicket(ticketInput());
  else await startedTicket(h);
  const { ControlApi } = await import('../control/api.ts');
  return Object.assign(h, {
    api: new ControlApi({ store: h.store, service: h.service }),
  });
}
