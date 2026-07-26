/**
 * The board API.
 *
 * Route-level tests over a seeded store: each action's happy path, its 409 when
 * the world moved on, and its 404 when the id does not resolve.
 */

import { describe, expect, test } from 'bun:test';
import { ControlApi, type ApiRequest } from '../control/api.ts';
import { Reconciler } from '../control/reconciler.ts';
import type { RunStatusPort, SlotPort } from '../control/ports.ts';
import {
  FakeTrackerWrites,
  harness,
  startedTicket,
  targetSpec,
  ticketInput,
  WS,
  type Harness,
} from './helpers/control-fixtures.ts';

const MISSING = '00000000-0000-4000-8000-000000000000';

async function api(h: Harness, opts: { readOnly?: boolean; sync?: boolean } = {}) {
  return new ControlApi({
    store: h.store,
    service: opts.readOnly ? null : h.service,
    requestSync: opts.sync ? async () => ({ imported: 1 }) : undefined,
  });
}

function get(path: string, query?: Record<string, string>): ApiRequest {
  return { method: 'GET', path, query };
}
function post(path: string, body?: unknown): ApiRequest {
  return { method: 'POST', path, body };
}

/** A reconciler wired to fakes, for the tests that need the daemon half. */
function daemon(h: Harness) {
  const runs: RunStatusPort = { observeRun: async () => ({ status: 'unknown' }) };
  const slots: SlotPort = { availableSlots: () => 5 };
  return new Reconciler({
    store: h.store,
    service: h.service,
    tracker: h.tracker,
    slots,
    runs,
    trackerWrites: new FakeTrackerWrites(),
    cfg: { workspace: WS, gate_timeout_ms: 0, outbox: { batch_size: 50, max_attempts: 5 } },
  });
}

describe('ControlApi — board', () => {
  test('the board returns tickets with their targets, counts, and a cursor', async () => {
    const h = await harness();
    await startedTicket(h, [targetSpec({ repo_alias: 'api' }), targetSpec({ repo_alias: 'web' })]);
    const a = await api(h);

    const res = await a.handle(get('/board', { workspace: WS }));

    expect(res.status).toBe(200);
    const body = res.body as {
      tickets: Array<{ ticket: { identifier: string }; targets: Array<{ repo_alias: string }> }>;
      counts: Record<string, number>;
      latest_event_id: number;
    };
    expect(body.tickets).toHaveLength(1);
    expect(body.tickets[0]!.ticket.identifier).toBe('GAG-1');
    expect(body.tickets[0]!.targets.map((t) => t.repo_alias)).toEqual(['api', 'web']);
    expect(body.counts.running).toBe(1);
    expect(body.latest_event_id).toBeGreaterThan(0);
  });

  test('the board filters by status and search', async () => {
    const h = await harness();
    await h.store.upsertTicket(ticketInput({ external_id: 'l1', identifier: 'GAG-1', title: 'Widget' }));
    await h.store.upsertTicket(ticketInput({ external_id: 'l2', identifier: 'GAG-2', title: 'Gadget' }));
    const a = await api(h);

    const byStatus = await a.handle(get('/board', { workspace: WS, status: 'imported' }));
    expect((byStatus.body as { tickets: unknown[] }).tickets).toHaveLength(2);

    const bySearch = await a.handle(get('/board', { workspace: WS, q: 'gadget' }));
    expect((bySearch.body as { tickets: Array<{ ticket: { identifier: string } }> }).tickets[0]!.ticket.identifier).toBe('GAG-2');

    const none = await a.handle(get('/board', { workspace: WS, status: 'done' }));
    expect((none.body as { tickets: unknown[] }).tickets).toHaveLength(0);
  });

  test('an unknown status is a 400, not an empty board', async () => {
    const h = await harness();
    const res = await (await api(h)).handle(get('/board', { status: 'nonsense' }));
    expect(res.status).toBe(400);
    expect(String((res.body as { error: string }).error)).toContain('nonsense');
  });

  test('a bad limit or offset is a 400', async () => {
    const h = await harness();
    const a = await api(h);
    expect((await a.handle(get('/board', { limit: '0' }))).status).toBe(400);
    expect((await a.handle(get('/board', { limit: 'abc' }))).status).toBe(400);
    expect((await a.handle(get('/board', { offset: '-1' }))).status).toBe(400);
  });

  test('the ticket detail includes targets and the event timeline', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    const res = await (await api(h)).handle(get(`/tickets/${ticket.id}`));

    expect(res.status).toBe(200);
    const body = res.body as {
      ticket: { identifier: string };
      targets: unknown[];
      events: Array<{ event_kind: string }>;
    };
    expect(body.ticket.identifier).toBe('GAG-1');
    expect(body.targets).toHaveLength(1);
    expect(body.events.map((e) => e.event_kind)).toContain('start_requested');
  });

  test('an unknown ticket is a 404', async () => {
    const h = await harness();
    expect((await (await api(h)).handle(get(`/tickets/${MISSING}`))).status).toBe(404);
  });

  test('a malformed id is a 404, not a crash', async () => {
    const h = await harness();
    expect((await (await api(h)).handle(get('/tickets/not-a-uuid'))).status).toBe(404);
  });

  test('the cursor is a cheap way to detect change', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    const a = await api(h);
    const before = (await a.handle(get('/cursor', { workspace: WS }))).body as { latest_event_id: number };
    await h.service.requestAnalysis(ticket.id);
    const after = (await a.handle(get('/cursor', { workspace: WS }))).body as { latest_event_id: number };
    expect(after.latest_event_id).toBeGreaterThan(before.latest_event_id);
  });

  test('an unknown route is a 404', async () => {
    const h = await harness();
    expect((await (await api(h)).handle(get('/nope'))).status).toBe(404);
  });
});

