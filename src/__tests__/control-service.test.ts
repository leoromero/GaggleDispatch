/**
 * ControlService — the transaction envelope, end to end.
 *
 * These are the tests that pin the behaviour the whole design rests on: an
 * operator click is the only thing that dispatches, a double click dispatches
 * once, tracker writes survive a tracker outage, and a target reaching a terminal
 * status settles its ticket in the same breath.
 */

import { describe, expect, test } from 'bun:test';
import {
  ControlConflictError,
  InvalidControlTransitionError,
} from '../control/transitions.ts';
import { ControlNotFoundError } from '../control/service.ts';
import { OutboxDrainer } from '../control/outbox.ts';
import {
  FakeTrackerWrites,
  harness,
  startedTicket,
  targetSpec,
  ticketInput,
  WS,
} from './helpers/control-fixtures.ts';

describe('ControlService — analysis', () => {
  test('Analyze moves a ticket to analysis_requested without touching the analyzer', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.requestAnalysis(ticket.id);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('analysis_requested');
    expect(h.analyzer.calls).toEqual([]);
  });

  test('importing a ticket dispatches nothing — the core invariant', async () => {
    const h = await harness();
    await h.store.upsertTicket(ticketInput());
    expect(await h.service.claimAnalysisWork(10)).toHaveLength(0);
    expect(await h.service.claimAndDispatch(10)).toHaveLength(0);
    expect(h.executor.spawned).toEqual([]);
  });

  test('claim then runAnalysis produces the fan-out and lands on analyzed', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.requestAnalysis(ticket.id);
    const [claimed] = await h.service.claimAnalysisWork(10);
    expect(claimed!.status).toBe('analyzing');

    h.analyzer.result = {
      summary: 'two repos',
      complexity: 'complex',
      targets: [
        { repo_alias: 'api', repo_url: 'u1', local_path: 'p1', workflow: 'w' },
        { repo_alias: 'web', repo_url: 'u2', local_path: 'p2', workflow: 'w', depends_on: ['api'] },
      ],
    };
    await h.service.runAnalysis(claimed!);

    const after = await h.store.getTicket(ticket.id);
    expect(after!.status).toBe('analyzed');
    expect(after!.analysis_summary).toBe('two repos');
    expect(after!.complexity).toBe('complex');
    expect(after!.analyzed_at).toBeTruthy();

    const targets = await h.store.listTargets(ticket.id);
    expect(targets.map((t) => t.repo_alias)).toEqual(['api', 'web']);
    expect(targets.every((t) => t.status === 'blocked')).toBe(true);
    // Analysis alone must not start anything.
    expect(h.executor.spawned).toEqual([]);
  });

  test('an analyzer that throws parks the ticket in analysis_failed with the reason', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.requestAnalysis(ticket.id);
    const [claimed] = await h.service.claimAnalysisWork(10);
    h.analyzer.error = 'claude timed out';
    await h.service.runAnalysis(claimed!);

    const after = await h.store.getTicket(ticket.id);
    expect(after!.status).toBe('analysis_failed');
    expect(after!.analysis_error).toBe('claude timed out');
  });

  test('a failed analysis can be retried, which clears the old error', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.requestAnalysis(ticket.id);
    const [claimed] = await h.service.claimAnalysisWork(10);
    h.analyzer.error = 'boom';
    await h.service.runAnalysis(claimed!);

    await h.service.requestAnalysis(ticket.id);
    const after = await h.store.getTicket(ticket.id);
    expect(after!.status).toBe('analysis_requested');
    expect(after!.analysis_error).toBeNull();
  });

  test('an analysis matching no repos is a failure, not an empty success', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.requestAnalysis(ticket.id);
    const [claimed] = await h.service.claimAnalysisWork(10);
    h.analyzer.result = { summary: 'nothing matched', complexity: null, targets: [] };
    await h.service.runAnalysis(claimed!);

    const after = await h.store.getTicket(ticket.id);
    expect(after!.status).toBe('analysis_failed');
    expect(after!.analysis_error).toMatch(/no repositories/i);
    expect(await h.store.listTargets(ticket.id)).toHaveLength(0);
  });

  test('re-analysis replaces the previous fan-out', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.requestAnalysis(ticket.id);
    let [claimed] = await h.service.claimAnalysisWork(10);
    await h.service.runAnalysis(claimed!);
    expect((await h.store.listTargets(ticket.id)).map((t) => t.repo_alias)).toEqual(['api']);

    await h.service.requestAnalysis(ticket.id);
    [claimed] = await h.service.claimAnalysisWork(10);
    h.analyzer.result = {
      summary: 'different',
      complexity: 'simple',
      targets: [{ repo_alias: 'worker', repo_url: 'u', local_path: 'p', workflow: 'w' }],
    };
    await h.service.runAnalysis(claimed!);
    expect((await h.store.listTargets(ticket.id)).map((t) => t.repo_alias)).toEqual(['worker']);
  });

  test('re-analysis is refused once the ticket is running, so a live run cannot be orphaned', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);

    await expect(h.service.requestAnalysis(ticket.id)).rejects.toThrow(
      InvalidControlTransitionError,
    );
    // The fan-out is untouched.
    expect((await h.store.listTargets(ticket.id))[0]!.status).toBe('running');
  });
});

