/**
 * The executor seam.
 *
 * These cover the two behaviours the old orchestrator got wrong or got right only
 * by accident: Archon exits 0 when a workflow *pauses*, and a run the executor has
 * never heard of is not a failed run. Both are the kind of thing that silently
 * corrupts a board, so both are pinned here.
 */

import { describe, expect, test } from 'bun:test';
import {
  ArchonExecutorAdapter,
  ArchonRunStatusAdapter,
  issueFromTicket,
  repoTargetFrom,
  type RunEventSink,
} from '../control/adapters/archon.ts';
import { ControlAnalyzerAdapter, MaxConcurrentSlots } from '../control/adapters/analyzer.ts';
import { PrMergeWatcher } from '../orchestrator/pr-merge-watcher.ts';
import type { ArchonRunDetail } from '../executor/archon-client.ts';
import type { DispatchContext } from '../control/ports.ts';
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

/** Just enough ArchonClient for the adapter. */
function fakeClient(over: Partial<{
  detail: ArchonRunDetail | null;
  detailError: string;
  cancelled: string[];
  rejected: Array<{ id: string; reason?: string }>;
}> = {}) {
  const cancelled: string[] = over.cancelled ?? [];
  const rejected = over.rejected ?? [];
  return {
    cancelled,
    rejected,
    async getRunDetail(): Promise<ArchonRunDetail | null> {
      if (over.detailError) throw new Error(over.detailError);
      return over.detail ?? null;
    },
    async cancelRun(id: string): Promise<void> {
      cancelled.push(id);
    },
    async rejectRun(id: string, reason?: string): Promise<void> {
      rejected.push({ id, reason });
    },
  };
}

function detail(status: string, approvalMessage?: string): ArchonRunDetail {
  return {
    run: {
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'm',
      status: status as never,
      started_at: '2026-07-01T00:00:00.000Z',
      completed_at: null,
      last_activity_at: null,
      working_path: null,
      metadata: approvalMessage ? { approval: { message: approvalMessage } } : {},
    },
  } as unknown as ArchonRunDetail;
}

function adapter(
  client: ReturnType<typeof fakeClient>,
  sink: RecordingSink,
  launch?: () => Promise<{ cancel: (reason?: string) => void }>,
) {
  const cancels: string[] = [];
  const a = new ArchonExecutorAdapter({
    cfg: makeServiceConfig(),
    client: client as never,
    launch: launch ?? (async () => ({ cancel: (r?: string) => cancels.push(r ?? 'cancelled') })),
    sink: () => sink,
  });
  return { a, cancels };
}

// ─── exit translation ───────────────────────────────────────────────────────

