/**
 * The executor seam.
 *
 * Most of what the Archon version of this file protected was the consequence of
 * an out-of-process executor — a run id that arrived late, and a gate pause that
 * looked exactly like a clean exit. The engine reports both explicitly, so those
 * traps are gone rather than guarded.
 *
 * What is still worth pinning: a pause must never settle a target, a run the
 * store has never heard of is not a *failed* run, and an outcome the control
 * plane already recorded must not take the daemon down.
 */

import { describe, expect, test } from 'bun:test';
import {
  EngineExecutorAdapter,
  EngineRunStatusAdapter,
  issueFromTicket,
  repoTargetFrom,
  type RunEventSink,
} from '../control/adapters/executor.ts';
import { ControlAnalyzerAdapter, MaxConcurrentSlots } from '../control/adapters/analyzer.ts';
import { PrMergeWatcher } from '../orchestrator/pr-merge-watcher.ts';
import type { RunRecord } from '../executor/types.ts';
import type { DispatchContext } from '../control/ports.ts';
import { InvalidControlTransitionError } from '../control/transitions.ts';
import type { Issue, IssueAnalysis, RegistryContext, ServiceConfig } from '../domain/types.ts';
import type { TargetRow, TicketRow } from '../control/types.ts';
import { makeServiceConfig } from './helpers/fixtures.ts';

// ─── fixtures ───────────────────────────────────────────────────────────────

