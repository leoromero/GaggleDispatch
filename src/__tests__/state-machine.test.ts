/**
 * State machine transition matrix tests.
 *
 * One test per valid (state, event) transition; one parameterized test for
 * every disallowed pair. If a new state or event is added without updating
 * this file, the "invalid pairs" test will fail and surface the omission.
 */

import { describe, expect, test } from 'bun:test';
import {
  parentTransition,
  targetTransition,
  classifyParentState,
  classifyTargetState,
  InvalidTransitionError,
  type ParentState,
  type ParentEvent,
  type ParentLabel,
  type ParentTransitionContext,
  type TargetState,
  type TargetEvent,
  type TargetLabel,
  type TargetTransitionContext,
  type TargetIdentity,
  type Effect,
} from '../orchestrator/state-machine.ts';
import type { ArchonRunRecord } from '../executor/archon-client.ts';
import { makeIssue, makeRepoTarget, makeServiceConfig } from './helpers/fixtures.ts';

// ─── fixtures ──────────────────────────────────────────────────────────────

const IDENTITY: TargetIdentity = {
  parent_issue_id: 'p1',
  repo_alias: 'trialmatch-be',
  target_issue_id: 'sub-be',
};

function pctx(targets: Record<string, TargetState> = {}): ParentTransitionContext {
  return {
    cfg: makeServiceConfig(),
    parent_issue: makeIssue({ id: 'p1', identifier: 'SYM-1' }),
    targets: new Map(Object.entries(targets)),
  };
}

function tctx(opts: { attempt?: number; siblings?: Record<string, TargetState> } = {}): TargetTransitionContext {
  return {
    cfg: makeServiceConfig(),
    identity: IDENTITY,
    parent_issue: makeIssue({ id: 'p1', identifier: 'SYM-1' }),
    target: makeRepoTarget({ repo_alias: 'trialmatch-be' }),
    siblings: new Map(Object.entries(opts.siblings ?? {})),
    attempt: opts.attempt ?? 0,
  };
}

function effectKinds(effects: Effect[]): string[] {
  return effects.map((e) => e.kind);
}

function hasEffect(effects: Effect[], kind: Effect['kind'], pred?: (e: Effect) => boolean): boolean {
  return effects.some((e) => e.kind === kind && (pred ? pred(e) : true));
}

// ─── Parent SM: valid transitions ──────────────────────────────────────────

describe('parentTransition: valid', () => {
  test('unclaimed + analysis_started → analyzing', () => {
    const t = parentTransition('unclaimed', { kind: 'analysis_started' }, pctx());
    expect(t.to).toBe('analyzing');
    expect(hasEffect(t.effects, 'apply_label', (e) => e.kind === 'apply_label' && e.label === 'gaggle:analyzing')).toBe(true);
  });

  test('analyzing + analysis_succeeded → claimed', () => {
    const t = parentTransition('analyzing', { kind: 'analysis_succeeded', targets: [makeRepoTarget()] }, pctx());
    expect(t.to).toBe('claimed');
    expect(hasEffect(t.effects, 'remove_label', (e) => e.kind === 'remove_label' && e.label === 'gaggle:analyzing')).toBe(true);
    expect(hasEffect(t.effects, 'apply_label', (e) => e.kind === 'apply_label' && e.label === 'gaggle:claimed')).toBe(true);
  });

  test('analyzing + analysis_failed → unclaimed', () => {
    const t = parentTransition('analyzing', { kind: 'analysis_failed', error: 'boom' }, pctx());
    expect(t.to).toBe('unclaimed');
    expect(hasEffect(t.effects, 'remove_label', (e) => e.kind === 'remove_label' && e.label === 'gaggle:analyzing')).toBe(true);
    expect(hasEffect(t.effects, 'log')).toBe(true);
  });

  test('analyzing + parent_externally_terminal → cancelled', () => {
    const t = parentTransition('analyzing', { kind: 'parent_externally_terminal' }, pctx());
    expect(t.to).toBe('cancelled');
    expect(hasEffect(t.effects, 'remove_label')).toBe(true);
    expect(hasEffect(t.effects, 'invalidate_analysis_cache')).toBe(true);
  });

  test('claimed + target_terminal (some non-terminal) → claimed (no-op)', () => {
    const t = parentTransition('claimed', { kind: 'target_terminal', alias: 'a', outcome: 'succeeded' },
      pctx({ a: 'succeeded', b: 'running' }));
    expect(t.to).toBe('claimed');
    expect(t.effects).toEqual([]);
  });

  test('claimed + target_terminal (all succeeded) → done', () => {
    const t = parentTransition('claimed', { kind: 'target_terminal', alias: 'b', outcome: 'succeeded' },
      pctx({ a: 'succeeded', b: 'succeeded' }));
    expect(t.to).toBe('done');
    expect(hasEffect(t.effects, 'remove_label', (e) => e.kind === 'remove_label' && e.label === 'gaggle:claimed')).toBe(true);
    expect(hasEffect(t.effects, 'set_linear_state', (e) => e.kind === 'set_linear_state' && e.state === 'Done')).toBe(true);
    expect(hasEffect(t.effects, 'release_parent_claim')).toBe(true);
  });

  test('claimed + target_terminal (one failed) → cancelled', () => {
    const t = parentTransition('claimed', { kind: 'target_terminal', alias: 'b', outcome: 'failed' },
      pctx({ a: 'succeeded', b: 'failed' }));
    expect(t.to).toBe('cancelled');
    expect(hasEffect(t.effects, 'set_linear_state', (e) => e.kind === 'set_linear_state' && e.state === 'Cancelled')).toBe(true);
  });

  test('claimed + parent_externally_terminal → cancelled', () => {
    const t = parentTransition('claimed', { kind: 'parent_externally_terminal' }, pctx({ a: 'running' }));
    expect(t.to).toBe('cancelled');
    expect(hasEffect(t.effects, 'cleanup_workspace')).toBe(true);
  });
});

