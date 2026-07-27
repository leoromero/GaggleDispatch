/**
 * The daemon loop.
 *
 * The headline assertions: a tick over an imported ticket does nothing at all,
 * slots bound dispatch, an `unknown` run is never mistaken for a failed one, and
 * a target stranded by a crash comes back.
 */

import { describe, expect, test } from 'bun:test';
import { Reconciler, type ReconcilerConfig } from '../control/reconciler.ts';
import type { RunObservation, RunStatusPort, SlotPort } from '../control/ports.ts';
import {
  FakeTrackerWrites,
  harness,
  startedTicket,
  targetSpec,
  ticketInput,
  WS,
  type Harness,
} from './helpers/control-fixtures.ts';

/** A fixed ceiling, so tests exercise the reconciler's live-count query for real. */
class FixedSlots implements SlotPort {
  constructor(public slots: number) {}
  availableSlots(liveCount: number): number {
    return Math.max(0, this.slots - liveCount);
  }
}

class FakeRuns implements RunStatusPort {
  observations = new Map<string, RunObservation>();
  asked: string[] = [];
  error: string | null = null;
  /** Run ids to throw for, for testing isolation between targets. */
  failFor = new Set<string>();

  async observeRun(runId: string): Promise<RunObservation> {
    this.asked.push(runId);
    if (this.error) throw new Error(this.error);
    if (this.failFor.has(runId)) throw new Error(`executor lost run ${runId}`);
    return this.observations.get(runId) ?? { status: 'unknown' };
  }
}

function reconcilerConfig(over: Partial<ReconcilerConfig> = {}): ReconcilerConfig {
  return {
    workspace: WS,
    gate_timeout_ms: 0,
    // Zero by default so tests exercise the logic rather than waiting out a window.
    // The grace-window behaviour has its own tests, which set these explicitly.
    gate_reopen_grace_ms: 0,
    stranded_claim_grace_ms: 0,
    outbox: { workspace: WS, batch_size: 50, max_attempts: 5 },
    ...over,
  };
}

async function rig(
  cfgOver: Partial<ReconcilerConfig> = {},
  slots = 5,
): Promise<{
  h: Harness;
  runs: FakeRuns;
  writes: FakeTrackerWrites;
  slots: FixedSlots;
  reconciler: Reconciler;
}> {
  const h = await harness();
  const runs = new FakeRuns();
  const writes = new FakeTrackerWrites();
  const slotPort = new FixedSlots(slots);
  const reconciler = new Reconciler({
    store: h.store,
    service: h.service,
    tracker: h.tracker,
    slots: slotPort,
    runs,
    trackerWrites: writes,
    cfg: reconcilerConfig(cfgOver),
  });
  return { h, runs, writes, slots: slotPort, reconciler };
}

describe('Reconciler — nothing runs without a click', () => {
  test('a tick over an imported ticket does nothing', async () => {
    const { h, reconciler } = await rig();
    await h.store.upsertTicket(ticketInput());

    const result = await reconciler.tick();

    expect(result.analyzed).toBe(0);
    expect(result.dispatched).toBe(0);
    expect(h.analyzer.calls).toEqual([]);
    expect(h.executor.spawned).toEqual([]);
  });

  test('an analyzed ticket is still not dispatched until Start', async () => {
    const { h, reconciler } = await rig();
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.requestAnalysis(ticket.id);
    await reconciler.tick();

    expect((await h.store.getTicket(ticket.id))!.status).toBe('analyzed');
    const result = await reconciler.tick();
    expect(result.dispatched).toBe(0);
    expect(h.executor.spawned).toEqual([]);
  });
});

describe('Reconciler — analysis', () => {
  test('a tick analyzes a requested ticket', async () => {
    const { h, reconciler } = await rig();
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.requestAnalysis(ticket.id);

    const result = await reconciler.tick();

    expect(result.analyzed).toBe(1);
    expect(h.analyzer.calls).toEqual(['GAG-1']);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('analyzed');
  });

  test('analysis is bounded by available slots', async () => {
    const { h, reconciler } = await rig({}, 1);
    for (const i of [1, 2, 3]) {
      const t = await h.store.upsertTicket(ticketInput({ external_id: `lin-${i}`, identifier: `GAG-${i}` }));
      await h.service.requestAnalysis(t.id);
    }
    expect((await reconciler.tick()).analyzed).toBe(1);
    expect((await reconciler.tick()).analyzed).toBe(1);
  });

  test('with no slots free, nothing is analyzed', async () => {
    const { h, reconciler } = await rig({}, 0);
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.requestAnalysis(ticket.id);
    expect((await reconciler.tick()).analyzed).toBe(0);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('analysis_requested');
  });
});