function ticket(over: Partial<TicketRow> = {}): TicketRow {
  return {
    id: 'tk-1',
    workspace: 'acme',
    tracker_kind: 'linear',
    external_id: 'lin-1',
    identifier: 'GAG-1',
    title: 'Fix the widget',
    description: 'broken',
    priority: 2,
    url: 'https://linear.app/gag-1',
    branch_name: 'gag-1',
    parent_external_id: null,
    external_state: 'In Progress',
    external_labels: ['bug'],
    blocked_by: [],
    status: 'running',
    analysis_summary: 'one repo',
    complexity: 'simple',
    analysis_error: null,
    external_created_at: '2026-07-01T00:00:00.000Z',
    external_updated_at: '2026-07-02T00:00:00.000Z',
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
    rationale: 'owns the endpoint',
    components: ['widget'],
    depends_on: [],
    ready_when: null,
    status: 'dispatching',
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

const ctx = (over: { ticket?: Partial<TicketRow>; target?: Partial<TargetRow> } = {}): DispatchContext => ({
  ticket: ticket(over.ticket),
  target: target(over.target),
});

class RecordingSink implements RunEventSink {
  calls: Array<[string, ...unknown[]]> = [];
  async runStarted(id: string, runId: string | null) {
    this.calls.push(['runStarted', id, runId]);
  }
  async runSucceeded(id: string) {
    this.calls.push(['runSucceeded', id]);
  }
  async runFailed(id: string, reason: string) {
    this.calls.push(['runFailed', id, reason]);
  }
  async gateOpened(id: string, approvalId: string, message: string) {
    this.calls.push(['gateOpened', id, approvalId, message]);
  }
  async recordRunId(id: string, runId: string) {
    this.calls.push(['recordRunId', id, runId]);
  }
  kinds(): string[] {
    return this.calls.map((c) => c[0]);
  }
}

/** Just enough GaggleExecutor for the adapter. */
function fakeEngine(over: Partial<{
  run: RunRecord | null;
  getRunError: string;
  cancelled: string[];
  decided: Array<{ id: string; decision: string; comment: string | null }>;
  cancelThrows: boolean;
}> = {}) {
  const cancelled: string[] = over.cancelled ?? [];
  const decided = over.decided ?? [];
  return {
    cancelled,
    decided,
    async getRun(): Promise<RunRecord | null> {
      if (over.getRunError) throw new Error(over.getRunError);
      return over.run ?? null;
    },
    async cancel(id: string): Promise<void> {
      if (over.cancelThrows) throw new Error('404 run not found');
      cancelled.push(id);
    },
    async decideAndWatch(id: string, decision: string, comment: string | null) {
      decided.push({ id, decision, comment });
      return { run_id: id, cancel: () => {}, done: Promise.resolve() };
    },
  };
}

function detail(status: string, approvalMessage?: string): RunRecord {
  return {
    id: 'run-1',
    workflow_name: 'wf',
    user_message: 'm',
    status: status as never,
    started_at: '2026-07-01T00:00:00.000Z',
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    metadata: approvalMessage ? { approval: { message: approvalMessage } } : {},
  } as unknown as RunRecord;
}

/** Builds the adapter and hands back the callbacks the launcher was given. */
function adapter(
  engine: ReturnType<typeof fakeEngine>,
  sink: RecordingSink,
  launch?: Parameters<typeof makeAdapter>[2],
) {
  return makeAdapter(engine, sink, launch);
}

type Callbacks = {
  onOutput: (line: string) => void;
  onRunId: (runId: string) => void;
  onGatePaused: (runId: string, message: string) => void;
  onExit: (event: { type: string; exit_code?: number }) => void;
};

function makeAdapter(
  engine: ReturnType<typeof fakeEngine>,
  sink: RecordingSink,
  launch?: (cb: Callbacks) => void,
  launchedRunId: string | null = 'run-1',
) {
  const cancels: string[] = [];
  let captured: Callbacks | null = null;
  const a = new EngineExecutorAdapter({
    executor: engine as never,
    launch: async (args) => {
      captured = args.callbacks;
      launch?.(args.callbacks);
      // The real launcher returns the id `startRun` already wrote. A fake that
      // returns null here would hide exactly the bug this shape exists to stop.
      return { cancel: (r?: string) => cancels.push(r ?? 'cancelled'), run_id: launchedRunId };
    },
    sink: () => sink,
  });
  return { a, cancels, cb: () => captured!, engine };
}

// ─── exit translation ───────────────────────────────────────────────────────

describe('EngineExecutorAdapter — outcome translation', () => {
  test('the run id is known synchronously, and recorded', async () => {
    // The Archon adapter resolved with null and reported the id later off a log
    // line. The engine writes the run row before startRun returns, so the id is
    // available immediately — a target is never `running` with no id.
    const sink = new RecordingSink();
    const { a } = makeAdapter(fakeEngine(), sink, (cb) => cb.onRunId('run-1'));

    const result = await a.spawnRun(ctx());

    expect(result.run_id).toBe('run-1');
    await Bun.sleep(5);
    expect(sink.calls).toContainEqual(['recordRunId', 'tg-1', 'run-1']);
  });

  test('a completed run succeeds the target', async () => {
    const sink = new RecordingSink();
    const { a, cb } = makeAdapter(fakeEngine(), sink, (c) => c.onRunId('run-1'));
    await a.spawnRun(ctx());
    sink.calls = [];

    cb().onExit({ type: 'run_succeeded' });
    await Bun.sleep(5);

    expect(sink.kinds()).toEqual(['runSucceeded']);
  });

  test('a gate pause opens a gate and never settles the target', async () => {
    // The behaviour the exit-code confirmation used to protect. It is now
    // structural — a pause is its own event — but it is the single most
    // damaging thing to get wrong, so it stays pinned.
    const sink = new RecordingSink();
    const { a } = makeAdapter(fakeEngine(), sink, (cb) => cb.onGatePaused('run-9', 'Approve?'));
    await a.spawnRun(ctx());
    await Bun.sleep(5);

    expect(sink.calls).toContainEqual(['recordRunId', 'tg-1', 'run-9']);
    expect(sink.calls).toContainEqual(['gateOpened', 'tg-1', 'run-9', 'Approve?']);
    expect(sink.kinds()).not.toContain('runSucceeded');
  });

  test('a failure carries the event name as the reason', async () => {
    const sink = new RecordingSink();
    const { a, cb } = makeAdapter(fakeEngine(), sink, (c) => c.onRunId('run-1'));
    await a.spawnRun(ctx());
    sink.calls = [];

    cb().onExit({ type: 'run_failed', exit_code: 1 });
    await Bun.sleep(5);

    expect(sink.calls).toContainEqual(['runFailed', 'tg-1', 'run_failed']);
  });

  test('an outcome the control plane already recorded does not escape', async () => {
    // The ordinary Cancel path: `cancel_confirmed` commits `cancelled`, then the
    // run reports `run_cancelled`, and `run_failed` is not accepted from
    // `cancelled`. An unhandled rejection here terminates the daemon.
    const sink = new RecordingSink();
    sink.runFailed = async () => {
      throw new InvalidControlTransitionError('cancelled', 'run_failed', 'target');
    };
    const { a, cb } = makeAdapter(fakeEngine(), sink, (c) => c.onRunId('run-1'));
    await a.spawnRun(ctx());

    cb().onExit({ type: 'run_cancelled' });
    await Bun.sleep(5);
    // Reaching here without an unhandled rejection is the assertion.
  });
});

describe('EngineExecutorAdapter — cancellation and gates', () => {
  test('killRun cancels the live handle and the run', async () => {
    const sink = new RecordingSink();
    const engine = fakeEngine();
    const { a, cancels } = makeAdapter(engine, sink);
    const c = ctx();
    await a.spawnRun(c);

    await a.killRun('run-1', c);

    expect(cancels).toEqual(['cancelled by operator']);
    expect(engine.cancelled).toEqual(['run-1']);
    expect(a.hasLiveRun('tg-1')).toBe(false);
  });

  test('killRun still cancels by id when this process holds no handle', async () => {
    // The common case after a restart, or for a run parked at a gate whose
    // runner has already returned.
    const sink = new RecordingSink();
    const engine = fakeEngine();
    const { a } = makeAdapter(engine, sink);
    await a.killRun('run-7', ctx());
    expect(engine.cancelled).toEqual(['run-7']);
  });

  test('a run that refuses to cancel does not throw — already gone is not a failure', async () => {
    const sink = new RecordingSink();
    const { a } = makeAdapter(fakeEngine({ cancelThrows: true }), sink);
    await a.killRun('run-x', ctx());
  });

  test('approve and reject both go through decideAndWatch', async () => {
    // Rejection is watched too: `on_reject` reworks and parks at the same gate
    // again, so a caller that only followed approvals would never hear the
    // second question.
    const sink = new RecordingSink();
    const engine = fakeEngine();
    const { a } = makeAdapter(engine, sink);

    await a.approveGate({ approval_id: 'a', run_id: 'run-1', comment: 'ship it', ctx: ctx() });
    await a.rejectGate({ approval_id: 'a', run_id: 'run-1', reason: 'wrong shape', ctx: ctx() });

    expect(engine.decided).toEqual([
      { id: 'run-1', decision: 'approved', comment: 'ship it' },
      { id: 'run-1', decision: 'rejected', comment: 'wrong shape' },
    ]);
  });

  test('answering a gate with no run id is a no-op, not a throw', async () => {
    const sink = new RecordingSink();
    const engine = fakeEngine();
    const { a } = makeAdapter(engine, sink);
    await a.rejectGate({ approval_id: null, run_id: null, reason: 'x', ctx: ctx() });
    expect(engine.decided).toEqual([]);
  });

  test('a gate that was already answered elsewhere is reported, not retried', async () => {
    const sink = new RecordingSink();
    const engine = {
      ...fakeEngine(),
      async decideAndWatch() {
        return null;
      },
    };
    const { a } = makeAdapter(engine as never, sink);
    await a.approveGate({ approval_id: 'a', run_id: 'run-1', comment: null, ctx: ctx() });
    expect(a.hasLiveRun('tg-1')).toBe(false);
  });
});

// ─── run observation ────────────────────────────────────────────────────────

describe('EngineRunStatusAdapter', () => {
  test('a run the store has never heard of is unknown, never failed', async () => {
    // The distinction that matters after a restart: `failed` would post a
    // spurious failure comment on the tracker for work that may be fine.
    const s = new EngineRunStatusAdapter(fakeEngine({ run: null }) as never);
    expect(await s.observeRun('run-1')).toEqual({ status: 'unknown' });
  });

  test('a paused run reports its approval message', async () => {
    const s = new EngineRunStatusAdapter(fakeEngine({ run: detail('paused', 'ok?') }) as never);
    expect(await s.observeRun('run-1')).toEqual({
      status: 'paused',
      approval: { id: 'run-1', message: 'ok?' },
    });
  });

  test('a paused run with no message still opens a gate, with a placeholder', async () => {
    const s = new EngineRunStatusAdapter(fakeEngine({ run: detail('paused') }) as never);
    const o = await s.observeRun('run-1');
    expect(o.status).toBe('paused');
    expect(o.approval?.message).toBeTruthy();
  });

  test('terminal statuses map straight through', async () => {
    for (const st of ['completed', 'failed', 'cancelled', 'running', 'pending'] as const) {
      const s = new EngineRunStatusAdapter(fakeEngine({ run: detail(st) }) as never);
      expect((await s.observeRun('run-1')).status).toBe(st);
    }
  });

  test('an interrupted run is unknown, so the startup sweep can still adopt it', async () => {
    // `interrupted` means an executor died and recovery has not reached it yet.
    // Reporting it as failed would settle a target that is about to resume.
    const s = new EngineRunStatusAdapter(fakeEngine({ run: detail('interrupted') }) as never);
    expect((await s.observeRun('run-1')).status).toBe('unknown');
  });

  test('an unrecognized status is unknown rather than guessed at', async () => {
    const s = new EngineRunStatusAdapter(fakeEngine({ run: detail('reticulating') }) as never);
    expect((await s.observeRun('run-1')).status).toBe('unknown');
  });
});

// ─── shape translation ──────────────────────────────────────────────────────

describe('control rows → worker shapes', () => {
  test('issueFromTicket uses the tracker id, not the ticket row id', async () => {
    // The worker talks to the tracker, so it needs the tracker's identity.
    const i = issueFromTicket(ticket());
    expect(i.id).toBe('lin-1');
    expect(i.identifier).toBe('GAG-1');
    expect(i.labels).toEqual(['bug']);
  });

  test('repoTargetFrom carries the operator-chosen workflow', () => {
    const r = repoTargetFrom(ticket(), target({ workflow: 'gaggle/gaggle-supervised' }));
    expect(r.workflow).toBe('gaggle/gaggle-supervised');
    expect(r.local_path).toBe('/repos/api');
    expect(r.depends_on).toEqual([]);
  });

  test('a target with no rationale falls back to the ticket title', () => {
    expect(repoTargetFrom(ticket(), target({ rationale: null })).rationale).toBe('Fix the widget');
  });
});

// ─── analyzer ───────────────────────────────────────────────────────────────

describe('ControlAnalyzerAdapter', () => {
  const registry = (repos: Array<Partial<RegistryContext['repositories'][number]>>): RegistryContext => ({
    repositories: repos.map((r) => ({
      name: 'api',
      url: 'https://github.com/acme/api',
      local_path: '/repos/api',
      description: '',
      default_workflow: 'gaggle/gaggle-fix-issue',
      available_workflows: [],
      components: [],
      narrative: '',
      ...r,
    })),
    components: [],
    last_synced_at: '',
    warnings: [],
    repos_dir: '/repos',
  });

  function analyzerReturning(analysis: Partial<IssueAnalysis>) {
    return {
      async analyze(_i: Issue, _c: RegistryContext): Promise<IssueAnalysis> {
        return {
          issue_id: 'lin-1',
          analysis_summary: 'summary',
          repo_targets: [],
          ...analysis,
        };
      },
    };
  }

  test('registry paths win over whatever the analyzer reported', async () => {
    const a = new ControlAnalyzerAdapter({
      cfg: makeServiceConfig(),
      analyzer: analyzerReturning({
        repo_targets: [
          {
            repo_url: 'https://wrong',
            repo_alias: 'api',
            local_path: '/wrong/path',
            workflow: 'gaggle/gaggle-fix-issue',
            rationale: 'r',
            components: [],
          },
        ],
      }),
      registry: () => registry([{}]),
    });

    const result = await a.analyze(ticket());
    expect(result.targets[0]!.local_path).toBe('/repos/api');
    expect(result.targets[0]!.repo_url).toBe('https://github.com/acme/api');
  });

  test('a target naming an unknown repo is dropped rather than dispatched', async () => {
    const a = new ControlAnalyzerAdapter({
      cfg: makeServiceConfig(),
      analyzer: analyzerReturning({
        repo_targets: [
          {
            repo_url: '',
            repo_alias: 'hallucinated',
            local_path: '/nope',
            workflow: 'w',
            rationale: 'r',
            components: [],
          },
        ],
      }),
      registry: () => registry([{}]),
    });
    expect((await a.analyze(ticket())).targets).toHaveLength(0);
  });

  test('a workflow the repo does not offer falls back to its default', async () => {
    const a = new ControlAnalyzerAdapter({
      cfg: makeServiceConfig(),
      analyzer: analyzerReturning({
        repo_targets: [
          {
            repo_url: '',
            repo_alias: 'api',
            local_path: '',
            workflow: 'gaggle/does-not-exist',
            rationale: 'r',
            components: [],
          },
        ],
      }),
      registry: () => registry([{ available_workflows: ['gaggle/gaggle-fix-issue'] }]),
    });
    expect((await a.analyze(ticket())).targets[0]!.workflow).toBe('gaggle/gaggle-fix-issue');
  });

  test('a workflow the repo does offer is respected — complexity routing survives', async () => {
    const a = new ControlAnalyzerAdapter({
      cfg: makeServiceConfig(),
      analyzer: analyzerReturning({
        complexity: 'complex',
        repo_targets: [
          {
            repo_url: '',
            repo_alias: 'api',
            local_path: '',
            workflow: 'gaggle/gaggle-supervised',
            rationale: 'r',
            components: [],
          },
        ],
      }),
      registry: () =>
        registry([{ available_workflows: ['gaggle/gaggle-fix-issue', 'gaggle/gaggle-supervised'] }]),
    });
    const r = await a.analyze(ticket());
    expect(r.targets[0]!.workflow).toBe('gaggle/gaggle-supervised');
    expect(r.complexity).toBe('complex');
  });

  test('dependencies and readiness survive the translation', async () => {
    const a = new ControlAnalyzerAdapter({
      cfg: makeServiceConfig(),
      analyzer: analyzerReturning({
        repo_targets: [
          {
            repo_url: '',
            repo_alias: 'api',
            local_path: '',
            workflow: 'gaggle/gaggle-fix-issue',
            rationale: 'r',
            components: ['widget'],
            depends_on: ['db'],
            ready_when: 'deployed:staging',
          },
        ],
      }),
      registry: () => registry([{}]),
    });
    const t = (await a.analyze(ticket())).targets[0]!;
    expect(t.depends_on).toEqual(['db']);
    expect(t.ready_when).toBe('deployed:staging');
    expect(t.components).toEqual(['widget']);
  });
});

describe('MaxConcurrentSlots', () => {
  test('free slots are the ceiling minus what is live, never negative', () => {
    const s = new MaxConcurrentSlots(3);
    expect(s.availableSlots(0)).toBe(3);
    expect(s.availableSlots(2)).toBe(1);
    expect(s.availableSlots(3)).toBe(0);
    expect(s.availableSlots(9)).toBe(0);
  });
});

// ─── PR merge watcher ───────────────────────────────────────────────────────

describe('PrMergeWatcher', () => {
  function watcher(over: {
    issues?: Issue[];
    links?: Record<string, string[]>;
    merged?: Set<string>;
    prReadyState?: string | null;
  } = {}) {
    const updated: Array<{ id: string; state: string }> = [];
    const w = new PrMergeWatcher({
      tracker: {
        async fetchIssuesByStates() {
          return over.issues ?? [];
        },
        async fetchIssuePRLinks(id: string) {
          return over.links?.[id] ?? [];
        },
        async updateIssueState(id: string, state: string) {
          updated.push({ id, state });
        },
      },
      cfg: {
        pr_ready_state: over.prReadyState === undefined ? 'In Review' : over.prReadyState,
        done_state: 'Done',
      },
      isMerged: async (url) => (over.merged ?? new Set()).has(url),
    });
    return { w, updated };
  }

  const issue = (id: string): Issue => ({
    id,
    identifier: id.toUpperCase(),
    title: 't',
    description: null,
    priority: null,
    state: 'In Review',
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
    parent_id: null,
  });

  test('an issue whose every PR merged moves to Done', async () => {
    const { w, updated } = watcher({
      issues: [issue('a')],
      links: { a: ['https://github.com/x/y/pull/1', 'https://github.com/x/y/pull/2'] },
      merged: new Set(['https://github.com/x/y/pull/1', 'https://github.com/x/y/pull/2']),
    });
    expect(await w.poll()).toBe(1);
    expect(updated).toEqual([{ id: 'a', state: 'Done' }]);
  });

  test('one unmerged PR is enough to leave the issue alone', async () => {
    const { w, updated } = watcher({
      issues: [issue('a')],
      links: { a: ['https://github.com/x/y/pull/1', 'https://github.com/x/y/pull/2'] },
      merged: new Set(['https://github.com/x/y/pull/1']),
    });
    expect(await w.poll()).toBe(0);
    expect(updated).toEqual([]);
  });

  test('an issue with no PRs is left alone — there is nothing to conclude', async () => {
    const { w, updated } = watcher({ issues: [issue('a')], links: {} });
    expect(await w.poll()).toBe(0);
    expect(updated).toEqual([]);
  });

  test('the watcher is disabled without a configured state', async () => {
    const { w, updated } = watcher({ prReadyState: null, issues: [issue('a')] });
    expect(await w.poll()).toBe(0);
    expect(updated).toEqual([]);
  });
});