describe('ControlService — Start and dispatch', () => {
  test('Start readies unblocked targets but does not spawn on its own', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    expect(ticket.status).toBe('running');
    expect(ticket.started_at).toBeTruthy();

    const targets = await h.store.listTargets(ticket.id);
    expect(targets[0]!.status).toBe('ready');
    // Readying is a status write. Spawning happens when the daemon drains.
    expect(h.executor.spawned).toEqual([]);
  });

  test('Start leaves a dependent target blocked until its upstream succeeds', async () => {
    const h = await harness();
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'api' }),
      targetSpec({ repo_alias: 'web', depends_on: ['api'] }),
    ]);
    const byAlias = indexByAlias(await h.store.listTargets(ticket.id));
    expect(byAlias.api!.status).toBe('ready');
    expect(byAlias.web!.status).toBe('blocked');
  });

  test('Start is refused before Analyze', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    await expect(h.service.start(ticket.id)).rejects.toThrow(InvalidControlTransitionError);
  });

  test('pressing Start twice dispatches once', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await expect(h.service.start(ticket.id)).rejects.toThrow(InvalidControlTransitionError);
    await h.service.claimAndDispatch(10);
    expect(h.executor.spawned).toHaveLength(1);
  });

  test('draining twice dispatches once — the claim is exclusive', async () => {
    const h = await harness();
    await startedTicket(h);
    expect(await h.service.claimAndDispatch(10)).toHaveLength(1);
    expect(await h.service.claimAndDispatch(10)).toHaveLength(0);
    expect(h.executor.spawned).toHaveLength(1);
  });

  test('the drain honours the slot limit and resumes next pass', async () => {
    const h = await harness();
    await startedTicket(h, [
      targetSpec({ repo_alias: 'a' }),
      targetSpec({ repo_alias: 'b' }),
      targetSpec({ repo_alias: 'c' }),
    ]);
    expect(await h.service.claimAndDispatch(2)).toHaveLength(2);
    expect(await h.service.claimAndDispatch(2)).toHaveLength(1);
    expect(h.executor.spawned).toHaveLength(3);
  });

  test('dispatch reaches running and records the run id', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    expect(target.status).toBe('running');
    expect(target.run_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(target.dispatched_at).toBeTruthy();
  });

  test('an executor that reports its run id late still reaches running', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    h.executor.nextRunId = null;
    await h.service.claimAndDispatch(10);
    let target = (await h.store.listTargets(ticket.id))[0]!;
    expect(target.status).toBe('running');
    expect(target.run_id).toBeNull();

    await h.service.recordRunId(target.id, '22222222-2222-4222-8222-222222222222');
    target = (await h.store.listTargets(ticket.id))[0]!;
    expect(target.run_id).toBe('22222222-2222-4222-8222-222222222222');
    expect(target.status).toBe('running');
  });

  test('a spawn failure fails the target and comments the reason', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    h.executor.spawnError = 'no worktree available';
    await h.service.claimAndDispatch(10);

    const target = (await h.store.listTargets(ticket.id))[0]!;
    expect(target.status).toBe('failed');
    expect(target.failure_reason).toBe('no worktree available');
    const outbox = await h.store.claimOutbox(20);
    expect(outbox.some((o) => o.op === 'post_comment' && String(o.payload.body).includes('no worktree available'))).toBe(true);
  });

  test('every dispatch is recorded in the audit trail', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const kinds = (await h.store.listEvents(ticket.id)).map((e) => e.event_kind);
    expect(kinds).toContain('analyze_requested');
    expect(kinds).toContain('analysis_claimed');
    expect(kinds).toContain('analysis_succeeded');
    expect(kinds).toContain('start_requested');
    expect(kinds).toContain('blockers_satisfied');
    expect(kinds).toContain('dispatch_claimed');
    expect(kinds).toContain('run_started');
  });
});