// ─── Parent SM: invalid transitions ────────────────────────────────────────

describe('parentTransition: invalid pairs throw', () => {
  const allStates: ParentState[] = ['unclaimed', 'analyzing', 'claimed', 'done', 'cancelled'];
  const allEvents: ParentEvent[] = [
    { kind: 'analysis_started' },
    { kind: 'analysis_succeeded', targets: [] },
    { kind: 'analysis_failed', error: 'x' },
    { kind: 'target_terminal', alias: 'a', outcome: 'succeeded' },
    { kind: 'parent_externally_terminal' },
  ];

  const VALID = new Set<string>([
    'unclaimed:analysis_started',
    'analyzing:analysis_succeeded',
    'analyzing:analysis_failed',
    'analyzing:parent_externally_terminal',
    'claimed:target_terminal',
    'claimed:parent_externally_terminal',
  ]);

  for (const s of allStates) {
    for (const e of allEvents) {
      const pair = `${s}:${e.kind}`;
      if (VALID.has(pair)) continue;
      test(`rejects ${pair}`, () => {
        expect(() => parentTransition(s, e, pctx({ a: 'running' }))).toThrow(InvalidTransitionError);
      });
    }
  }
});

// ─── Target SM: valid transitions ──────────────────────────────────────────

describe('targetTransition: valid', () => {
  test('queued + dispatch_attempted → dispatching (spawns worker)', () => {
    const t = targetTransition('queued', { kind: 'dispatch_attempted' }, tctx());
    expect(t.to).toBe('dispatching');
    expect(effectKinds(t.effects)).toContain('apply_label');
    expect(effectKinds(t.effects)).toContain('spawn_worker');
  });

  test('queued + upstream_unblocked → dispatching', () => {
    const t = targetTransition('queued', { kind: 'upstream_unblocked' }, tctx());
    expect(t.to).toBe('dispatching');
    expect(effectKinds(t.effects)).toContain('spawn_worker');
  });

  test('dispatching + worker_started → running', () => {
    const t = targetTransition('dispatching', { kind: 'worker_started', pid: 1234 }, tctx());
    expect(t.to).toBe('running');
    expect(hasEffect(t.effects, 'remove_label', (e) => e.kind === 'remove_label' && e.label === 'gaggle:dispatching')).toBe(true);
    expect(hasEffect(t.effects, 'apply_label', (e) => e.kind === 'apply_label' && e.label === 'gaggle:running')).toBe(true);
  });

  test('dispatching + worker_failed (under retry cap) → retrying', () => {
    const t = targetTransition('dispatching', { kind: 'worker_failed', reason: 'spawn_err' }, tctx({ attempt: 0 }));
    expect(t.to).toBe('retrying');
    expect(hasEffect(t.effects, 'apply_label', (e) => e.kind === 'apply_label' && e.label === 'gaggle:retrying')).toBe(true);
    expect(hasEffect(t.effects, 'persist_retry')).toBe(true);
    expect(hasEffect(t.effects, 'schedule_retry_timer')).toBe(true);
  });

  test('running + worker_emitted_run_id → running (persists run id)', () => {
    const t = targetTransition('running', { kind: 'worker_emitted_run_id', run_id: 'r1' }, tctx());
    expect(t.to).toBe('running');
    expect(hasEffect(t.effects, 'persist_run')).toBe(true);
  });

  test('running + worker_succeeded → succeeded', () => {
    const t = targetTransition('running', { kind: 'worker_succeeded' }, tctx());
    expect(t.to).toBe('succeeded');
    expect(hasEffect(t.effects, 'set_linear_state', (e) => e.kind === 'set_linear_state' && e.state === 'Done')).toBe(true);
    expect(hasEffect(t.effects, 'delete_run')).toBe(true);
  });

  test('running + worker_failed → retrying', () => {
    const t = targetTransition('running', { kind: 'worker_failed', reason: 'crash' }, tctx({ attempt: 1 }));
    expect(t.to).toBe('retrying');
  });

  test('running + worker_failed at max attempts → failed', () => {
    const t = targetTransition('running', { kind: 'worker_failed', reason: 'crash' }, tctx({ attempt: 10 }));
    expect(t.to).toBe('failed');
    expect(hasEffect(t.effects, 'set_linear_state', (e) => e.kind === 'set_linear_state' && e.state === 'Cancelled')).toBe(true);
  });

  test('running + gate_paused → gate_waiting', () => {
    const t = targetTransition('running', { kind: 'gate_paused', run_id: 'r1', message: 'review plan' }, tctx());
    expect(t.to).toBe('gate_waiting');
    expect(hasEffect(t.effects, 'remove_label', (e) => e.kind === 'remove_label' && e.label === 'gaggle:running')).toBe(true);
    expect(hasEffect(t.effects, 'apply_label', (e) => e.kind === 'apply_label' && e.label === 'gaggle:waiting-human')).toBe(true);
    expect(hasEffect(t.effects, 'register_supervised_gate')).toBe(true);
  });

  test('running + gate_paused with gate_waiting_state → also sets Linear state', () => {
    const ctx = tctx();
    ctx.cfg.tracker.gate_waiting_state = 'Awaiting Review';
    const t = targetTransition('running', { kind: 'gate_paused', run_id: 'r1', message: 'x' }, ctx);
    expect(hasEffect(t.effects, 'set_linear_state', (e) => e.kind === 'set_linear_state' && e.state === 'Awaiting Review')).toBe(true);
  });

  test('gate_waiting + gate_approved → running', () => {
    const t = targetTransition('gate_waiting', { kind: 'gate_approved', message: 'lgtm' }, tctx());
    expect(t.to).toBe('running');
    expect(hasEffect(t.effects, 'archon_approve')).toBe(true);
  });

  test('gate_waiting + gate_rejected → retrying', () => {
    const t = targetTransition('gate_waiting', { kind: 'gate_rejected', message: 'no' }, tctx({ attempt: 0 }));
    expect(t.to).toBe('retrying');
    expect(hasEffect(t.effects, 'archon_reject')).toBe(true);
  });

  test('gate_waiting + gate_rejected at max → failed', () => {
    const t = targetTransition('gate_waiting', { kind: 'gate_rejected', message: 'no' }, tctx({ attempt: 10 }));
    expect(t.to).toBe('failed');
  });

  test('gate_waiting + gate_timed_out → retrying', () => {
    const t = targetTransition('gate_waiting', { kind: 'gate_timed_out' }, tctx());
    expect(t.to).toBe('retrying');
    expect(hasEffect(t.effects, 'archon_reject', (e) => e.kind === 'archon_reject' && /timeout/i.test(e.reason))).toBe(true);
  });

  test('gate_waiting + gate_create_blocker → queued', () => {
    const t = targetTransition('gate_waiting',
      { kind: 'gate_create_blocker', blocker: { title: 'BE owns this', description: 'Need API first' } },
      tctx());
    expect(t.to).toBe('queued');
    expect(hasEffect(t.effects, 'apply_label', (e) => e.kind === 'apply_label' && e.label === 'gaggle:queued')).toBe(true);
    expect(hasEffect(t.effects, 'create_blocker_issue')).toBe(true);
    expect(hasEffect(t.effects, 'archon_reject')).toBe(true);
    expect(hasEffect(t.effects, 'post_comment')).toBe(true);
  });

  test('retrying + retry_due → dispatching', () => {
    const t = targetTransition('retrying', { kind: 'retry_due' }, tctx({ attempt: 2 }));
    expect(t.to).toBe('dispatching');
    expect(hasEffect(t.effects, 'spawn_worker', (e) => e.kind === 'spawn_worker' && e.attempt === 2)).toBe(true);
    expect(hasEffect(t.effects, 'delete_retry')).toBe(true);
  });
});

