/**
 * The composition root.
 *
 * `openControlReadPlane` is what the hub runs, and it is built with executor,
 * analyzer, and tracker-structure ports that throw if anything reaches for them.
 * That design rests on a claim — "the hub's action set provably never needs them" —
 * which is worth testing in both directions: the actions it does offer must work,
 * and the guard must fail *loudly* if the claim ever stops holding, because a
 * silent no-op there would look like a working feature.
 */

import { describe, expect, test } from 'bun:test';
import { openControlPlane, openControlReadPlane, serviceConfigFrom } from '../control/index.ts';
import { MemoryControlStore } from '../control/store/memory.ts';
import { makeServiceConfig } from './helpers/fixtures.ts';
import { ticketInput, WS } from './helpers/control-fixtures.ts';
import type { ServiceConfig } from '../domain/types.ts';
import type { AnalyzerPort, ExecutorPort, RunStatusPort, SlotPort } from '../control/ports.ts';

function cfg(over: (c: ServiceConfig) => void = () => {}): ServiceConfig {
  const c = makeServiceConfig();
  c.database.url = 'unused-because-a-store-is-injected';
  c.tracker.terminal_states = ['Done'];
  c.tracker.active_states = ['Todo', 'In Progress'];
  over(c);
  return c;
}

const noTracker = () => ({}) as never;

async function readPlane() {
  const store = new MemoryControlStore();
  await store.migrate();
  const plane = await openControlReadPlane({ cfg: cfg(), store });
  return { store, plane };
}

describe('openControlReadPlane — what the hub can do', () => {
  test('it serves the board and the gates list', async () => {
    const { store, plane } = await readPlane();
    await store.upsertTicket(ticketInput());

    const res = await plane.api.handle({ method: 'GET', path: '/board', query: { workspace: WS } });
    expect(res.status).toBe(200);
    expect((res.body as { tickets: unknown[] }).tickets).toHaveLength(1);

    const gates = await plane.api.handle({ method: 'GET', path: '/gates' });
    expect(gates.status).toBe(200);
  });

  test('every operator action it offers is a pure status write, and all of them work', async () => {
    // If any of these needed the executor or the analyzer, the port guard would
    // turn it into a logged warning and the action would half-happen.
    const { store, plane } = await readPlane();
    const ticket = await store.upsertTicket(ticketInput());
    const act = (path: string) => plane.api.handle({ method: 'POST', path });

    expect((await act(`/tickets/${ticket.id}/archive`)).status).toBe(200);
    expect((await act(`/tickets/${ticket.id}/restore`)).status).toBe(200);
    expect((await act(`/tickets/${ticket.id}/analyze`)).status).toBe(200);
    expect((await store.getTicket(ticket.id))!.status).toBe('analysis_requested');

    // Reach `analyzed` the way the daemon would, then drive the rest.
    await store.updateTicket(ticket.id, { status: 'analyzed' });
    await store.replaceTargets(ticket.id, [
      { repo_alias: 'api', repo_url: 'u', local_path: 'p', workflow: 'w' },
    ]);
    const target = (await store.listTargets(ticket.id))[0]!;

    expect((await act(`/targets/${target.id}/exclude`)).status).toBe(200);
    expect((await act(`/targets/${target.id}/include`)).status).toBe(200);
    expect(
      (await plane.api.handle({
        method: 'PATCH',
        path: `/targets/${target.id}`,
        body: { workflow: 'gaggle/gaggle-supervised' },
      })).status,
    ).toBe(200);
    expect((await act(`/tickets/${ticket.id}/start`)).status).toBe(200);
    expect((await act(`/tickets/${ticket.id}/cancel`)).status).toBe(200);
    expect((await store.getTicket(ticket.id))!.status).toBe('cancelled');
  });

  test('a gate answer is recorded as intent, reaching no executor', async () => {
    // The whole reason gate answers take the intent path: resuming a run needs the
    // executor, and the hub has none.
    const { store, plane } = await readPlane();
    const ticket = await store.upsertTicket(ticketInput());
    await store.updateTicket(ticket.id, { status: 'running' });
    const [target] = await store.replaceTargets(ticket.id, [
      { repo_alias: 'api', repo_url: 'u', local_path: 'p', workflow: 'w' },
    ]);
    await store.updateTarget(target!.id, { status: 'gate_waiting', gate_message: 'ok?' });

    const res = await plane.api.handle({
      method: 'POST',
      path: `/gates/${target!.id}/approve`,
      body: { comment: 'ship it' },
    });

    expect(res.status).toBe(200);
    const after = await store.getTarget(target!.id);
    expect(after!.gate_decision).toBe('approved');
    expect(after!.gate_decision_comment).toBe('ship it');
    // Untouched until a daemon acts.
    expect(after!.status).toBe('gate_waiting');
  });

  test('sync is a 503 when no gaggle is reachable, and proxied when one is', async () => {
    const { plane } = await readPlane();
    expect((await plane.api.handle({ method: 'POST', path: '/sync' })).status).toBe(503);

    const store = new MemoryControlStore();
    await store.migrate();
    const withSync = await openControlReadPlane({
      cfg: cfg(),
      store,
      requestSync: async () => ({ imported: 2 }),
    });
    const res = await withSync.api.handle({ method: 'POST', path: '/sync' });
    expect(res.status).toBe(200);
    expect((res.body as { result: unknown }).result).toEqual({ imported: 2 });
  });
});

