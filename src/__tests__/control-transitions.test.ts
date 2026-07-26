/**
 * Transition tables, exhaustively.
 *
 * These are pure functions, so every legal pair is asserted for its target
 * status and its effects, and every illegal pair is asserted to throw. The
 * matrix tests at the bottom are the ones that catch a status added to the enum
 * without a decision about what it accepts.
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MIRROR_LABELS,
  InvalidControlTransitionError,
  TARGET_EVENT_KINDS,
  TICKET_EVENT_KINDS,
  targetTransition,
  ticketTransition,
  type TargetEvent,
  type TargetTransitionContext,
  type TicketEvent,
  type TicketTransitionContext,
} from '../control/transitions.ts';
import {
  TARGET_STATUSES,
  TICKET_STATUSES,
  type TargetRow,
  type TargetStatus,
  type TicketRow,
  type TicketStatus,
} from '../control/types.ts';

// ─── fixtures ───────────────────────────────────────────────────────────────

function ticket(over: Partial<TicketRow> = {}): TicketRow {
  return {
    id: 'tk-1',
    workspace: 'acme',
    tracker_kind: 'linear',
    external_id: 'lin-1',
    identifier: 'GAG-1',
    title: 'Fix the widget',
    description: null,
    priority: 2,
    url: 'https://linear.app/gag-1',
    branch_name: null,
    parent_external_id: null,
    external_state: 'Todo',
    external_labels: [],
    blocked_by: [],
    status: 'imported',
    analysis_summary: null,
    complexity: null,
    analysis_error: null,
    external_created_at: null,
    external_updated_at: null,
    first_imported_at: '2026-07-01T00:00:00.000Z',
    last_synced_at: '2026-07-01T00:00:00.000Z',
    last_seen_at: '2026-07-01T00:00:00.000Z',
    external_terminal_at: null,
    status_changed_at: '2026-07-01T00:00:00.000Z',
    analyzed_at: null,
    started_at: null,
    completed_at: null,
    ...over,
  };
}

function target(over: Partial<TargetRow> = {}): TargetRow {
  return {
    id: 'tg-1',
    ticket_id: 'tk-1',
    repo_alias: 'api',
    repo_url: 'https://github.com/acme/api',
    local_path: '/repos/api',
    workflow: 'gaggle/gaggle-fix-issue',
    rationale: null,
    components: [],
    depends_on: [],
    ready_when: null,
    status: 'blocked',
    external_target_id: null,
    external_target_url: null,
    external_target_state: null,
    external_target_labels: [],
    run_id: null,
    attempt: 0,
    failure_reason: null,
    cancel_requested: false,
    gate_approval_id: null,
    gate_message: null,
    gate_opened_at: null,
    gate_rework_attempts: 0,
    gate_decision: null,
    gate_decision_comment: null,
    gate_decision_at: null,
    status_changed_at: '2026-07-01T00:00:00.000Z',
    dispatched_at: null,
    completed_at: null,
    ...over,
  };
}

function ticketCtx(over: Partial<TicketTransitionContext> = {}): TicketTransitionContext {
  return {
    ticket: ticket(),
    targets: [],
    mirror_labels: false,
    completed_state: 'Done',
    labels: DEFAULT_MIRROR_LABELS,
    ...over,
  };
}

function targetCtx(over: Partial<TargetTransitionContext> = {}): TargetTransitionContext {
  return {
    ticket: ticket({ status: 'running' }),
    target: target(),
    siblings: [],
    mirror_labels: false,
    gate_waiting_state: null,
    gate_resume_state: null,
    completed_state: 'Done',
    max_gate_rework_attempts: 3,
    labels: DEFAULT_MIRROR_LABELS,
    ...over,
  };
}

/** Effect kinds present, for terse assertions. */
const kinds = (t: { effects: readonly { kind: string }[] }): string[] => t.effects.map((e) => e.kind);

// ─── ticket transitions ─────────────────────────────────────────────────────