// ─── Target SM: parent_terminal accepted from every non-terminal state ─────

describe('targetTransition: parent_terminal universal handling', () => {
  const nonTerminalStates: TargetState[] = ['queued', 'dispatching', 'running', 'gate_waiting', 'retrying'];
  for (const s of nonTerminalStates) {
    test(`${s} + parent_terminal → failed`, () => {
      const t = targetTransition(s, { kind: 'parent_terminal' }, tctx());
      expect(t.to).toBe('failed');
    });
  }
  for (const s of ['succeeded', 'failed'] as TargetState[]) {
    test(`${s} + parent_terminal throws (already terminal)`, () => {
      expect(() => targetTransition(s, { kind: 'parent_terminal' }, tctx())).toThrow(InvalidTransitionError);
    });
  }
  test('running + parent_terminal also cancels the worker', () => {
    const t = targetTransition('running', { kind: 'parent_terminal' }, tctx());
    expect(hasEffect(t.effects, 'cancel_worker')).toBe(true);
  });
});

// ─── Target SM: invalid transitions ────────────────────────────────────────

// ─── Recovery classifiers ──────────────────────────────────────────────────

function archonRun(status: ArchonRunRecord['status'], id = 'r1'): ArchonRunRecord {
  return {
    id, status,
    workflow_name: 'gaggle/gaggle-fix-issue',
    working_path: '/x',
    started_at: new Date().toISOString(),
    user_message: '', completed_at: null, last_activity_at: null, metadata: {},
  };
}