describe('ControlApi — ticket actions', () => {
  test('Analyze then Start walks the ticket to running', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    const a = await api(h);

    expect((await a.handle(post(`/tickets/${ticket.id}/analyze`))).status).toBe(200);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('analysis_requested');

    const claimed = await h.service.claimAnalysisWork(10);
    await h.service.runAnalysis(claimed[0]!);

    expect((await a.handle(post(`/tickets/${ticket.id}/start`))).status).toBe(200);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('running');
  });

  test('Start before Analyze is a 409 that names the problem', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    const res = await (await api(h)).handle(post(`/tickets/${ticket.id}/start`));
    expect(res.status).toBe(409);
    expect(String((res.body as { error: string }).error)).toContain('imported');
  });

  test('pressing Start twice yields one 200 and one 409', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    const res = await (await api(h)).handle(post(`/tickets/${ticket.id}/start`));
    expect(res.status).toBe(409);
    expect(h.executor.spawned).toEqual([]);
  });

  test('cancel, archive, and restore are routed', async () => {
    const h = await harness();
    const a = await api(h);

    const one = await h.store.upsertTicket(ticketInput({ external_id: 'l1', identifier: 'GAG-1' }));
    expect((await a.handle(post(`/tickets/${one.id}/archive`))).status).toBe(200);
    expect((await a.handle(post(`/tickets/${one.id}/restore`))).status).toBe(200);
    expect((await h.store.getTicket(one.id))!.status).toBe('imported');

    const two = await startedTicket(h, [targetSpec()], { external_id: 'l2', identifier: 'GAG-2' });
    expect((await a.handle(post(`/tickets/${two.id}/cancel`))).status).toBe(200);
    expect((await h.store.getTicket(two.id))!.status).toBe('cancelled');
  });

  test('archiving a running ticket is a 409', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    expect((await (await api(h)).handle(post(`/tickets/${ticket.id}/archive`))).status).toBe(409);
  });

  test('an unknown action is a 404', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    expect((await (await api(h)).handle(post(`/tickets/${ticket.id}/frobnicate`))).status).toBe(404);
  });

  test('acting on an unknown ticket is a 404', async () => {
    const h = await harness();
    expect((await (await api(h)).handle(post(`/tickets/${MISSING}/analyze`))).status).toBe(404);
  });
});