describe('ticketTransition', () => {
  test('imported + analyze_requested → analysis_requested', () => {
    const t = ticketTransition('imported', { kind: 'analyze_requested' }, ticketCtx());
    expect(t.to).toBe('analysis_requested');
    expect(t.actor).toBe('operator');
  });

  test('analysis_failed and analyzed both accept a re-analyze', () => {
    for (const from of ['analysis_failed', 'analyzed'] as TicketStatus[]) {
      const t = ticketTransition(from, { kind: 'analyze_requested' }, ticketCtx());
      expect(t.to).toBe('analysis_requested');
    }
  });

  test('analysis_requested + analysis_claimed → analyzing, by the daemon', () => {
    const t = ticketTransition('analysis_requested', { kind: 'analysis_claimed' }, ticketCtx());
    expect(t.to).toBe('analyzing');
    expect(t.actor).toBe('daemon');
  });

  test('analyzing + analysis_succeeded → analyzed and stores the fan-out', () => {
    const t = ticketTransition(
      'analyzing',
      {
        kind: 'analysis_succeeded',
        summary: 'two repos',
        complexity: 'complex',
        targets: [
          {
            repo_alias: 'api',
            repo_url: 'u',
            local_path: 'p',
            workflow: 'gaggle/gaggle-fix-issue',
          },
        ],
      },
      ticketCtx(),
    );
    expect(t.to).toBe('analyzed');
    expect(t.patch.analysis_summary).toBe('two repos');
    expect(t.patch.complexity).toBe('complex');
    expect(t.patch.analysis_error).toBeNull();
    expect(t.patch.analyzed_at).toBeTruthy();
    expect(kinds(t)).toContain('replace_targets');
  });

  test('analysis_succeeded with zero targets is a failure, not a success', () => {
    const t = ticketTransition(
      'analyzing',
      { kind: 'analysis_succeeded', summary: 's', complexity: null, targets: [] },
      ticketCtx(),
    );
    expect(t.to).toBe('analysis_failed');
    expect(t.patch.analysis_error).toMatch(/no repo/i);
    expect(kinds(t)).not.toContain('replace_targets');
  });

  test('analyzing + analysis_failed records the error', () => {
    const t = ticketTransition(
      'analyzing',
      { kind: 'analysis_failed', error: 'claude timed out' },
      ticketCtx(),
    );
    expect(t.to).toBe('analysis_failed');
    expect(t.patch.analysis_error).toBe('claude timed out');
  });

  test('analyzed + start_requested → running, stamps started_at, readies the targets', () => {
    const t = ticketTransition('analyzed', { kind: 'start_requested' }, ticketCtx());
    expect(t.to).toBe('running');
    expect(t.patch.started_at).toBeTruthy();
    expect(kinds(t)).toContain('evaluate_target_readiness');
  });

  test('start_requested is rejected from imported — Analyze comes first', () => {
    expect(() => ticketTransition('imported', { kind: 'start_requested' }, ticketCtx())).toThrow(
      InvalidControlTransitionError,
    );
  });

  test('running + targets_settled stays running until every target settles', () => {
    const t = ticketTransition('running', { kind: 'targets_settled' }, ticketCtx({
      targets: [target({ status: 'succeeded' }), target({ id: 'tg-2', status: 'running' })],
    }));
    expect(t.to).toBe('running');
    expect(t.effects).toHaveLength(0);
  });

  test('running + targets_settled → done when all succeeded, and closes the tracker issue', () => {
    const t = ticketTransition('running', { kind: 'targets_settled' }, ticketCtx({
      targets: [target({ status: 'succeeded' }), target({ id: 'tg-2', status: 'succeeded' })],
    }));
    expect(t.to).toBe('done');
    expect(t.patch.completed_at).toBeTruthy();
    const setState = t.effects.find((e) => e.kind === 'tracker_set_state');
    expect(setState).toMatchObject({ kind: 'tracker_set_state', state: 'Done' });
  });

  test('running stays running when every target settled but one failed — sticky for the operator', () => {
    const t = ticketTransition('running', { kind: 'targets_settled' }, ticketCtx({
      targets: [target({ status: 'succeeded' }), target({ id: 'tg-2', status: 'failed' })],
    }));
    expect(t.to).toBe('running');
    expect(kinds(t)).not.toContain('tracker_set_state');
  });

  test('excluded targets do not count toward completion', () => {
    const t = ticketTransition('running', { kind: 'targets_settled' }, ticketCtx({
      targets: [target({ status: 'succeeded' }), target({ id: 'tg-2', status: 'excluded' })],
    }));
    expect(t.to).toBe('done');
  });

  test('a ticket with only excluded targets does not complete', () => {
    const t = ticketTransition('running', { kind: 'targets_settled' }, ticketCtx({
      targets: [target({ status: 'excluded' })],
    }));
    expect(t.to).toBe('running');
  });

  test('cancel_requested cancels every live target', () => {
    const t = ticketTransition('running', { kind: 'cancel_requested' }, ticketCtx({
      targets: [target({ status: 'running' }), target({ id: 'tg-2', status: 'succeeded' })],
    }));
    expect(t.to).toBe('cancelled');
    expect(kinds(t)).toContain('cancel_targets');
  });

  test('archive is allowed from every pre-run status and refused once running', () => {
    for (const from of ['imported', 'analyzed', 'analysis_failed'] as TicketStatus[]) {
      expect(ticketTransition(from, { kind: 'archive_requested' }, ticketCtx()).to).toBe('archived');
    }
    expect(() => ticketTransition('running', { kind: 'archive_requested' }, ticketCtx())).toThrow(
      InvalidControlTransitionError,
    );
  });

  test('archived + restore_requested → imported and clears the terminal marker', () => {
    const t = ticketTransition('archived', { kind: 'restore_requested' }, ticketCtx());
    expect(t.to).toBe('imported');
    expect(t.patch.external_terminal_at).toBeNull();
  });

  test('external_terminal archives a pre-run ticket, attributed to sync', () => {
    for (const from of ['imported', 'analyzed', 'analysis_failed'] as TicketStatus[]) {
      const t = ticketTransition(from, { kind: 'external_terminal' }, ticketCtx());
      expect(t.to).toBe('archived');
      expect(t.actor).toBe('sync');
    }
  });

  test('external_terminal on a running ticket only records the marker — it must not kill work', () => {
    const t = ticketTransition('running', { kind: 'external_terminal' }, ticketCtx());
    expect(t.to).toBe('running');
    expect(t.patch.external_terminal_at).toBeTruthy();
    expect(t.effects).toHaveLength(0);
  });

  test('external_terminal is a no-op on an already-terminal ticket', () => {
    for (const from of ['done', 'cancelled', 'archived'] as TicketStatus[]) {
      const t = ticketTransition(from, { kind: 'external_terminal' }, ticketCtx());
      expect(t.to).toBe(from);
      expect(t.effects).toHaveLength(0);
    }
  });

  test('re-analysis is refused from running — the only status a live target can imply', () => {
    expect(() => ticketTransition('running', { kind: 'analyze_requested' }, ticketCtx())).toThrow(
      InvalidControlTransitionError,
    );
  });

  test('done and cancelled accept nothing', () => {
    for (const from of ['done', 'cancelled'] as TicketStatus[]) {
      for (const kind of TICKET_EVENT_KINDS) {
        if (kind === 'external_terminal') continue; // asserted as a no-op above
        expect(() =>
          ticketTransition(from, { kind } as TicketEvent, ticketCtx()),
        ).toThrow(InvalidControlTransitionError);
      }
    }
  });

  test('mirror_labels off emits no label effects; on emits them', () => {
    const off = ticketTransition('imported', { kind: 'analyze_requested' }, ticketCtx());
    expect(kinds(off).filter((k) => k.includes('label'))).toHaveLength(0);
    const on = ticketTransition(
      'imported',
      { kind: 'analyze_requested' },
      ticketCtx({ mirror_labels: true }),
    );
    expect(kinds(on)).toContain('tracker_apply_label');
  });
});