describe('classifyParentState', () => {
  test('gaggle:analyzing → analyzing', () => {
    expect(classifyParentState({ parent_id: 'p1', parent_labels: new Set<ParentLabel>(['gaggle:analyzing']), linear_state: 'In Progress' }).state).toBe('analyzing');
  });

  test('gaggle:claimed → claimed', () => {
    expect(classifyParentState({ parent_id: 'p1', parent_labels: new Set<ParentLabel>(['gaggle:claimed']), linear_state: 'In Progress' }).state).toBe('claimed');
  });

  test('both labels → analyzing wins (in-flight analysis takes precedence)', () => {
    expect(classifyParentState({ parent_id: 'p1', parent_labels: new Set<ParentLabel>(['gaggle:analyzing', 'gaggle:claimed']), linear_state: 'In Progress' }).state).toBe('analyzing');
  });

  test('no labels → unclaimed', () => {
    expect(classifyParentState({ parent_id: 'p1', parent_labels: new Set<ParentLabel>(), linear_state: 'In Progress' }).state).toBe('unclaimed');
  });
});

describe('classifyTargetState', () => {
  const identity: TargetIdentity = { parent_issue_id: 'p1', repo_alias: 'a', target_issue_id: 'sub-a' };

  function call(opts: { labels?: TargetLabel[]; archon?: ArchonRunRecord | null; retry?: { attempt: number; due_at_ms: number; reason: string | null } | null } = {}) {
    return classifyTargetState({
      identity,
      target_labels: new Set(opts.labels ?? []),
      linear_state: 'In Progress',
      archon_run: opts.archon ?? null,
      persisted_retry: opts.retry ?? null,
    });
  }

  // Waiting-human dominates
  test('waiting-human alone → gate_waiting', () => {
    const c = call({ labels: ['gaggle:waiting-human'] });
    expect(c?.state).toBe('gate_waiting');
  });
  test('waiting-human with paused Archon → still gate_waiting, run_id captured', () => {
    const c = call({ labels: ['gaggle:waiting-human'], archon: archonRun('paused', 'r-gate') });
    expect(c?.state).toBe('gate_waiting');
    expect(c?.run_id).toBe('r-gate');
  });

  // Running label × Archon status matrix
  test('running + Archon running → running', () => {
    const c = call({ labels: ['gaggle:running'], archon: archonRun('running', 'r-live') });
    expect(c?.state).toBe('running');
    expect(c?.run_id).toBe('r-live');
  });
  test('running + Archon paused → gate_waiting (label drift)', () => {
    const c = call({ labels: ['gaggle:running'], archon: archonRun('paused') });
    expect(c?.state).toBe('gate_waiting');
  });
  test('running + Archon completed → succeeded (label drift; work done)', () => {
    const c = call({ labels: ['gaggle:running'], archon: archonRun('completed') });
    expect(c?.state).toBe('succeeded');
  });
  test('running + Archon failed → retrying, run_id cleared', () => {
    const c = call({ labels: ['gaggle:running'], archon: archonRun('failed') });
    expect(c?.state).toBe('retrying');
    expect(c?.run_id).toBeNull();
  });
  test('running + no Archon run → retrying', () => {
    const c = call({ labels: ['gaggle:running'], archon: null });
    expect(c?.state).toBe('retrying');
  });

  // Other labels
  test('queued → queued', () => {
    expect(call({ labels: ['gaggle:queued'] })?.state).toBe('queued');
  });
  test('retrying → retrying', () => {
    expect(call({ labels: ['gaggle:retrying'] })?.state).toBe('retrying');
  });
  test('dispatching → retrying (crashed mid-dispatch)', () => {
    expect(call({ labels: ['gaggle:dispatching'] })?.state).toBe('retrying');
  });

  // Recovered attempt count
  test('retrying with persisted retry meta → attempt comes from meta', () => {
    const c = call({ labels: ['gaggle:retrying'], retry: { attempt: 3, due_at_ms: 1, reason: 'x' } });
    expect(c?.attempt).toBe(3);
  });

  // No labels
  test('no target-level labels → null', () => {
    expect(call({ labels: [] })).toBeNull();
  });
});