describe('openControlReadPlane — the port guard fails loudly', () => {
  test('reaching for the analyzer records why, on the ticket, where it is visible', async () => {
    // The guard exists so that if "the hub never needs these" ever stops being
    // true, the reason lands somewhere an operator can read. A port that silently
    // no-opped would leave a ticket stuck with no explanation.
    const { store, plane } = await readPlane();
    const ticket = await store.upsertTicket(ticketInput());
    await store.updateTicket(ticket.id, { status: 'analyzing' });

    await plane.service.runAnalysis((await store.getTicket(ticket.id))!);

    const after = await store.getTicket(ticket.id);
    expect(after!.status).toBe('analysis_failed');
    expect(after!.analysis_error).toMatch(/analyzer port is not available/i);
    expect(after!.analysis_error).toMatch(/recorded as intent/i);
  });

  test('the read plane cannot dispatch at all — it owns no workspace to claim from', async () => {
    // Stronger than "it would fail if it tried": the claim is scoped by workspace
    // and the read plane has none, so a ready target is invisible to it. The
    // executor port is unreachable by construction rather than by convention.
    const { store, plane } = await readPlane();
    const ticket = await store.upsertTicket(ticketInput());
    await store.updateTicket(ticket.id, { status: 'running' });
    const [target] = await store.replaceTargets(ticket.id, [
      { repo_alias: 'api', repo_url: 'u', local_path: 'p', workflow: 'w' },
    ]);
    await store.updateTarget(target!.id, { status: 'ready' });

    expect(await plane.service.claimAndDispatch(5)).toEqual([]);
    expect(await plane.service.claimAnalysisWork(5)).toEqual([]);
    // Untouched, and still there for the owning daemon to pick up.
    expect((await store.getTarget(target!.id))!.status).toBe('ready');
  });

  test('the guard names the method that reached for it', async () => {
    // So the log says what to wire up, not just that something was missing.
    const { plane } = await readPlane();
    let message = '';
    try {
      await (plane.service as unknown as { deps: { executor: { killRun(): Promise<void> } } }).deps.executor.killRun();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('killRun');
    expect(message).toContain('executor');
  });
});

describe('openControlPlane — the daemon half', () => {
  test('it builds every piece and runs migrations', async () => {
    const store = new MemoryControlStore();
    let migrated = 0;
    const wrapped = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
      migrate: async () => {
        migrated++;
      },
    }) as MemoryControlStore;

    const plane = await openControlPlane({
      cfg: cfg(),
      workspace: WS,
      tracker: noTracker(),
      executor: {} as ExecutorPort,
      runs: {} as RunStatusPort,
      analyzer: {} as AnalyzerPort,
      slots: { availableSlots: () => 1 } as SlotPort,
      store: wrapped,
    });

    expect(migrated).toBe(1);
    expect(plane.store).toBe(wrapped);
    expect(plane.service).toBeTruthy();
    expect(plane.sync).toBeTruthy();
    expect(plane.reconciler).toBeTruthy();
    expect(plane.api).toBeTruthy();
  });

  test('the outbox drainer is scoped to this workspace', async () => {
    // A drainer that took another workspace's rows would send them through the
    // wrong tracker client with the wrong state names.
    const store = new MemoryControlStore();
    await store.migrate();
    await store.enqueueOutbox({ workspace: 'someone-else', external_id: 'x', op: 'set_state', payload: { state: 'Done' } });
    await store.enqueueOutbox({ workspace: WS, external_id: 'mine', op: 'set_state', payload: { state: 'Done' } });

    const sent: string[] = [];
    const plane = await openControlPlane({
      cfg: cfg(),
      workspace: WS,
      tracker: {
        async updateIssueState(id: string) {
          sent.push(id);
        },
        async postComment() {
          return { id: 'c' };
        },
        async applyLabel() {},
        async removeLabel() {},
      } as never,
      executor: {} as ExecutorPort,
      runs: {} as RunStatusPort,
      analyzer: {} as AnalyzerPort,
      slots: { availableSlots: () => 1 } as SlotPort,
      store,
    });

    await plane.reconciler.drainOutbox();
    expect(sent).toEqual(['mine']);
  });
});

describe('serviceConfigFrom', () => {
  test('carries the label mirror setting and the gate states through', async () => {
    const c = cfg((x) => {
      x.tracker.mirror_labels = true;
      x.tracker.gate_waiting_state = 'Blocked';
      x.tracker.gate_resume_state = 'In Progress';
      x.tracker.pr_ready_state = 'In Review';
    });
    const sc = serviceConfigFrom(c, WS);

    expect(sc.workspace).toBe(WS);
    expect(sc.mirror_labels).toBe(true);
    expect(sc.gate_waiting_state).toBe('Blocked');
    expect(sc.gate_resume_state).toBe('In Progress');
    // `completedState` prefers pr_ready_state over the first terminal state.
    expect(sc.completed_state).toBe('In Review');
    expect(sc.labels.analyzing).toBeTruthy();
  });

  test('a null gate_resume_state stays null rather than defaulting', async () => {
    // Otherwise every gate close would write a tracker state the operator never
    // asked for.
    const sc = serviceConfigFrom(cfg((x) => { x.tracker.gate_resume_state = null; }), WS);
    expect(sc.gate_resume_state).toBeNull();
  });
});