// ─── target transitions ─────────────────────────────────────────────────────

describe('targetTransition', () => {
  test('blocked + blockers_satisfied → ready', () => {
    expect(targetTransition('blocked', { kind: 'blockers_satisfied' }, targetCtx()).to).toBe('ready');
  });

  test('ready + blockers_unsatisfied → blocked', () => {
    expect(targetTransition('ready', { kind: 'blockers_unsatisfied' }, targetCtx()).to).toBe('blocked');
  });

  test('ready + dispatch_claimed → dispatching', () => {
    const t = targetTransition('ready', { kind: 'dispatch_claimed' }, targetCtx());
    expect(t.to).toBe('dispatching');
    expect(t.actor).toBe('daemon');
    expect(kinds(t)).toContain('spawn_run');
  });

  test('dispatching + run_started → running and records the run id', () => {
    const t = targetTransition('dispatching', { kind: 'run_started', run_id: 'run-1' }, targetCtx());
    expect(t.to).toBe('running');
    expect(t.patch.run_id).toBe('run-1');
  });

  test('dispatching + run_failed → failed', () => {
    const t = targetTransition(
      'dispatching',
      { kind: 'run_failed', reason: 'spawn refused' },
      targetCtx(),
    );
    expect(t.to).toBe('failed');
    expect(t.patch.failure_reason).toBe('spawn refused');
  });

  test('running + run_succeeded → succeeded and stamps completion', () => {
    const t = targetTransition('running', { kind: 'run_succeeded' }, targetCtx());
    expect(t.to).toBe('succeeded');
    expect(t.patch.completed_at).toBeTruthy();
    expect(t.patch.failure_reason).toBeNull();
  });

  test('running + run_failed → failed and comments on the tracker issue', () => {
    const t = targetTransition('running', { kind: 'run_failed', reason: 'exit 1' }, targetCtx());
    expect(t.to).toBe('failed');
    const comment = t.effects.find((e) => e.kind === 'tracker_post_comment');
    expect(comment).toBeTruthy();
    expect((comment as { body: string }).body).toContain('exit 1');
  });

  test('running + gate_opened → gate_waiting, storing the gate for the dashboard', () => {
    const t = targetTransition(
      'running',
      { kind: 'gate_opened', approval_id: 'appr-1', message: 'Approve the plan?' },
      targetCtx(),
    );
    expect(t.to).toBe('gate_waiting');
    expect(t.patch.gate_approval_id).toBe('appr-1');
    expect(t.patch.gate_message).toBe('Approve the plan?');
    expect(t.patch.gate_opened_at).toBeTruthy();
  });

  test('gate_opened comments the gate and says replies there do nothing', () => {
    const t = targetTransition(
      'running',
      { kind: 'gate_opened', approval_id: 'a', message: 'Approve?' },
      targetCtx(),
    );
    const comment = t.effects.find((e) => e.kind === 'tracker_post_comment') as { body: string };
    expect(comment.body).toContain('Approve?');
    expect(comment.body).toMatch(/dashboard/i);
    expect(comment.body).toMatch(/no effect|not.*read|won't be read/i);
  });

  test('gate_opened moves the tracker state only when one is configured', () => {
    expect(
      kinds(
        targetTransition(
          'running',
          { kind: 'gate_opened', approval_id: 'a', message: 'm' },
          targetCtx(),
        ),
      ),
    ).not.toContain('tracker_set_state');
    expect(
      kinds(
        targetTransition(
          'running',
          { kind: 'gate_opened', approval_id: 'a', message: 'm' },
          targetCtx({ gate_waiting_state: 'Blocked' }),
        ),
      ),
    ).toContain('tracker_set_state');
  });

  test('gate_approved → running, clears the gate, and forwards the comment', () => {
    const t = targetTransition(
      'gate_waiting',
      { kind: 'gate_approved', comment: 'looks good' },
      targetCtx({ target: target({ status: 'gate_waiting', gate_approval_id: 'appr-1' }) }),
    );
    expect(t.to).toBe('running');
    expect(t.patch.gate_message).toBeNull();
    expect(t.patch.gate_opened_at).toBeNull();
    expect(t.patch.gate_approval_id).toBeNull();
    const approve = t.effects.find((e) => e.kind === 'approve_gate');
    expect(approve).toMatchObject({ kind: 'approve_gate', comment: 'looks good' });
  });

  test('gate_rejected → running for a rework attempt, and counts it', () => {
    const t = targetTransition(
      'gate_waiting',
      { kind: 'gate_rejected', reason: 'wrong approach' },
      targetCtx({ target: target({ status: 'gate_waiting', gate_rework_attempts: 0 }) }),
    );
    expect(t.to).toBe('running');
    expect(t.patch.gate_rework_attempts).toBe(1);
    const reject = t.effects.find((e) => e.kind === 'reject_gate');
    expect(reject).toMatchObject({ kind: 'reject_gate', reason: 'wrong approach' });
  });

  test('gate_rejected → failed once the rework budget is spent', () => {
    const t = targetTransition(
      'gate_waiting',
      { kind: 'gate_rejected', reason: 'still wrong' },
      targetCtx({
        target: target({ status: 'gate_waiting', gate_rework_attempts: 3 }),
        max_gate_rework_attempts: 3,
      }),
    );
    expect(t.to).toBe('failed');
    expect(t.patch.failure_reason).toMatch(/rework/i);
  });

  test('a zero rework budget sends the first rejection straight to failed', () => {
    const t = targetTransition(
      'gate_waiting',
      { kind: 'gate_rejected', reason: 'no' },
      targetCtx({
        target: target({ status: 'gate_waiting', gate_rework_attempts: 0 }),
        max_gate_rework_attempts: 0,
      }),
    );
    expect(t.to).toBe('failed');
  });

  test('gate_blocker_created parks the target in blocked and files the blocker', () => {
    const t = targetTransition(
      'gate_waiting',
      { kind: 'gate_blocker_created', blocker: { title: 'Need an API field', description: 'why' } },
      targetCtx({ target: target({ status: 'gate_waiting' }) }),
    );
    expect(t.to).toBe('blocked');
    expect(kinds(t)).toContain('create_blocker_issue');
    expect(kinds(t)).toContain('reject_gate');
  });

  test('gate_timed_out → failed', () => {
    const t = targetTransition(
      'gate_waiting',
      { kind: 'gate_timed_out' },
      targetCtx({ target: target({ status: 'gate_waiting' }) }),
    );
    expect(t.to).toBe('failed');
    expect(t.patch.failure_reason).toMatch(/timed out|timeout/i);
  });

  test('gate transitions restore the resume state when one is configured', () => {
    const t = targetTransition(
      'gate_waiting',
      { kind: 'gate_approved', comment: null },
      targetCtx({
        target: target({ status: 'gate_waiting' }),
        gate_waiting_state: 'Blocked',
        gate_resume_state: 'In Progress',
      }),
    );
    expect(t.effects.find((e) => e.kind === 'tracker_set_state')).toMatchObject({
      state: 'In Progress',
    });
  });

  test('cancel_requested on a pre-dispatch target cancels immediately', () => {
    for (const from of ['blocked', 'ready', 'excluded'] as TargetStatus[]) {
      const t = targetTransition('' + from as TargetStatus, { kind: 'cancel_requested' }, targetCtx());
      expect(t.to).toBe('cancelled');
      expect(t.patch.cancel_requested).toBe(false);
      expect(kinds(t)).not.toContain('kill_run');
    }
  });

  test('cancel_requested on a live target only raises the flag', () => {
    for (const from of ['dispatching', 'running', 'gate_waiting'] as TargetStatus[]) {
      const t = targetTransition(from, { kind: 'cancel_requested' }, targetCtx());
      expect(t.to).toBe(from);
      expect(t.patch.cancel_requested).toBe(true);
      expect(kinds(t)).not.toContain('kill_run');
    }
  });

  test('cancel_confirmed is what actually cancels a live target', () => {
    const t = targetTransition('running', { kind: 'cancel_confirmed' }, targetCtx());
    expect(t.to).toBe('cancelled');
    expect(t.patch.cancel_requested).toBe(false);
    expect(t.patch.completed_at).toBeTruthy();
    expect(kinds(t)).toContain('kill_run');
  });

  test('failed and cancelled accept a re-dispatch, which bumps the attempt', () => {
    for (const from of ['failed', 'cancelled'] as TargetStatus[]) {
      const t = targetTransition(
        from,
        { kind: 'redispatch_requested' },
        targetCtx({ target: target({ status: from, attempt: 2 }) }),
      );
      expect(t.to).toBe('ready');
      expect(t.patch.attempt).toBe(3);
      expect(t.patch.failure_reason).toBeNull();
      expect(t.patch.run_id).toBeNull();
    }
  });

  test('exclude and include round-trip a pre-dispatch target', () => {
    expect(targetTransition('blocked', { kind: 'exclude_requested' }, targetCtx()).to).toBe('excluded');
    expect(targetTransition('ready', { kind: 'exclude_requested' }, targetCtx()).to).toBe('excluded');
    expect(targetTransition('excluded', { kind: 'include_requested' }, targetCtx()).to).toBe('blocked');
  });

  test('a live target cannot be excluded — cancel it first', () => {
    for (const from of ['dispatching', 'running', 'gate_waiting'] as TargetStatus[]) {
      expect(() => targetTransition(from, { kind: 'exclude_requested' }, targetCtx())).toThrow(
        InvalidControlTransitionError,
      );
    }
  });

  test('succeeded is terminal', () => {
    for (const kind of TARGET_EVENT_KINDS) {
      expect(() => targetTransition('succeeded', { kind } as TargetEvent, targetCtx())).toThrow(
        InvalidControlTransitionError,
      );
    }
  });

  test('the error names the status and the event', () => {
    try {
      targetTransition('succeeded', { kind: 'run_started', run_id: 'r' }, targetCtx());
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidControlTransitionError);
      const e = err as InvalidControlTransitionError;
      expect(e.from).toBe('succeeded');
      expect(e.event_kind).toBe('run_started');
      expect(e.machine).toBe('target');
      expect(e.message).toContain('succeeded');
      expect(e.message).toContain('run_started');
    }
  });
});

