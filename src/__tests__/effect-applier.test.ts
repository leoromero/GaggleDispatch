/**
 * EffectApplier tests — one test per Effect kind verifying the right downstream
 * call happens. Mocks every dependency and records calls.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EffectApplier, type EffectApplierDeps } from '../orchestrator/effect-applier.ts';
import type { Effect, TargetIdentity } from '../orchestrator/state-machine.ts';
import { createInitialState } from '../orchestrator/state.ts';
import { makeIssue, makeRepoTarget, makeServiceConfig } from './helpers/fixtures.ts';
import type { LinearClient } from '../tracker/linear.ts';
import type { ArchonClient } from '../executor/archon-client.ts';
import type { WorkspaceManager } from '../workspace/workspace-manager.ts';

interface Call { op: string; args: unknown[] }

const IDENTITY: TargetIdentity = {
  parent_issue_id: 'p1',
  repo_alias: 'trialmatch-be',
  target_issue_id: 'sub-be',
};

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeApplier(overrides: { archonShouldThrow?: boolean } = {}) {
  const calls: Call[] = [];
  const cfg = makeServiceConfig();
  const state = createInitialState(cfg);
  const baseFolder = mkdtempSync(join(tmpdir(), 'gaggle-applier-'));
  tmpDirs.push(baseFolder);
  cfg.registry.base_folder = baseFolder;

  const tracker = {
    applyLabel: async (id: string, label: string) => { calls.push({ op: 'applyLabel', args: [id, label] }); },
    removeLabel: async (id: string, label: string) => { calls.push({ op: 'removeLabel', args: [id, label] }); },
    updateIssueState: async (id: string, s: string) => { calls.push({ op: 'updateIssueState', args: [id, s] }); },
    postComment: async (id: string, body: string) => { calls.push({ op: 'postComment', args: [id, body] }); return { id: 'c1' }; },
    createBlockerRelation: async (a: string, b: string) => { calls.push({ op: 'createBlockerRelation', args: [a, b] }); },
  } as unknown as LinearClient;

  const archon = {
    approveRun: async (run_id: string, msg?: string) => { calls.push({ op: 'approveRun', args: [run_id, msg] }); if (overrides.archonShouldThrow) throw new Error('archon down'); },
    rejectRun: async (run_id: string, reason: string) => { calls.push({ op: 'rejectRun', args: [run_id, reason] }); },
  } as unknown as ArchonClient;

  const workspace = {
    cleanAuxiliaryWorkspace: (id: string) => { calls.push({ op: 'cleanAuxiliaryWorkspace', args: [id] }); },
  } as unknown as WorkspaceManager;

  const deps: EffectApplierDeps = {
    cfg,
    tracker,
    archon,
    workspace,
    state,
    registryBaseFolder: baseFolder,
    spawnWorker: async (args) => { calls.push({ op: 'spawnWorker', args: [args] }); },
    cancelWorker: (key) => { calls.push({ op: 'cancelWorker', args: [key] }); },
    scheduleRetry: (key, delayMs) => { calls.push({ op: 'scheduleRetry', args: [key, delayMs] }); },
    createBlocker: async (spec, blocksId) => { calls.push({ op: 'createBlocker', args: [spec, blocksId] }); },
    createSubIssue: async (parentId, target) => { calls.push({ op: 'createSubIssue', args: [parentId, target.repo_alias] }); },
  };

  const applier = new EffectApplier(deps);
  return { applier, calls, state, baseFolder };
}

function hasCall(calls: Call[], op: string, args?: unknown[]): boolean {
  return calls.some((c) => c.op === op && (args ? JSON.stringify(c.args) === JSON.stringify(args) : true));
}

// ─── Linear effects ────────────────────────────────────────────────────────

describe('EffectApplier: Linear effects', () => {
  test('apply_label → tracker.applyLabel', async () => {
    const { applier, calls } = makeApplier();
    await applier.apply({ kind: 'apply_label', issue_id: 'p1', label: 'gaggle:claimed' });
    expect(hasCall(calls, 'applyLabel', ['p1', 'gaggle:claimed'])).toBe(true);
  });

  test('remove_label → tracker.removeLabel', async () => {
    const { applier, calls } = makeApplier();
    await applier.apply({ kind: 'remove_label', issue_id: 'p1', label: 'gaggle:running' });
    expect(hasCall(calls, 'removeLabel', ['p1', 'gaggle:running'])).toBe(true);
  });

  test('set_linear_state → tracker.updateIssueState', async () => {
    const { applier, calls } = makeApplier();
    await applier.apply({ kind: 'set_linear_state', issue_id: 'p1', state: 'Done' });
    expect(hasCall(calls, 'updateIssueState', ['p1', 'Done'])).toBe(true);
  });

  test('post_comment → tracker.postComment', async () => {
    const { applier, calls } = makeApplier();
    await applier.apply({ kind: 'post_comment', issue_id: 'p1', body: 'hello' });
    expect(hasCall(calls, 'postComment', ['p1', 'hello'])).toBe(true);
  });

  test('create_sub_issue → hook', async () => {
    const { applier, calls } = makeApplier();
    await applier.apply({ kind: 'create_sub_issue', parent_id: 'p1', target: makeRepoTarget({ repo_alias: 'fe' }) });
    expect(hasCall(calls, 'createSubIssue', ['p1', 'fe'])).toBe(true);
  });

  test('create_blocker_issue → hook', async () => {
    const { applier, calls } = makeApplier();
    await applier.apply({ kind: 'create_blocker_issue', spec: { title: 't', description: 'd' }, blocks_issue_id: 'sub-be' });
    expect(calls.some((c) => c.op === 'createBlocker')).toBe(true);
  });

  test('create_blocker_relation → tracker.createBlockerRelation', async () => {
    const { applier, calls } = makeApplier();
    await applier.apply({ kind: 'create_blocker_relation', blocker_id: 'b1', blocked_id: 'sub-be' });
    expect(hasCall(calls, 'createBlockerRelation', ['b1', 'sub-be'])).toBe(true);
  });
});

// ─── Worker effects ────────────────────────────────────────────────────────

describe('EffectApplier: worker effects', () => {
  test('spawn_worker → hook with right args', async () => {
    const { applier, calls } = makeApplier();
    const target = makeRepoTarget({ repo_alias: 'trialmatch-be' });
    await applier.apply({ kind: 'spawn_worker', identity: IDENTITY, target, attempt: 0 });
    const spawn = calls.find((c) => c.op === 'spawnWorker');
    expect(spawn).toBeDefined();
    expect((spawn!.args[0] as { attempt: number }).attempt).toBe(0);
  });

  test('cancel_worker → hook', async () => {
    const { applier, calls } = makeApplier();
    await applier.apply({ kind: 'cancel_worker', key: 'p1__trialmatch-be' });
    expect(hasCall(calls, 'cancelWorker', ['p1__trialmatch-be'])).toBe(true);
  });

  test('cleanup_workspace → workspace.cleanAuxiliaryWorkspace', async () => {
    const { applier, calls } = makeApplier();
    await applier.apply({ kind: 'cleanup_workspace', issue_identifier: 'SYM-1' });
    expect(hasCall(calls, 'cleanAuxiliaryWorkspace', ['SYM-1'])).toBe(true);
  });
});

// ─── Archon effects with gate resolution ───────────────────────────────────

describe('EffectApplier: Archon control plane', () => {
  test('archon_approve looks up gate run_id and deletes the gate entry', async () => {
    const { applier, calls, state } = makeApplier();
    // Prime a supervised_gates entry
    state.supervised_gates.set('p1__trialmatch-be', {
      run_id: 'run-xyz',
      issue_id: 'p1',
      issue: makeIssue({ id: 'p1' }),
      repo_alias: 'trialmatch-be',
      repo_target: makeRepoTarget(),
      sub_issue_id: 'sub-be',
      paused_at: Date.now(),
      gate_message: 'review',
      comment_id: null,
      gate_state_applied: false,
      attempt: null,
    });
    await applier.apply({ kind: 'archon_approve', identity: IDENTITY, message: 'lgtm' });
    expect(hasCall(calls, 'approveRun', ['run-xyz', 'lgtm'])).toBe(true);
    expect(state.supervised_gates.has('p1__trialmatch-be')).toBe(false);
  });

  test('archon_reject looks up gate run_id and deletes the gate entry', async () => {
    const { applier, calls, state } = makeApplier();
    state.supervised_gates.set('p1__trialmatch-be', {
      run_id: 'run-xyz',
      issue_id: 'p1',
      issue: makeIssue({ id: 'p1' }),
      repo_alias: 'trialmatch-be',
      repo_target: makeRepoTarget(),
      sub_issue_id: 'sub-be',
      paused_at: Date.now(),
      gate_message: 'review',
      comment_id: null,
      gate_state_applied: false,
      attempt: null,
    });
    await applier.apply({ kind: 'archon_reject', identity: IDENTITY, reason: 'no' });
    expect(hasCall(calls, 'rejectRun', ['run-xyz', 'no'])).toBe(true);
    expect(state.supervised_gates.has('p1__trialmatch-be')).toBe(false);
  });

  test('archon_approve with no gate present → no Archon call, no throw', async () => {
    const { applier, calls } = makeApplier();
    await applier.apply({ kind: 'archon_approve', identity: IDENTITY, message: null });
    expect(calls.some((c) => c.op === 'approveRun')).toBe(false);
  });

  test('archon error is swallowed and logged', async () => {
    const { applier, state } = makeApplier({ archonShouldThrow: true });
    state.supervised_gates.set('p1__trialmatch-be', {
      run_id: 'run-xyz', issue_id: 'p1', issue: makeIssue({ id: 'p1' }),
      repo_alias: 'trialmatch-be', repo_target: makeRepoTarget(),
      sub_issue_id: 'sub-be', paused_at: Date.now(), gate_message: 'r',
      comment_id: null, gate_state_applied: false, attempt: null,
    });
    // Should not throw
    await applier.apply({ kind: 'archon_approve', identity: IDENTITY, message: 'lgtm' });
  });
});

// ─── Persistence ───────────────────────────────────────────────────────────

describe('EffectApplier: persistence', () => {
  test('persist_run writes a run entry to gaggle-runs.json', async () => {
    const { applier, baseFolder } = makeApplier();
    await applier.apply({
      kind: 'persist_run',
      key: 'p1__trialmatch-be',
      run_id: 'cafebabecafebabecafebabecafebabe',
      meta: { parent_issue_id: 'p1', sub_issue_id: 'sub-be', repo_alias: 'trialmatch-be' },
    });
    const file = join(baseFolder, 'gaggle-runs.json');
    expect(existsSync(file)).toBe(true);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    expect(data.entries['p1__trialmatch-be'].archon_run_id).toBe('cafebabecafebabecafebabecafebabe');
  });

  test('delete_run removes the entry', async () => {
    const { applier, baseFolder } = makeApplier();
    await applier.apply({
      kind: 'persist_run', key: 'p1__trialmatch-be', run_id: 'r1',
      meta: { parent_issue_id: 'p1', sub_issue_id: 'sub-be', repo_alias: 'trialmatch-be' },
    });
    await applier.apply({ kind: 'delete_run', key: 'p1__trialmatch-be' });
    const data = JSON.parse(readFileSync(join(baseFolder, 'gaggle-runs.json'), 'utf8'));
    expect(data.entries['p1__trialmatch-be']).toBeUndefined();
  });

  test('persist_retry is currently a no-op (logs only)', async () => {
    const { applier } = makeApplier();
    // Should not throw
    await applier.apply({
      kind: 'persist_retry',
      key: 'p1__trialmatch-be',
      meta: { attempt: 2, due_at_ms: Date.now() + 10_000, reason: 'crash' },
    });
  });
});

// ─── Timers & in-memory state ──────────────────────────────────────────────

describe('EffectApplier: timers & in-memory state', () => {
  test('schedule_retry_timer → hook', async () => {
    const { applier, calls } = makeApplier();
    await applier.apply({ kind: 'schedule_retry_timer', key: 'p1__trialmatch-be', delay_ms: 5_000 });
    expect(hasCall(calls, 'scheduleRetry', ['p1__trialmatch-be', 5_000])).toBe(true);
  });

  test('register_supervised_gate adds an entry to state.supervised_gates', async () => {
    const { applier, state } = makeApplier();
    await applier.apply({
      kind: 'register_supervised_gate',
      identity: IDENTITY,
      target: makeRepoTarget({ repo_alias: 'trialmatch-be' }),
      run_id: 'run-1',
      message: 'review plan',
    });
    const gate = state.supervised_gates.get('p1__trialmatch-be');
    expect(gate).toBeDefined();
    expect(gate?.run_id).toBe('run-1');
    expect(gate?.gate_message).toBe('review plan');
    expect(gate?.sub_issue_id).toBe('sub-be');
  });

  test('register_supervised_gate for mono-repo sets sub_issue_id = null', async () => {
    const { applier, state } = makeApplier();
    const monoIdentity: TargetIdentity = {
      parent_issue_id: 'p1',
      repo_alias: 'mono',
      target_issue_id: 'p1', // same as parent → mono-repo
    };
    await applier.apply({
      kind: 'register_supervised_gate',
      identity: monoIdentity,
      target: makeRepoTarget({ repo_alias: 'mono' }),
      run_id: 'run-2',
      message: 'mono',
    });
    expect(state.supervised_gates.get('p1__mono')?.sub_issue_id).toBeNull();
  });

  test('release_parent_claim removes from state.claimed and pending_issues', async () => {
    const { applier, state } = makeApplier();
    state.claimed.add('p1');
    state.pending_issues.set('p1', makeIssue({ id: 'p1' }));
    await applier.apply({ kind: 'release_parent_claim', parent_id: 'p1' });
    expect(state.claimed.has('p1')).toBe(false);
    expect(state.pending_issues.has('p1')).toBe(false);
  });

  test('invalidate_analysis_cache removes from state.analysis_cache', async () => {
    const { applier, state } = makeApplier();
    state.analysis_cache.set('p1', { analysis: { issue_id: 'p1', analysis_summary: '', repo_targets: [] }, cached_at: Date.now() });
    await applier.apply({ kind: 'invalidate_analysis_cache', issue_id: 'p1' });
    expect(state.analysis_cache.has('p1')).toBe(false);
  });
});

// ─── Batch ─────────────────────────────────────────────────────────────────

describe('EffectApplier: applyAll', () => {
  test('processes all effects sequentially', async () => {
    const { applier, calls } = makeApplier();
    const effects: Effect[] = [
      { kind: 'apply_label', issue_id: 'p1', label: 'gaggle:claimed' },
      { kind: 'apply_label', issue_id: 'sub-be', label: 'gaggle:running' },
      { kind: 'log', level: 'info', message: 'dispatched', fields: { p: 'p1' } },
    ];
    await applier.applyAll(effects);
    expect(hasCall(calls, 'applyLabel', ['p1', 'gaggle:claimed'])).toBe(true);
    expect(hasCall(calls, 'applyLabel', ['sub-be', 'gaggle:running'])).toBe(true);
  });

  test('one failing effect does not stop the others', async () => {
    const { applier, calls } = makeApplier();
    // Make applyLabel throw on the first call
    let invoked = 0;
    (applier as unknown as { deps: EffectApplierDeps }).deps.tracker = {
      applyLabel: async () => { invoked++; if (invoked === 1) throw new Error('linear flake'); },
      removeLabel: async () => {},
      updateIssueState: async () => {},
      postComment: async () => ({ id: 'x' }),
      createBlockerRelation: async () => {},
    } as unknown as LinearClient;

    await applier.applyAll([
      { kind: 'apply_label', issue_id: 'p1', label: 'gaggle:claimed' },
      { kind: 'log', level: 'info', message: 'still ran', fields: {} },
    ]);
    expect(invoked).toBe(1);
    // applyAll returned normally → second effect was processed
  });
});