describe('ControlService — completion', () => {
  test('the last target succeeding settles the ticket to done in the same operation', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;

    await h.service.runSucceeded(target.id);

    const after = await h.store.getTicket(ticket.id);
    expect(after!.status).toBe('done');
    expect(after!.completed_at).toBeTruthy();
    const outbox = await h.store.claimOutbox(20);
    expect(outbox.some((o) => o.op === 'set_state' && o.payload.state === 'Done')).toBe(true);
  });

  test('one of two succeeding leaves the ticket running', async () => {
    const h = await harness();
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'a' }),
      targetSpec({ repo_alias: 'b' }),
    ]);
    await h.service.claimAndDispatch(10);
    const targets = await h.store.listTargets(ticket.id);
    await h.service.runSucceeded(targets[0]!.id);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('running');
  });

  test('a failed target keeps the ticket running — sticky for the operator', async () => {
    const h = await harness();
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'a' }),
      targetSpec({ repo_alias: 'b' }),
    ]);
    await h.service.claimAndDispatch(10);
    const targets = await h.store.listTargets(ticket.id);
    await h.service.runSucceeded(targets[0]!.id);
    await h.service.runFailed(targets[1]!.id, 'tests failed');

    const after = await h.store.getTicket(ticket.id);
    expect(after!.status).toBe('running');
    expect(after!.completed_at).toBeNull();
  });

  test('re-dispatching the failed target and succeeding completes the ticket', async () => {
    const h = await harness();
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'a' }),
      targetSpec({ repo_alias: 'b' }),
    ]);
    await h.service.claimAndDispatch(10);
    const targets = await h.store.listTargets(ticket.id);
    await h.service.runSucceeded(targets[0]!.id);
    await h.service.runFailed(targets[1]!.id, 'flaky');

    await h.service.redispatchTarget(targets[1]!.id);
    const readied = await h.store.getTarget(targets[1]!.id);
    expect(readied!.status).toBe('ready');
    expect(readied!.attempt).toBe(1);

    await h.service.claimAndDispatch(10);
    await h.service.runSucceeded(targets[1]!.id);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('done');
  });

  test('an upstream succeeding unblocks its dependent on the next evaluation', async () => {
    const h = await harness();
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'api' }),
      targetSpec({ repo_alias: 'web', depends_on: ['api'] }),
    ]);
    await h.service.claimAndDispatch(10);
    const api = indexByAlias(await h.store.listTargets(ticket.id)).api!;
    await h.service.runSucceeded(api.id);

    await h.service.evaluateReadiness(ticket.id);
    expect(indexByAlias(await h.store.listTargets(ticket.id)).web!.status).toBe('ready');
  });

  test('excluded targets do not hold a ticket open', async () => {
    const h = await harness();
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'a' }),
      targetSpec({ repo_alias: 'b' }),
    ]);
    const targets = indexByAlias(await h.store.listTargets(ticket.id));
    await h.service.excludeTarget(targets.b!.id);
    await h.service.claimAndDispatch(10);
    await h.service.runSucceeded(targets.a!.id);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('done');
  });
});