describe('ControlApi — target actions', () => {
  test('exclude and include round-trip', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    const a = await api(h);

    expect((await a.handle(post(`/targets/${target.id}/exclude`))).status).toBe(200);
    expect((await h.store.getTarget(target.id))!.status).toBe('excluded');
    expect((await a.handle(post(`/targets/${target.id}/include`))).status).toBe(200);
    expect((await h.store.getTarget(target.id))!.status).toBe('blocked');
  });

  test('cancel on a live target records intent rather than killing inline', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;

    expect((await (await api(h)).handle(post(`/targets/${target.id}/cancel`))).status).toBe(200);
    const after = await h.store.getTarget(target.id);
    expect(after!.status).toBe('running');
    expect(after!.cancel_requested).toBe(true);
    expect(h.executor.killed).toEqual([]);
  });

  test('redispatch puts a failed target back in the queue', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.runFailed(target.id, 'boom');

    expect((await (await api(h)).handle(post(`/targets/${target.id}/redispatch`))).status).toBe(200);
    expect((await h.store.getTarget(target.id))!.status).toBe('ready');
  });

  test('redispatching a running target is a 409', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    expect((await (await api(h)).handle(post(`/targets/${target.id}/redispatch`))).status).toBe(409);
  });

  test('the workflow can be corrected before dispatch', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    const target = (await h.store.listTargets(ticket.id))[0]!;

    const res = await (await api(h)).handle({
      method: 'PATCH',
      path: `/targets/${target.id}`,
      body: { workflow: 'gaggle/gaggle-supervised' },
    });

    expect(res.status).toBe(200);
    expect((await h.store.getTarget(target.id))!.workflow).toBe('gaggle/gaggle-supervised');
  });

  test('a workflow patch needs a non-empty string', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    const a = await api(h);
    for (const body of [{}, { workflow: '' }, { workflow: 42 }, null]) {
      const res = await a.handle({ method: 'PATCH', path: `/targets/${target.id}`, body });
      expect(res.status).toBe(400);
    }
  });
});