// ─── matrices ───────────────────────────────────────────────────────────────

describe('transition matrices', () => {
  test('every ticket status × event either transitions or throws InvalidControlTransitionError', () => {
    for (const from of TICKET_STATUSES) {
      for (const kind of TICKET_EVENT_KINDS) {
        try {
          const t = ticketTransition(from, sampleTicketEvent(kind), ticketCtx());
          expect(TICKET_STATUSES).toContain(t.to);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          if (!(err instanceof InvalidControlTransitionError)) {
            // The only other permitted rejection is the live-target guard.
            expect((err as Error).message).toMatch(/live target/i);
          }
        }
      }
    }
  });

  test('every target status × event either transitions or throws InvalidControlTransitionError', () => {
    for (const from of TARGET_STATUSES) {
      for (const kind of TARGET_EVENT_KINDS) {
        try {
          const t = targetTransition(from, sampleTargetEvent(kind), targetCtx({
            target: target({ status: from }),
          }));
          expect(TARGET_STATUSES).toContain(t.to);
        } catch (err) {
          expect(err).toBeInstanceOf(InvalidControlTransitionError);
        }
      }
    }
  });

  test('a transition never reports a from-status other than the one asked for', () => {
    for (const from of TARGET_STATUSES) {
      for (const kind of TARGET_EVENT_KINDS) {
        try {
          const t = targetTransition(from, sampleTargetEvent(kind), targetCtx({
            target: target({ status: from }),
          }));
          expect(t.from).toBe(from);
        } catch {
          /* illegal pairs covered above */
        }
      }
    }
  });
});

function sampleTicketEvent(kind: (typeof TICKET_EVENT_KINDS)[number]): TicketEvent {
  switch (kind) {
    case 'analysis_succeeded':
      return {
        kind,
        summary: 's',
        complexity: 'simple',
        targets: [{ repo_alias: 'api', repo_url: 'u', local_path: 'p', workflow: 'w' }],
      };
    case 'analysis_failed':
      return { kind, error: 'e' };
    default:
      return { kind } as TicketEvent;
  }
}

function sampleTargetEvent(kind: (typeof TARGET_EVENT_KINDS)[number]): TargetEvent {
  switch (kind) {
    case 'run_started':
      return { kind, run_id: 'run-1' };
    case 'run_failed':
      return { kind, reason: 'r' };
    case 'gate_opened':
      return { kind, approval_id: 'a', message: 'm' };
    case 'gate_approved':
      return { kind, comment: null };
    case 'gate_rejected':
      return { kind, reason: 'r' };
    case 'gate_blocker_created':
      return { kind, blocker: { title: 't', description: 'd' } };
    default:
      return { kind } as TargetEvent;
  }
}