describe('ControlService — gates', () => {
  test('a gate stores the message for the dashboard and comments on the tracker', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;

    await h.service.gateOpened(target.id, 'appr-1', 'Approve the plan?');

    const gates = await h.store.listPendingGates(WS);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.gate_message).toBe('Approve the plan?');
    expect(gates[0]!.approval_id).toBe('appr-1');
    expect(gates[0]!.identifier).toBe('GAG-1');

    const outbox = await h.store.claimOutbox(20);
    const comment = outbox.find((o) => o.op === 'post_comment');
    expect(String(comment!.payload.body)).toContain('Approve the plan?');
    expect(String(comment!.payload.body)).toMatch(/no effect/i);
  });

  test('approving resumes the run and clears the gate', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'appr-1', 'ok?');

    await h.service.approveGate(target.id, 'ship it');

    const after = await h.store.getTarget(target.id);
    expect(after!.status).toBe('running');
    expect(after!.gate_message).toBeNull();
    expect(h.executor.approved).toEqual([{ approval_id: 'appr-1', comment: 'ship it', alias: 'api' }]);
    expect(await h.store.listPendingGates(WS)).toHaveLength(0);
  });

  test('rejecting sends the reason back into the workflow rework loop', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'appr-1', 'ok?');

    await h.service.rejectGate(target.id, 'wrong approach');

    const after = await h.store.getTarget(target.id);
    expect(after!.status).toBe('running');
    expect(after!.gate_rework_attempts).toBe(1);
    expect(h.executor.rejected).toEqual([
      { approval_id: 'appr-1', reason: 'wrong approach', alias: 'api' },
    ]);
  });

  test('rejecting past the rework budget fails the target', async () => {
    const h = await harness({ max_gate_rework_attempts: 1 });
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;

    await h.service.gateOpened(target.id, 'a1', 'ok?');
    await h.service.rejectGate(target.id, 'no');
    await h.service.gateOpened(target.id, 'a2', 'ok now?');
    await h.service.rejectGate(target.id, 'still no');

    const after = await h.store.getTarget(target.id);
    expect(after!.status).toBe('failed');
    expect(after!.failure_reason).toMatch(/rework/i);
    expect(after!.gate_message).toBeNull();
  });

  test('a gate timeout fails the target and rejects the run', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'appr-1', 'ok?');

    await h.service.gateTimedOut(target.id);

    expect((await h.store.getTarget(target.id))!.status).toBe('failed');
    expect(h.executor.rejected[0]!.reason).toMatch(/timeout/i);
  });

  test('creating a blocker from a gate parks the target and files the issue', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.gateOpened(target.id, 'appr-1', 'ok?');

    await h.service.createGateBlocker(target.id, { title: 'Need a field', description: 'why' });

    expect((await h.store.getTarget(target.id))!.status).toBe('blocked');
    expect(h.tracker.blockers).toHaveLength(1);
    expect(h.tracker.blockers[0]!.spec.title).toBe('Need a field');
  });

  test('the gate state round-trip only happens when states are configured', async () => {
    const h = await harness({ gate_waiting_state: 'Blocked', gate_resume_state: 'In Progress' });
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;

    await h.service.gateOpened(target.id, 'a', 'ok?');
    await h.service.approveGate(target.id, null);

    const states = (await h.store.claimOutbox(50))
      .filter((o) => o.op === 'set_state')
      .map((o) => o.payload.state);
    expect(states).toEqual(['Blocked', 'In Progress']);
  });
});