describe('ArchonExecutorAdapter — exit translation', () => {
  test('a clean exit on a completed run succeeds the target', async () => {
    const sink = new RecordingSink();
    const client = fakeClient({ detail: detail('completed') });
    let onExit!: (e: { type: string }) => void;
    const { a } = adapter(client, sink, async () => ({ cancel: () => {} }));

    // Drive the callbacks the launcher would have been handed.
    await a.spawnRun(ctx());
    // Re-launch capturing the callbacks this time.
    const a2 = new ArchonExecutorAdapter({
      cfg: makeServiceConfig(),
      client: client as never,
      launch: async (args) => {
        onExit = args.callbacks.onExit;
        args.callbacks.onRunId('9136a16135d082cb9f0ac75523b3b56e');
        return { cancel: () => {} };
      },
      sink: () => sink,
    });
    await a2.spawnRun(ctx());
    sink.calls = [];
    onExit({ type: 'archon_succeeded' });
    await Bun.sleep(5);

    expect(sink.kinds()).toEqual(['runSucceeded']);
  });

  test('a clean exit on a PAUSED run opens a gate instead of succeeding', async () => {
    // This is the trap: Archon exits 0 when a workflow pauses at a gate. Believing
    // the exit code would mark a target succeeded halfway through its workflow.
    const sink = new RecordingSink();
    const client = fakeClient({ detail: detail('paused', 'Approve the plan?') });
    let onExit!: (e: { type: string }) => void;
    const a = new ArchonExecutorAdapter({
      cfg: makeServiceConfig(),
      client: client as never,
      launch: async (args) => {
        onExit = args.callbacks.onExit;
        args.callbacks.onRunId('run-1');
        return { cancel: () => {} };
      },
      sink: () => sink,
    });
    await a.spawnRun(ctx());
    sink.calls = [];

    onExit({ type: 'archon_succeeded' });
    await Bun.sleep(5);

    expect(sink.kinds()).not.toContain('runSucceeded');
    expect(sink.calls.find((c) => c[0] === 'gateOpened')).toEqual([
      'gateOpened',
      'tg-1',
      'run-1',
      'Approve the plan?',
    ]);
  });

  test('a clean exit with no run id at all is a failure, not a success', async () => {
    const sink = new RecordingSink();
    let onExit!: (e: { type: string }) => void;
    const a = new ArchonExecutorAdapter({
      cfg: makeServiceConfig(),
      client: fakeClient() as never,
      launch: async (args) => {
        onExit = args.callbacks.onExit;
        return { cancel: () => {} };
      },
      sink: () => sink,
    });
    await a.spawnRun(ctx());

    onExit({ type: 'archon_succeeded' });
    await Bun.sleep(5);

    const failed = sink.calls.find((c) => c[0] === 'runFailed');
    expect(failed).toBeTruthy();
    expect(String(failed![2])).toMatch(/without starting a workflow/);
  });

  test('a clean exit on a run Archon says failed is reported as failed', async () => {
    const sink = new RecordingSink();
    let onExit!: (e: { type: string }) => void;
    const a = new ArchonExecutorAdapter({
      cfg: makeServiceConfig(),
      client: fakeClient({ detail: detail('failed') }) as never,
      launch: async (args) => {
        onExit = args.callbacks.onExit;
        args.callbacks.onRunId('run-1');
        return { cancel: () => {} };
      },
      sink: () => sink,
    });
    await a.spawnRun(ctx());
    sink.calls = [];

    onExit({ type: 'archon_succeeded' });
    await Bun.sleep(5);
    expect(sink.kinds()).toContain('runFailed');
  });

  test('an unverifiable clean exit decides nothing and leaves it to the reconciler', async () => {
    // `succeeded` is terminal: guessing it here would close the tracker issue,
    // leave a possibly-still-paused Archon run holding its worktree, and leave the
    // operator with no button — the reconciler cannot correct a terminal status.
    const sink = new RecordingSink();
    let onExit!: (e: { type: string }) => void;
    const a = new ArchonExecutorAdapter({
      cfg: makeServiceConfig(),
      client: fakeClient({ detailError: 'connection refused' }) as never,
      launch: async (args) => {
        onExit = args.callbacks.onExit;
        args.callbacks.onRunId('run-1');
        return { cancel: () => {} };
      },
      sink: () => sink,
    });
    await a.spawnRun(ctx());
    sink.calls = [];

    onExit({ type: 'archon_succeeded' });
    await Bun.sleep(5);

    expect(sink.kinds()).toEqual([]);
  });

  test('a clean exit on a run that is still going decides nothing either', async () => {
    // The process is gone but Archon says the run is not finished. Same reasoning:
    // stay in the recoverable direction.
    for (const st of ['running', 'pending'] as const) {
      const sink = new RecordingSink();
      let onExit!: (e: { type: string }) => void;
      const a = new ArchonExecutorAdapter({
        cfg: makeServiceConfig(),
        client: fakeClient({ detail: detail(st) }) as never,
        launch: async (args) => {
          onExit = args.callbacks.onExit;
          args.callbacks.onRunId('run-1');
          return { cancel: () => {} };
        },
        sink: () => sink,
      });
      await a.spawnRun(ctx());
      sink.calls = [];

      onExit({ type: 'archon_succeeded' });
      await Bun.sleep(5);
      expect(sink.kinds()).toEqual([]);
    }
  });

  test('a non-zero exit fails the target with the event name as the reason', async () => {
    const sink = new RecordingSink();
    let onExit!: (e: { type: string }) => void;
    const a = new ArchonExecutorAdapter({
      cfg: makeServiceConfig(),
      client: fakeClient() as never,
      launch: async (args) => {
        onExit = args.callbacks.onExit;
        return { cancel: () => {} };
      },
      sink: () => sink,
    });
    await a.spawnRun(ctx());

    onExit({ type: 'archon_timed_out' });
    await Bun.sleep(5);
    expect(sink.calls.find((c) => c[0] === 'runFailed')?.[2]).toBe('archon_timed_out');
  });

  test('a run id arriving on a log line is recorded immediately', async () => {
    const sink = new RecordingSink();
    const a = new ArchonExecutorAdapter({
      cfg: makeServiceConfig(),
      client: fakeClient() as never,
      launch: async (args) => {
        args.callbacks.onRunId('9136a16135d082cb9f0ac75523b3b56e');
        return { cancel: () => {} };
      },
      sink: () => sink,
    });
    const result = await a.spawnRun(ctx());

    // spawnRun resolves before the id is known, so the target is `running`
    // with a null run_id until the log line lands.
    expect(result.run_id).toBeNull();
    await Bun.sleep(5);
    expect(sink.calls).toContainEqual(['recordRunId', 'tg-1', '9136a16135d082cb9f0ac75523b3b56e']);
  });

  test('a mid-run gate pause opens a gate and records the run id', async () => {
    const sink = new RecordingSink();
    const a = new ArchonExecutorAdapter({
      cfg: makeServiceConfig(),
      client: fakeClient() as never,
      launch: async (args) => {
        args.callbacks.onGatePaused('run-9', 'Approve?');
        return { cancel: () => {} };
      },
      sink: () => sink,
    });
    await a.spawnRun(ctx());
    await Bun.sleep(5);

    expect(sink.calls).toContainEqual(['recordRunId', 'tg-1', 'run-9']);
    expect(sink.calls).toContainEqual(['gateOpened', 'tg-1', 'run-9', 'Approve?']);
  });
});