describe('Reconciler — dispatch', () => {
  test('a started ticket is dispatched on the next tick', async () => {
    const { h, reconciler } = await rig();
    const ticket = await startedTicket(h);

    const result = await reconciler.tick();

    expect(result.dispatched).toBe(1);
    expect(h.executor.spawned).toHaveLength(1);
    expect((await h.store.listTargets(ticket.id))[0]!.status).toBe('running');
  });

  test('the slot limit is a concurrency ceiling, not a per-tick budget', async () => {
    const { h, runs, reconciler } = await rig({}, 2);
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'a' }),
      targetSpec({ repo_alias: 'b' }),
      targetSpec({ repo_alias: 'c' }),
    ]);

    expect((await reconciler.tick()).dispatched).toBe(2);
    // Both slots are occupied by live runs, so no amount of ticking starts the
    // third. A per-tick budget would wrongly let it through here.
    expect((await reconciler.tick()).dispatched).toBe(0);
    expect((await reconciler.tick()).dispatched).toBe(0);

    // One finishes; the freed slot is used on the very next tick.
    const running = (await h.store.listTargets(ticket.id)).filter((t) => t.status === 'running');
    runs.observations.set(running[0]!.run_id!, { status: 'completed' });
    expect((await reconciler.tick()).dispatched).toBe(1);
    expect(h.executor.spawned).toHaveLength(3);
  });

  test('a gate_waiting target still holds its slot', async () => {
    const { h, reconciler } = await rig({}, 1);
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'a' }),
      targetSpec({ repo_alias: 'b' }),
    ]);
    await reconciler.tick();
    const live = (await h.store.listTargets(ticket.id)).find((t) => t.status === 'running')!;
    await h.service.gateOpened(live.id, 'appr-1', 'ok?');

    // A paused run still owns its worktree, so the second target waits.
    expect((await reconciler.tick()).dispatched).toBe(0);
  });

  test('zero slots means no dispatch and the targets stay ready', async () => {
    const { h, reconciler } = await rig({}, 0);
    const ticket = await startedTicket(h);
    expect((await reconciler.tick()).dispatched).toBe(0);
    expect((await h.store.listTargets(ticket.id))[0]!.status).toBe('ready');
  });

  test('a dependent target is dispatched only after its upstream succeeds', async () => {
    const { h, runs, reconciler } = await rig();
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'api' }),
      targetSpec({ repo_alias: 'web', depends_on: ['api'] }),
    ]);

    expect((await reconciler.tick()).dispatched).toBe(1);
    const api = (await h.store.listTargets(ticket.id)).find((t) => t.repo_alias === 'api')!;
    expect(h.executor.spawned[0]!.target.repo_alias).toBe('api');

    runs.observations.set(api.run_id!, { status: 'completed' });
    const second = await reconciler.tick();

    expect(second.reconciled).toBe(1);
    expect(second.promoted).toBeGreaterThan(0);
    expect(second.dispatched).toBe(1);
    expect(h.executor.spawned.map((s) => s.target.repo_alias)).toEqual(['api', 'web']);
  });
});