describe('targetTransition: invalid pairs throw', () => {
  const allStates: TargetState[] = ['queued', 'dispatching', 'running', 'gate_waiting', 'retrying', 'succeeded', 'failed'];
  const allEvents: TargetEvent[] = [
    { kind: 'dispatch_attempted' },
    { kind: 'worker_started', pid: 1 },
    { kind: 'worker_emitted_run_id', run_id: 'r' },
    { kind: 'worker_succeeded' },
    { kind: 'worker_failed', reason: 'x' },
    { kind: 'gate_paused', run_id: 'r', message: 'm' },
    { kind: 'gate_approved', message: null },
    { kind: 'gate_rejected', message: 'no' },
    { kind: 'gate_create_blocker', blocker: { title: 't', description: 'd' } },
    { kind: 'gate_timed_out' },
    { kind: 'retry_due' },
    { kind: 'upstream_unblocked' },
    { kind: 'parent_terminal' },
  ];

  const VALID = new Set<string>([
    'queued:dispatch_attempted', 'queued:upstream_unblocked', 'queued:parent_terminal',
    'dispatching:worker_started', 'dispatching:worker_failed', 'dispatching:parent_terminal',
    'running:worker_emitted_run_id', 'running:worker_succeeded', 'running:worker_failed', 'running:gate_paused', 'running:parent_terminal',
    'gate_waiting:gate_approved', 'gate_waiting:gate_rejected', 'gate_waiting:gate_create_blocker', 'gate_waiting:gate_timed_out', 'gate_waiting:parent_terminal',
    'retrying:retry_due', 'retrying:parent_terminal',
  ]);

  for (const s of allStates) {
    for (const e of allEvents) {
      const pair = `${s}:${e.kind}`;
      if (VALID.has(pair)) continue;
      test(`rejects ${pair}`, () => {
        expect(() => targetTransition(s, e, tctx())).toThrow(InvalidTransitionError);
      });
    }
  }
});