describe('ArchonExecutorAdapter — cancellation', () => {
  test('killRun cancels the subprocess and the run', async () => {
    const sink = new RecordingSink();
    const client = fakeClient();
    let cancelled = false;
    const a = new ArchonExecutorAdapter({
      cfg: makeServiceConfig(),
      client: client as never,
      launch: async () => ({ cancel: () => { cancelled = true; } }),
      sink: () => sink,
    });
    const c = ctx();
    await a.spawnRun(c);

    await a.killRun('run-1', c);

    expect(cancelled).toBe(true);
    expect(client.cancelled).toEqual(['run-1']);
    expect(a.hasLiveRun('tg-1')).toBe(false);
  });

  test('killRun still cancels in Archon when this process holds no subprocess', async () => {
    // The common case after a restart, or after a gate pause already exited.
    const sink = new RecordingSink();
    const client = fakeClient();
    const { a } = adapter(client, sink);
    await a.killRun('run-7', ctx());
    expect(client.cancelled).toEqual(['run-7']);
  });

  test('an Archon that refuses to cancel does not throw — already gone is not a failure', async () => {
    const sink = new RecordingSink();
    const client = {
      ...fakeClient(),
      async cancelRun(): Promise<void> {
        throw new Error('404 run not found');
      },
    };
    const { a } = adapter(client as never, sink);
    await a.killRun('run-x', ctx());
  });

  test('rejectGate forwards the reason and tolerates a missing run id', async () => {
    const sink = new RecordingSink();
    const client = fakeClient();
    const { a } = adapter(client, sink);

    await a.rejectGate({ approval_id: 'a', run_id: 'run-1', reason: 'wrong shape', ctx: ctx() });
    expect(client.rejected).toEqual([{ id: 'run-1', reason: 'wrong shape' }]);

    await a.rejectGate({ approval_id: null, run_id: null, reason: 'x', ctx: ctx() });
    expect(client.rejected).toHaveLength(1);
  });
});

// ─── run observation ────────────────────────────────────────────────────────

describe('ArchonRunStatusAdapter', () => {
  test('a run Archon has never heard of is unknown, never failed', async () => {
    // The distinction that matters after a restart: `failed` would post a
    // spurious failure comment on the tracker for work that may be fine.
    const s = new ArchonRunStatusAdapter(fakeClient({ detail: null }) as never);
    expect(await s.observeRun('run-1')).toEqual({ status: 'unknown' });
  });

  test('a paused run reports its approval message', async () => {
    const s = new ArchonRunStatusAdapter(fakeClient({ detail: detail('paused', 'ok?') }) as never);
    expect(await s.observeRun('run-1')).toEqual({
      status: 'paused',
      approval: { id: 'run-1', message: 'ok?' },
    });
  });

  test('a paused run with no message still opens a gate, with a placeholder', async () => {
    const s = new ArchonRunStatusAdapter(fakeClient({ detail: detail('paused') }) as never);
    const o = await s.observeRun('run-1');
    expect(o.status).toBe('paused');
    expect(o.approval?.message).toBeTruthy();
  });

  test('terminal statuses map straight through', async () => {
    for (const st of ['completed', 'failed', 'cancelled', 'running', 'pending'] as const) {
      const s = new ArchonRunStatusAdapter(fakeClient({ detail: detail(st) }) as never);
      expect((await s.observeRun('run-1')).status).toBe(st);
    }
  });

  test('an unrecognized status is unknown rather than guessed at', async () => {
    const s = new ArchonRunStatusAdapter(fakeClient({ detail: detail('reticulating') }) as never);
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
    expect(r.archon_workflow).toBe('gaggle/gaggle-supervised');
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
            archon_workflow: 'gaggle/gaggle-fix-issue',
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
            archon_workflow: 'w',
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
            archon_workflow: 'gaggle/does-not-exist',
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
            archon_workflow: 'gaggle/gaggle-supervised',
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
            archon_workflow: 'gaggle/gaggle-fix-issue',
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