describe('Reconciler — run observation', () => {
  test('a completed run succeeds the target and settles the ticket', async () => {
    const { h, runs, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    runs.observations.set(target.run_id!, { status: 'completed' });

    const result = await reconciler.tick();

    expect(result.reconciled).toBe(1);
    expect((await h.store.getTarget(target.id))!.status).toBe('succeeded');
    expect((await h.store.getTicket(ticket.id))!.status).toBe('done');
  });

  test('a failed run parks the target with the executor reason', async () => {
    const { h, runs, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    runs.observations.set(target.run_id!, { status: 'failed', error: 'node 12 blew up' });

    await reconciler.tick();

    const after = await h.store.getTarget(target.id);
    expect(after!.status).toBe('failed');
    expect(after!.failure_reason).toBe('node 12 blew up');
  });

  test('an unknown run is left alone, not treated as a failure', async () => {
    const { h, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;

    // FakeRuns answers `unknown` for anything it was not told about.
    const result = await reconciler.tick();

    expect(result.reconciled).toBe(0);
    expect((await h.store.getTarget(target.id))!.status).toBe('running');
    expect((await h.store.getTicket(ticket.id))!.status).toBe('running');
  });

  test('one unobservable run does not stop the workspace being reconciled', async () => {
    // Without per-target isolation the throw escapes reconcileRuns, `step()`
    // swallows it, and every other live target in the workspace goes unreconciled
    // — one stuck row becomes a workspace-wide outage visible only as a log line.
    const { h, runs, reconciler } = await rig();
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'a' }),
      targetSpec({ repo_alias: 'b' }),
    ]);
    await reconciler.tick();
    const targets = await h.store.listTargets(ticket.id);
    runs.failFor.add(targets[0]!.run_id!);
    runs.observations.set(targets[1]!.run_id!, { status: 'completed' });

    const result = await reconciler.tick();

    expect(result.reconciled).toBe(1);
    expect((await h.store.getTarget(targets[1]!.id))!.status).toBe('succeeded');
    expect((await h.store.getTarget(targets[0]!.id))!.status).toBe('running');
  });

  test('a paused run opens a gate the dashboard can see', async () => {
    const { h, runs, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    runs.observations.set(target.run_id!, {
      status: 'paused',
      approval: { id: 'appr-7', message: 'Approve the plan?' },
    });

    await reconciler.tick();

    const gates = await h.store.listPendingGates(WS);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.gate_message).toBe('Approve the plan?');
    expect(gates[0]!.approval_id).toBe('appr-7');
  });

  test('a gate whose question changed is re-asked, not silently updated', async () => {
    // Startup recovery appends its `at_most_once` warning to a gate that was
    // already pending — only one gate may be pending, so it cannot raise its
    // own. Without this the control plane keeps the pre-crash question, and the
    // operator approves having never been told that a node may already have
    // opened a pull request. That is precisely what the marker exists to stop.
    const { h, runs, writes, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;

    runs.observations.set(target.run_id!, {
      status: 'paused',
      approval: { id: 'appr-1', message: 'Approve the plan?' },
    });
    await reconciler.tick();
    expect((await h.store.getTarget(target.id))!.status).toBe('gate_waiting');
    const commentsBefore = writes.comments.length;

    // Recovery rewrites the question.
    runs.observations.set(target.run_id!, {
      status: 'paused',
      approval: {
        id: 'appr-1',
        message:
          'Approve the plan?\n\n---\n\nAlso: create-pr was interrupted and may already have run.',
      },
    });
    await reconciler.tick();

    const gates = await h.store.listPendingGates(WS);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.gate_message).toContain('may already have run');
    // Told, not just recorded — the old question is already on the tracker.
    expect(writes.comments.length).toBe(commentsBefore + 1);
    expect(writes.comments.at(-1)!.body).toMatch(/question changed/i);
    expect(writes.comments.at(-1)!.body).toContain('may already have run');
  });

  test('an unchanged question is not re-asked on every tick', async () => {
    // The other half: the reconciler sees the same paused gate every tick, and
    // must not post a comment each time.
    const { h, runs, writes, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    runs.observations.set(target.run_id!, {
      status: 'paused',
      approval: { id: 'appr-1', message: 'Approve the plan?' },
    });

    await reconciler.tick();
    const after = writes.comments.length;
    await reconciler.tick();
    await reconciler.tick();

    expect(writes.comments.length).toBe(after);
    expect(await h.store.listPendingGates(WS)).toHaveLength(1);
  });

  test('a paused run with no approval detail does not open a gate', async () => {
    const { h, runs, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    runs.observations.set(target.run_id!, { status: 'paused', approval: null });

    await reconciler.tick();
    expect((await h.store.getTarget(target.id))!.status).toBe('running');
  });

  test('a gate whose run reports running is left for a human, not auto-approved', async () => {
    // The reconciler used to approve on the operator's behalf here. That made an
    // approval we had just applied — which leaves the target `running` while
    // Archon still says `paused` — come back round as a second approval on the
    // next tick, spawning a second resume subprocess. A desynced gate is safer
    // left visible than resolved by a guess.
    const { h, runs, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'appr-1', 'ok?');

    runs.observations.set(target.run_id!, { status: 'running' });
    await reconciler.tick();

    expect((await h.store.getTarget(target.id))!.status).toBe('gate_waiting');
    expect(await h.store.listPendingGates(WS)).toHaveLength(1);
    expect(h.executor.approved).toEqual([]);
  });

  test('an approved gate is not re-opened while the executor is still resuming', async () => {
    const { h, runs, writes, reconciler } = await rig({ gate_reopen_grace_ms: 60_000 });
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'appr-1', 'ok?');
    await h.service.approveGate(target.id, 'looks good');

    // Archon keeps reporting the old gate for a moment after being resumed.
    runs.observations.set(target.run_id!, {
      status: 'paused',
      approval: { id: 'appr-1', message: 'ok?' },
    });
    await reconciler.tick();
    await reconciler.tick();

    expect((await h.store.getTarget(target.id))!.status).toBe('running');
    expect(await h.store.listPendingGates(WS)).toHaveLength(0);
    // One approval, and one gate comment — not two of each.
    expect(h.executor.approved).toHaveLength(1);
    // The tick drains the outbox, so assert on what actually reached the tracker.
    expect(writes.comments).toHaveLength(1);
  });

  test('a run that ends while its gate is open still settles the target', async () => {
    // Without a `run_failed` exit from `gate_waiting` the transition throws every
    // tick, and — before per-target isolation — took every other target in the
    // workspace down with it.
    const { h, runs, reconciler } = await rig();
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'api' }),
      targetSpec({ repo_alias: 'web' }),
    ]);
    await reconciler.tick();
    const targets = await h.store.listTargets(ticket.id);
    const [api, web] = targets as [typeof targets[0], typeof targets[0]];
    await h.service.gateOpened(api.id, 'appr-1', 'ok?');

    runs.observations.set(api.run_id!, { status: 'failed', error: 'the run crashed' });
    runs.observations.set(web.run_id!, { status: 'completed' });
    await reconciler.tick();

    const after = Object.fromEntries(
      (await h.store.listTargets(ticket.id)).map((t) => [t.repo_alias, t]),
    );
    expect(after.api!.status).toBe('failed');
    expect(after.api!.failure_reason).toBe('the run crashed');
    // The sibling was reconciled in the same pass rather than being blocked by it.
    expect(after.web!.status).toBe('succeeded');
  });

  test('a run that completes while its gate is open succeeds the target', async () => {
    const { h, runs, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'appr-1', 'ok?');

    runs.observations.set(target.run_id!, { status: 'completed' });
    await reconciler.tick();

    expect((await h.store.getTarget(target.id))!.status).toBe('succeeded');
    expect((await h.store.getTicket(ticket.id))!.status).toBe('done');
  });

  test('an executor that cannot be reached leaves state untouched', async () => {
    const { h, runs, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    runs.error = 'connection refused';

    const result = await reconciler.tick();

    expect(result.reconciled).toBe(0);
    expect((await h.store.listTargets(ticket.id))[0]!.status).toBe('running');
  });

  test('targets without a run id are not asked about', async () => {
    const { h, runs, reconciler } = await rig();
    h.executor.nextRunId = null;
    await startedTicket(h);
    await reconciler.tick();
    runs.asked = [];
    await reconciler.tick();
    expect(runs.asked).toEqual([]);
  });
});