describe('ControlApi — gates', () => {
  test('approving records intent; the daemon carries it out', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'appr-1', 'ok?');

    const res = await (await api(h)).handle(post(`/gates/${target.id}/approve`, { comment: 'ship it' }));

    expect(res.status).toBe(200);
    expect((res.body as { pending: boolean }).pending).toBe(true);
    // Intent only — the executor has not been touched.
    let after = await h.store.getTarget(target.id);
    expect(after!.status).toBe('gate_waiting');
    expect(after!.gate_decision).toBe('approved');
    expect(h.executor.approved).toEqual([]);

    const answered = await daemon(h).applyGateDecisions();

    expect(answered).toBe(1);
    after = await h.store.getTarget(target.id);
    expect(after!.status).toBe('running');
    expect(after!.gate_decision).toBeNull();
    expect(h.executor.approved).toEqual([{ approval_id: 'appr-1', comment: 'ship it', alias: 'api' }]);
  });

  test('a gate answered while the daemon is down is honoured when it returns', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'appr-1', 'ok?');

    await (await api(h)).handle(post(`/gates/${target.id}/approve`, {}));
    // ... time passes, daemon restarts ...
    await daemon(h).tick();

    expect((await h.store.getTarget(target.id))!.status).toBe('running');
  });

  test('rejecting requires a reason', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'a', 'ok?');
    const a = await api(h);

    expect((await a.handle(post(`/gates/${target.id}/reject`, {}))).status).toBe(400);
    expect((await a.handle(post(`/gates/${target.id}/reject`, { reason: '' }))).status).toBe(400);
    expect((await a.handle(post(`/gates/${target.id}/reject`, { reason: 'wrong shape' }))).status).toBe(200);

    await daemon(h).applyGateDecisions();
    expect(h.executor.rejected[0]!.reason).toBe('wrong shape');
  });

  test('a blocker decision reaches the tracker through the daemon', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'a', 'ok?');

    const res = await (await api(h)).handle(
      post(`/gates/${target.id}/create-blocker`, { title: 'Need a field', description: 'why' }),
    );
    expect(res.status).toBe(200);

    await daemon(h).applyGateDecisions();

    expect((await h.store.getTarget(target.id))!.status).toBe('blocked');
    expect(h.tracker.blockers[0]!.spec.title).toBe('Need a field');
  });

  test('a blocker decision needs a title', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'a', 'ok?');
    const res = await (await api(h)).handle(post(`/gates/${target.id}/create-blocker`, { description: 'x' }));
    expect(res.status).toBe(400);
  });

  test('two operators answering one gate resolve to the first', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'a', 'ok?');
    const a = await api(h);

    expect((await a.handle(post(`/gates/${target.id}/approve`, { comment: 'first' }))).status).toBe(200);
    const second = await a.handle(post(`/gates/${target.id}/reject`, { reason: 'second' }));

    expect(second.status).toBe(409);
    expect(String((second.body as { error: string }).error)).toContain('already answered');

    await daemon(h).applyGateDecisions();
    expect(h.executor.approved).toHaveLength(1);
    expect(h.executor.rejected).toHaveLength(0);
  });

  test('answering a target that is not at a gate is a 409 that says so', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;

    const res = await (await api(h)).handle(post(`/gates/${target.id}/approve`, {}));
    expect(res.status).toBe(409);
    expect(String((res.body as { error: string }).error)).toContain('running');
  });

  test('answering an unknown target is a 404', async () => {
    const h = await harness();
    expect((await (await api(h)).handle(post(`/gates/${MISSING}/approve`, {}))).status).toBe(404);
  });

  test('an unreadable blocker payload degrades to a rejection rather than wedging', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'a', 'ok?');
    // Bypass the API's validation to simulate a corrupted row.
    await h.store.requestGateDecision(target.id, 'blocker', 'not json');

    await daemon(h).applyGateDecisions();

    expect(h.tracker.blockers).toHaveLength(0);
    expect(h.executor.rejected).toHaveLength(1);
    expect((await h.store.getTarget(target.id))!.gate_decision).toBeNull();
  });

  test('the gates list shows an open gate and its pending answer', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'appr-1', 'Approve the plan?');
    const a = await api(h);

    let body = (await a.handle(get('/gates', { workspace: WS }))).body as {
      gates: Array<{ gate_message: string; pending_decision: string | null }>;
    };
    expect(body.gates[0]!.gate_message).toBe('Approve the plan?');
    expect(body.gates[0]!.pending_decision).toBeNull();

    await a.handle(post(`/gates/${target.id}/approve`, {}));
    body = (await a.handle(get('/gates', { workspace: WS }))).body as typeof body;
    expect(body.gates[0]!.pending_decision).toBe('approved');
  });
});

describe('ControlApi — sync and read-only mode', () => {
  test('sync is proxied when a gaggle is reachable', async () => {
    const h = await harness();
    const res = await (await api(h, { sync: true })).handle(post('/sync'));
    expect(res.status).toBe(200);
    expect((res.body as { result: { imported: number } }).result.imported).toBe(1);
  });

  test('sync is a 503 when no gaggle is reachable', async () => {
    const h = await harness();
    expect((await (await api(h)).handle(post('/sync'))).status).toBe(503);
  });

  test('reads still work with writes unconfigured, and writes answer 503', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    const a = await api(h, { readOnly: true });

    expect((await a.handle(get('/board', { workspace: WS }))).status).toBe(200);
    expect((await a.handle(get(`/tickets/${ticket.id}`))).status).toBe(200);
    expect((await a.handle(post(`/tickets/${ticket.id}/start`))).status).toBe(503);
  });
});