describe('ControlService — cancellation', () => {
  test('cancelling a live target only raises the flag; the daemon confirms', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;

    await h.service.cancelTarget(target.id);
    let after = await h.store.getTarget(target.id);
    expect(after!.status).toBe('running');
    expect(after!.cancel_requested).toBe(true);
    expect(h.executor.killed).toEqual([]);
    expect(await h.store.listCancelRequested(WS)).toHaveLength(1);

    await h.service.confirmCancel(target.id);
    after = await h.store.getTarget(target.id);
    expect(after!.status).toBe('cancelled');
    expect(after!.cancel_requested).toBe(false);
    expect(h.executor.killed).toHaveLength(1);
  });

  test('cancelling a ready target is immediate — there is no process to kill', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    const target = (await h.store.listTargets(ticket.id))[0]!;

    await h.service.cancelTarget(target.id);
    expect((await h.store.getTarget(target.id))!.status).toBe('cancelled');
    expect(h.executor.killed).toEqual([]);
    // A cancelled target must not then be dispatched.
    expect(await h.service.claimAndDispatch(10)).toHaveLength(0);
  });

  test('cancelling the ticket cascades to every non-terminal target', async () => {
    const h = await harness();
    const ticket = await startedTicket(h, [
      targetSpec({ repo_alias: 'a' }),
      targetSpec({ repo_alias: 'b' }),
      targetSpec({ repo_alias: 'c' }),
    ]);
    await h.service.claimAndDispatch(1);
    const targets = indexByAlias(await h.store.listTargets(ticket.id));
    await h.service.runSucceeded(targets.a!.id);

    await h.service.cancelTicket(ticket.id);

    expect((await h.store.getTicket(ticket.id))!.status).toBe('cancelled');
    const after = indexByAlias(await h.store.listTargets(ticket.id));
    expect(after.a!.status).toBe('succeeded');
    expect(after.b!.status).toBe('cancelled');
    expect(after.c!.status).toBe('cancelled');
  });

  test('a cancelled target can be re-dispatched', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.cancelTarget(target.id);
    await h.service.redispatchTarget(target.id);
    expect((await h.store.getTarget(target.id))!.status).toBe('ready');
  });
});

describe('ControlService — archive, restore, external terminal', () => {
  test('archiving hides a ticket and restoring brings it back to imported', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.archive(ticket.id);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('archived');
    await h.service.restore(ticket.id);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('imported');
  });

  test('a running ticket cannot be archived', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await expect(h.service.archive(ticket.id)).rejects.toThrow(InvalidControlTransitionError);
  });

  test('going terminal in the tracker archives a pre-run ticket', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    await h.service.externalTerminal(ticket.id);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('archived');
  });

  test('going terminal in the tracker never kills a running ticket', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);

    await h.service.externalTerminal(ticket.id);

    const after = await h.store.getTicket(ticket.id);
    expect(after!.status).toBe('running');
    expect(after!.external_terminal_at).toBeTruthy();
    const target = (await h.store.listTargets(ticket.id))[0]!;
    expect(target.status).toBe('running');
    expect(h.executor.killed).toEqual([]);
  });
});

describe('ControlService — workflow override and errors', () => {
  test('the workflow can be corrected before dispatch', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    const updated = await h.service.setTargetWorkflow(target.id, 'gaggle/gaggle-supervised');
    expect(updated.workflow).toBe('gaggle/gaggle-supervised');
    const kinds = (await h.store.listEvents(ticket.id)).map((e) => e.event_kind);
    expect(kinds).toContain('workflow_changed');
  });

  test('the workflow cannot be changed under a live run', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await expect(h.service.setTargetWorkflow(target.id, 'other')).rejects.toThrow(ControlConflictError);
  });

  test('an unknown id is a not-found, not a crash', async () => {
    const h = await harness();
    const missing = '00000000-0000-4000-8000-000000000000';
    await expect(h.service.start(missing)).rejects.toThrow(ControlNotFoundError);
    await expect(h.service.approveGate(missing, null)).rejects.toThrow(ControlNotFoundError);
  });

  test('a rejected transition writes nothing at all', async () => {
    const h = await harness();
    const ticket = await h.store.upsertTicket(ticketInput());
    const before = await h.store.getTicket(ticket.id);
    await expect(h.service.start(ticket.id)).rejects.toThrow(InvalidControlTransitionError);
    const after = await h.store.getTicket(ticket.id);
    expect(after).toEqual(before);
    expect(await h.store.listEvents(ticket.id)).toHaveLength(0);
    expect(await h.store.claimOutbox(10)).toHaveLength(0);
  });
});