describe('Reconciler — sub-issues', () => {
  test('a single-repo ticket gets no sub-issue — the ticket itself is the issue', async () => {
    // A sub-issue of a one-repo ticket duplicates its parent, and every tracker
    // write for that target then addresses the copy instead of the issue the
    // operator is reading.
    const { h, reconciler } = await rig();
    const ticket = await startedTicket(h);

    const result = await reconciler.tick();

    expect(result.sub_issues).toBe(0);
    expect(h.tracker.subIssues).toEqual([]);
    expect((await h.store.listTargets(ticket.id))[0]!.external_target_id).toBeNull();
  });

  test('a fan-out gets one sub-issue per target, once, however many ticks run', async () => {
    const { h, reconciler } = await rig();
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'a' }),
      targetSpec({ repo_alias: 'b' }),
    ]);

    expect((await reconciler.tick()).sub_issues).toBe(2);
    expect((await reconciler.tick()).sub_issues).toBe(0);
    expect((await reconciler.tick()).sub_issues).toBe(0);

    expect(h.tracker.subIssues.map((s) => s.alias).sort()).toEqual(['a', 'b']);
    const ids = (await h.store.listTargets(ticket.id)).map((t) => t.external_target_id);
    expect(ids.sort()).toEqual(['sub-a', 'sub-b']);
  });

  test('an excluded target is not counted toward the fan-out and gets no sub-issue', async () => {
    const { h, reconciler } = await rig();
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'a' }),
      targetSpec({ repo_alias: 'b' }),
    ]);
    const targets = await h.store.listTargets(ticket.id);
    await h.service.excludeTarget(targets.find((t) => t.repo_alias === 'b')!.id);

    expect((await reconciler.tick()).sub_issues).toBe(0);
    expect(h.tracker.subIssues).toEqual([]);
  });
});

describe('Reconciler — cancellation', () => {
  test('a requested cancellation is carried out on the next tick', async () => {
    const { h, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.cancelTarget(target.id);

    const result = await reconciler.tick();

    expect(result.cancelled).toBe(1);
    expect((await h.store.getTarget(target.id))!.status).toBe('cancelled');
    expect(h.executor.killed).toHaveLength(1);
  });

  test('a cancelled target is not re-cancelled on later ticks', async () => {
    const { h, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.cancelTarget(target.id);
    await reconciler.tick();

    expect((await reconciler.tick()).cancelled).toBe(0);
    expect(h.executor.killed).toHaveLength(1);
  });
});

describe('Reconciler — gate timeouts', () => {
  test('with no timeout configured, a gate waits indefinitely', async () => {
    const { h, reconciler } = await rig({ gate_timeout_ms: 0 });
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'a', 'ok?');

    const result = await reconciler.tick();

    expect(result.gates_timed_out).toBe(0);
    expect((await h.store.getTarget(target.id))!.status).toBe('gate_waiting');
  });

  test('an overdue gate fails its target when a timeout is configured', async () => {
    const { h, reconciler } = await rig({ gate_timeout_ms: 1 });
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'a', 'ok?');
    await Bun.sleep(5);

    const result = await reconciler.tick();

    expect(result.gates_timed_out).toBe(1);
    expect((await h.store.getTarget(target.id))!.status).toBe('failed');
  });

  test('a fresh gate is not timed out', async () => {
    const { h, reconciler } = await rig({ gate_timeout_ms: 60_000 });
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'a', 'ok?');

    expect((await reconciler.tick()).gates_timed_out).toBe(0);
  });
});