describe('ControlService — label mirroring', () => {
  test('mirroring off means no label writes reach the outbox', async () => {
    const h = await harness({ mirror_labels: false });
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const ops = (await h.store.claimOutbox(50)).map((o) => o.op);
    expect(ops).not.toContain('apply_label');
    expect(ops).not.toContain('remove_label');
  });

  test('mirroring on writes labels one-way, and nothing reads them back', async () => {
    const h = await harness({ mirror_labels: true });
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const outbox = await h.store.claimOutbox(50);
    const applied = outbox.filter((o) => o.op === 'apply_label').map((o) => o.payload.label);
    expect(applied).toContain('gaggle:analyzing');
    expect(applied).toContain('gaggle:claimed');
  });
});

describe('OutboxDrainer', () => {
  test('drains queued writes to the tracker', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.service.runSucceeded(target.id);

    const writes = new FakeTrackerWrites();
    const drainer = new OutboxDrainer(h.store, writes, { batch_size: 50, max_attempts: 5 });
    const result = await drainer.drain();

    expect(result.sent).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
    expect(writes.states).toEqual([{ id: 'lin-1', state: 'Done' }]);
    expect(await h.store.claimOutbox(50)).toHaveLength(0);
  });

  test('a tracker outage delays a write instead of losing it', async () => {
    const h = await harness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    await h.service.runSucceeded((await h.store.listTargets(ticket.id))[0]!.id);

    const writes = new FakeTrackerWrites();
    const drainer = new OutboxDrainer(h.store, writes, { batch_size: 50, max_attempts: 5 });

    writes.failNext = 1;
    const first = await drainer.drain();
    expect(first.failed).toBe(1);
    expect(writes.states).toEqual([]);

    const second = await drainer.drain();
    expect(second.sent).toBe(1);
    expect(writes.states).toEqual([{ id: 'lin-1', state: 'Done' }]);
  });

  test('a write that keeps failing is discarded rather than retried forever', async () => {
    const h = await harness();
    await h.store.enqueueOutbox({ workspace: WS, external_id: 'lin-1', op: 'set_state', payload: { state: 'Done' } });

    const writes = new FakeTrackerWrites();
    const drainer = new OutboxDrainer(h.store, writes, { batch_size: 50, max_attempts: 2 });

    writes.failNext = 10;
    await drainer.drain();
    await drainer.drain();
    const third = await drainer.drain();

    expect(third.discarded).toBe(1);
    expect(await h.store.claimOutbox(50)).toHaveLength(0);
  });

  test('a malformed payload does not wedge the queue', async () => {
    const h = await harness();
    await h.store.enqueueOutbox({ workspace: WS, external_id: 'lin-1', op: 'set_state', payload: {} });
    await h.store.enqueueOutbox({ workspace: WS, external_id: 'lin-2', op: 'post_comment', payload: { body: 'fine' } });

    const writes = new FakeTrackerWrites();
    const drainer = new OutboxDrainer(h.store, writes, { batch_size: 50, max_attempts: 5 });
    const result = await drainer.drain();

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(writes.comments).toEqual([{ id: 'lin-2', body: 'fine' }]);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function indexByAlias<T extends { repo_alias: string }>(rows: T[]): Record<string, T | undefined> {
  const out: Record<string, T | undefined> = {};
  for (const r of rows) out[r.repo_alias] = r;
  return out;
}