describe('Reconciler — outbox', () => {
  test('a tick drains queued tracker writes', async () => {
    const { h, runs, writes, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    runs.observations.set(target.run_id!, { status: 'completed' });

    const result = await reconciler.tick();

    expect(result.outbox_sent).toBeGreaterThan(0);
    expect(writes.states).toEqual([{ id: 'lin-1', state: 'Done' }]);
  });

  test('a tracker outage does not stop the rest of the tick', async () => {
    const { h, writes, reconciler } = await rig();
    await startedTicket(h);
    writes.failNext = 99;

    const result = await reconciler.tick();

    expect(result.dispatched).toBe(1);
    expect(h.executor.spawned).toHaveLength(1);
  });
});

describe('Reconciler — startup recovery', () => {
  test('a target stranded in dispatching is requeued with a bumped attempt', async () => {
    const { h, reconciler } = await rig();
    const ticket = await startedTicket(h);
    // Simulate a crash between the claim commit and the spawn.
    const claimed = await h.store.claimReadyTargets(WS, 10);
    expect(claimed[0]!.status).toBe('dispatching');
    await Bun.sleep(5); // let the claim age past the zero grace window

    const recovery = await reconciler.recoverOnStartup();

    expect(recovery.requeued).toBe(1);
    const after = (await h.store.listTargets(ticket.id))[0]!;
    expect(after.status).toBe('ready');
    expect(after.attempt).toBe(1);
    const kinds = (await h.store.listEvents(ticket.id)).map((e) => e.event_kind);
    expect(kinds).toContain('requeued_after_restart');
  });

  test('a claim made moments ago is left alone — it may belong to a live peer', async () => {
    // `dispatching` cannot distinguish "our crash" from "a peer mid-spawn right
    // now". Requeueing the latter spawns a second run on the same worktree, and
    // the peer's run id is never recorded so it can never be cancelled.
    const { h, reconciler } = await rig({ stranded_claim_grace_ms: 120_000 });
    const ticket = await startedTicket(h);
    await h.store.claimReadyTargets(WS, 10);

    const recovery = await reconciler.recoverOnStartup();

    expect(recovery.requeued).toBe(0);
    expect((await h.store.listTargets(ticket.id))[0]!.status).toBe('dispatching');
  });

  test('a requeued target is dispatched on the next tick', async () => {
    const { h, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await h.store.claimReadyTargets(WS, 10);
    await Bun.sleep(5);
    await reconciler.recoverOnStartup();

    await reconciler.tick();

    expect(h.executor.spawned).toHaveLength(1);
    expect((await h.store.listTargets(ticket.id))[0]!.status).toBe('running');
  });

  test('a ticket left mid-analysis by a crash is returned to the queue', async () => {
    // Only `analysis_requested` is claimable and the dashboard offers no action
    // from `analyzing`, so without this the ticket needs manual SQL to recover.
    const { h, reconciler } = await rig();
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.requestAnalysis(ticket.id);
    await h.service.claimAnalysisWork(10);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('analyzing');
    await Bun.sleep(5);

    const recovery = await reconciler.recoverOnStartup();

    expect(recovery.reopened).toBe(1);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('analysis_requested');
    // And the next tick actually analyses it.
    await reconciler.tick();
    expect((await h.store.getTicket(ticket.id))!.status).toBe('analyzed');
  });

  test('a ticket only just claimed for analysis is left alone', async () => {
    const { h, reconciler } = await rig({ stranded_claim_grace_ms: 120_000 });
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.requestAnalysis(ticket.id);
    await h.service.claimAnalysisWork(10);

    expect((await reconciler.recoverOnStartup()).reopened).toBe(0);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('analyzing');
  });

  test('running targets are adopted rather than requeued', async () => {
    const { h, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();

    const recovery = await reconciler.recoverOnStartup();

    expect(recovery.requeued).toBe(0);
    expect(recovery.adopted).toBe(1);
    expect((await h.store.listTargets(ticket.id))[0]!.status).toBe('running');
  });

  test('an adopted run is then reconciled from the executor', async () => {
    const { h, runs, reconciler } = await rig();
    const ticket = await startedTicket(h);
    await reconciler.tick();
    const target = (await h.store.listTargets(ticket.id))[0]!;

    await reconciler.recoverOnStartup();
    runs.observations.set(target.run_id!, { status: 'completed' });
    await reconciler.tick();

    expect((await h.store.getTicket(ticket.id))!.status).toBe('done');
  });

  test('recovery on an empty database is a no-op', async () => {
    const { reconciler } = await rig();
    expect(await reconciler.recoverOnStartup()).toEqual({ requeued: 0, adopted: 0, reopened: 0 });
  });
});

describe('Reconciler — resilience', () => {
  test('a step that genuinely throws does not stop the others', async () => {
    // An earlier version of this set `runs.error`, which is caught by the
    // per-target try *inside* reconcileRuns — so no step actually threw and the
    // isolation in `step()` was never exercised. Break a step outright instead.
    const { h, reconciler } = await rig();
    await startedTicket(h);
    (reconciler as unknown as { promoteBlockedTargets: () => Promise<number> }).promoteBlockedTargets =
      async () => {
        throw new Error('step exploded');
      };

    const result = await reconciler.tick();

    expect(result.promoted).toBe(0);
    // Everything after the broken step still ran.
    expect(result.dispatched).toBe(1);
    expect(h.executor.spawned).toHaveLength(1);
  });

  test('an executor that cannot be reached does not stop the tick either', async () => {
    const { h, reconciler, runs } = await rig();
    await startedTicket(h);
    runs.error = 'executor down';

    const result = await reconciler.tick();

    expect(result.reconciled).toBe(0);
    expect(result.dispatched).toBe(1);
  });

  test('an analyzer that throws leaves the ticket parked, and the tick continues', async () => {
    const { h, reconciler } = await rig();
    const a = await h.store.upsertTicket(ticketInput({ external_id: 'l1', identifier: 'GAG-1' }));
    await h.service.requestAnalysis(a.id);
    h.analyzer.error = 'boom';

    const result = await reconciler.tick();

    expect(result.analyzed).toBe(1);
    expect((await h.store.getTicket(a.id))!.status).toBe('analysis_failed');
  });

  test('the reconciler ignores other workspaces entirely', async () => {
    const { h, reconciler } = await rig();
    const foreign = await h.store.upsertTicket({
      workspace: 'other',
      external_id: 'lin-9',
      identifier: 'OTH-9',
      title: 'Not ours',
      external_state: 'Todo',
    });
    await h.store.updateTicket(foreign.id, { status: 'analysis_requested' });

    const result = await reconciler.tick();

    expect(result.analyzed).toBe(0);
    expect((await h.store.getTicket(foreign.id))!.status).toBe('analysis_requested');
  });
});
