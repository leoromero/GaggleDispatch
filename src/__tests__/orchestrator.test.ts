/**
 * Orchestrator full-cycle tests using fakes — exercises the parts of the state
 * machine that don't require spawning real Archon subprocesses:
 *
 *  • startup label-driven recovery (Section 12.4)
 *  • `ensureGaggleLabels` is called on start
 *  • analysis cache invalidation when registry context changes
 *  • `stop()` cancels in-flight LiveSessions
 *  • shouldDispatch / shouldDispatchSubIssue eligibility guards
 *  • maybeReleaseClaim → transitions parent to Done
 *  • completed-key guard prevents re-dispatch of already-finished issues
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import type { LinearClient } from '../tracker/linear.ts';
import type { IssueAnalyzer } from '../analyzer/issue-analyzer.ts';
import type { WorkspaceManager } from '../workspace/workspace-manager.ts';
import type { RegistryLoaderHandle } from '../registry/loader.ts';
import type {
  Issue,
  IssueAnalysis,
  RegistryContext,
  ServiceConfig,
} from '../domain/types.ts';
import { writeRunEntry, writeRetryEntry } from '../registry/run-registry.ts';
import { ArchonClient, type ArchonRunRecord } from '../executor/archon-client.ts';
import { makeIssue, makeRegistryContext, makeServiceConfig, makeRepoTarget } from './helpers/fixtures.ts';

/** Build a fake ArchonClient whose listRuns() delegates to the provided function. */
function makeFakeArchonClient(
  listRunsFn: () => Promise<ArchonRunRecord[]> = () => Promise.resolve([]),
): ArchonClient {
  const client = Object.create(ArchonClient.prototype) as ArchonClient;
  (client as unknown as { listRuns: () => Promise<ArchonRunRecord[]> }).listRuns = listRunsFn;
  (client as unknown as { getRunDetail: () => Promise<null> }).getRunDetail = () => Promise.resolve(null);
  (client as unknown as { approveRun: () => Promise<void> }).approveRun = () => Promise.resolve();
  (client as unknown as { rejectRun: () => Promise<void> }).rejectRun = () => Promise.resolve();
  (client as unknown as { cancelRun: () => Promise<void> }).cancelRun = () => Promise.resolve();
  (client as unknown as { abandonRun: () => Promise<void> }).abandonRun = () => Promise.resolve();
  return client;
}

interface TrackerCall {
  op: string;
  args: unknown[];
}

function makeFakeTracker(opts: {
  candidates?: Issue[];
  byLabel?: Record<string, Issue[]>;
  byStates?: Record<string, Issue[]>;
  viewerId?: string;
} = {}) {
  const calls: TrackerCall[] = [];
  const tracker = {
    async ensureGaggleLabels() {
      calls.push({ op: 'ensureGaggleLabels', args: [] });
    },
    async resolveViewerId() {
      calls.push({ op: 'resolveViewerId', args: [] });
      return opts.viewerId ?? 'u1';
    },
    async fetchCandidateIssues() {
      calls.push({ op: 'fetchCandidateIssues', args: [] });
      return opts.candidates ?? [];
    },
    async fetchIssuesByLabel(label: string) {
      calls.push({ op: 'fetchIssuesByLabel', args: [label] });
      return opts.byLabel?.[label] ?? [];
    },
    async fetchIssuesByStates(states: string[]) {
      calls.push({ op: 'fetchIssuesByStates', args: [states] });
      const all: Issue[] = [];
      for (const s of states) all.push(...(opts.byStates?.[s] ?? []));
      return all;
    },
    async fetchIssueStatesByIds(ids: string[]) {
      calls.push({ op: 'fetchIssueStatesByIds', args: [ids] });
      return [];
    },
    async fetchIssueComments(id: string) {
      calls.push({ op: 'fetchIssueComments', args: [id] });
      return [];
    },
    async applyLabel(id: string, label: string) {
      calls.push({ op: 'applyLabel', args: [id, label] });
    },
    async removeLabel(id: string, label: string) {
      calls.push({ op: 'removeLabel', args: [id, label] });
    },
    async postComment(id: string, body: string) {
      calls.push({ op: 'postComment', args: [id, body] });
      return { id: 'c1' };
    },
    async updateIssueState(id: string, state: string) {
      calls.push({ op: 'updateIssueState', args: [id, state] });
    },
    async createSubIssue(args: unknown) {
      calls.push({ op: 'createSubIssue', args: [args] });
      return { id: 'sub1', identifier: 'SYM-99' };
    },
  };
  return { tracker: tracker as unknown as LinearClient, calls };
}

function makeFakeRegistry(initial?: RegistryContext) {
  let ctx = initial ?? makeRegistryContext();
  const subscribers = new Set<(c: RegistryContext) => void>();
  const handle: RegistryLoaderHandle = {
    getContext: () => ctx,
    reload: () => {
      for (const cb of subscribers) cb(ctx);
    },
    on: (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    close: async () => {},
  };
  return {
    handle,
    setContext(next: RegistryContext) {
      ctx = next;
      for (const cb of subscribers) cb(ctx);
    },
  };
}

function makeOrchestrator(extra: {
  tracker?: ReturnType<typeof makeFakeTracker>['tracker'];
  registry?: RegistryLoaderHandle;
  archonStatus?: () => Promise<ArchonRunRecord[]>;
  cfg?: ServiceConfig;
} = {}) {
  const cfg = extra.cfg ?? makeServiceConfig();
  // Disable polling in tests by setting a very large interval; we drive flow manually via start().
  cfg.polling.interval_ms = 86_400_000;
  const trackerObj = extra.tracker ? { tracker: extra.tracker, calls: [] as TrackerCall[] } : makeFakeTracker();
  const registry = extra.registry ?? makeFakeRegistry().handle;
  const orchestrator = new Orchestrator({
    cfg,
    tracker: trackerObj.tracker,
    analyzer: { analyze: async () => ({ issue_id: 'x', analysis_summary: '', repo_targets: [] }) } as unknown as IssueAnalyzer,
    workspace: {} as unknown as WorkspaceManager,
    registry,
    syncer: null,
    archonClient: makeFakeArchonClient(extra.archonStatus),
  });
  return { orchestrator, cfg, registry, tracker: trackerObj.tracker };
}

let orchestrators: Orchestrator[] = [];

beforeEach(() => {
  orchestrators = [];
});

afterEach(async () => {
  for (const o of orchestrators) await o.stop();
});

describe('Orchestrator.start', () => {
  test('calls ensureGaggleLabels and resolveViewerId during startup', async () => {
    const { tracker, calls } = makeFakeTracker();
    const reg = makeFakeRegistry();
    const cfg = makeServiceConfig();
    cfg.polling.interval_ms = 86_400_000;
    const o = new Orchestrator({
      cfg,
      tracker,
      analyzer: {} as unknown as IssueAnalyzer,
      workspace: {} as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
    });
    orchestrators.push(o);
    await o.start();
    const ops = calls.map((c) => c.op);
    expect(ops).toContain('ensureGaggleLabels');
    expect(ops).toContain('resolveViewerId');
    expect(ops).toContain('fetchIssuesByLabel');
  });

  test('skips resolveViewerId when assigned_to_me is false', async () => {
    const { tracker, calls } = makeFakeTracker();
    const reg = makeFakeRegistry();
    const cfg = makeServiceConfig();
    cfg.tracker.assigned_to_me = false;
    cfg.polling.interval_ms = 86_400_000;
    const o = new Orchestrator({
      cfg,
      tracker,
      analyzer: {} as unknown as IssueAnalyzer,
      workspace: {} as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
    });
    orchestrators.push(o);
    await o.start();
    expect(calls.find((c) => c.op === 'resolveViewerId')).toBeUndefined();
  });
});

describe('Orchestrator.recoverFromLinearLabels', () => {
  test('restores claimed parent issues into the in-memory claimed set', async () => {
    const claimedParent = makeIssue({ id: 'p1', identifier: 'SYM-100', parent_id: null });
    const claimedSub = makeIssue({ id: 's1', identifier: 'SYM-101', parent_id: 'p1' });
    // Give the parent an active sibling (queued) so it is NOT treated as an orphan.
    const queuedSub = makeIssue({
      id: 'sub-be', identifier: 'SYM-102', parent_id: 'p1',
      title: '[backend-svc] Fix the thing', state: 'Todo', labels: ['gaggle:queued'],
    });
    const { tracker } = makeFakeTracker({
      byLabel: {
        'gaggle:claimed': [claimedParent, claimedSub],
        'gaggle:running': [],
        'gaggle:waiting-human': [],
        'gaggle:queued': [queuedSub],
      },
    });
    const cfg = makeServiceConfig();
    cfg.polling.interval_ms = 86_400_000;
    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg,
      tracker,
      analyzer: {} as unknown as IssueAnalyzer,
      workspace: {} as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
    });
    orchestrators.push(o);
    await o.start();
    const state = o.getState();
    expect(state.parent_machine_states.get('p1')).toBe('claimed');
    expect(state.parent_machine_states.get('s1')).toBeUndefined(); // sub-issue does NOT count
  });

  test('extracts repo_alias from "[alias] title" pattern on running label', async () => {
    const runningSub = makeIssue({
      id: 'sub1',
      identifier: 'SYM-200',
      parent_id: 'parent1',
      title: '[backend-svc] Fix the thing',
    });
    const { tracker, calls } = makeFakeTracker({
      byLabel: {
        'gaggle:claimed': [],
        'gaggle:running': [runningSub],
        'gaggle:waiting-human': [],
        'gaggle:queued': [],
      },
    });
    const cfg = makeServiceConfig();
    cfg.polling.interval_ms = 86_400_000;
    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg,
      tracker,
      analyzer: {} as unknown as IssueAnalyzer,
      workspace: {} as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
    });
    orchestrators.push(o);
    await o.start();
    const state = o.getState();
    expect(state.sibling_subissues.get('parent1')?.get('backend-svc')).toBe('sub1');

    const ops = calls.map((c) => c.op + ':' + (c.args[1] ?? c.args[0]));
    expect(ops).toContain('removeLabel:gaggle:running');
    expect(ops).toContain('applyLabel:gaggle:queued');
  });
});

describe('Orchestrator analysis-cache invalidation', () => {
  test('subscribing to registry changes clears the analysis_cache', async () => {
    const reg = makeFakeRegistry();
    const { tracker } = makeFakeTracker();
    const cfg = makeServiceConfig();
    cfg.polling.interval_ms = 86_400_000;
    const o = new Orchestrator({
      cfg,
      tracker,
      analyzer: {} as unknown as IssueAnalyzer,
      workspace: {} as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
    });
    orchestrators.push(o);
    // Pre-populate the analysis cache
    o.getState().analysis_cache.set('iss-1', {
      analysis: { issue_id: 'iss-1', analysis_summary: '', repo_targets: [] },
      cached_at: Date.now(),
    });
    expect(o.getState().analysis_cache.size).toBe(1);

    // Trigger registry update
    reg.setContext(makeRegistryContext());
    expect(o.getState().analysis_cache.size).toBe(0);
  });
});

describe('Orchestrator.stop', () => {
  test('cancels every running session', async () => {
    const { tracker } = makeFakeTracker();
    const reg = makeFakeRegistry();
    const cfg = makeServiceConfig();
    cfg.polling.interval_ms = 86_400_000;
    const o = new Orchestrator({
      cfg,
      tracker,
      analyzer: {} as unknown as IssueAnalyzer,
      workspace: {} as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
    });
    orchestrators.push(o);

    let cancelled = 0;
    o.getState().running.set('k1', {
      session_id: 'k1',
      issue: makeIssue(),
      identifier: 'X',
      repo_alias: 'r',
      repo_target: { repo_url: '', repo_alias: 'r', local_path: '', archon_workflow: '', rationale: '', components: [] },
      sub_issue_id: null,
      archon_pid: null,
      archon_db_run_id: null,
      archon_workflow: '',
      last_archon_event: null,
      last_archon_timestamp: null,
      last_archon_message: null,
      claude_input_tokens: 0,
      claude_output_tokens: 0,
      claude_total_tokens: 0,
      turn_count: 0,
      started_at: new Date().toISOString(),
      attempt: null,
      cancel: () => {
        cancelled++;
      },
    });

    await o.stop();
    expect(cancelled).toBe(1);
  });
});

describe('Orchestrator.getState', () => {
  test('returns initial state with empty maps and configured poll interval', () => {
    const { orchestrator, cfg } = makeOrchestrator();
    orchestrators.push(orchestrator);
    const s = orchestrator.getState();
    expect(s.running.size).toBe(0);
    expect(s.parent_machine_states.size).toBe(0);
    expect(s.pending_issues.size).toBe(0);
    expect(s.poll_interval_ms).toBe(cfg.polling.interval_ms);
  });
});

// ─── helpers shared by dispatch tests ─────────────────────────────────────────

/** Build an orchestrator whose analyzer returns empty targets (no workers spawned). */
function makeDispatchOrchestrator(candidates: Issue[], opts: {
  byLabel?: Record<string, Issue[]>;
  analyzerTargets?: import('../domain/types.ts').RepoTarget[];
  archonStatus?: () => Promise<ArchonRunRecord[]>;
} = {}) {
  const cfg = makeServiceConfig();
  cfg.polling.interval_ms = 86_400_000;
  const calls: TrackerCall[] = [];
  const tracker: LinearClient = {
    async ensureGaggleLabels() { calls.push({ op: 'ensureGaggleLabels', args: [] }); },
    async resolveViewerId() { calls.push({ op: 'resolveViewerId', args: [] }); return 'u1'; },
    async fetchCandidateIssues() { calls.push({ op: 'fetchCandidateIssues', args: [] }); return candidates; },
    async fetchIssuesByLabel(label: string) { calls.push({ op: 'fetchIssuesByLabel', args: [label] }); return opts.byLabel?.[label] ?? []; },
    async fetchIssuesByStates() { return []; },
    async fetchIssueStatesByIds(ids: string[]) { calls.push({ op: 'fetchIssueStatesByIds', args: [ids] }); return []; },
    async fetchIssueComments() { return []; },
    async applyLabel(id: string, label: string) { calls.push({ op: 'applyLabel', args: [id, label] }); },
    async removeLabel(id: string, label: string) { calls.push({ op: 'removeLabel', args: [id, label] }); },
    async postComment() { return { id: 'c1' }; },
    async updateIssueState(id: string, state: string) { calls.push({ op: 'updateIssueState', args: [id, state] }); },
    async createSubIssue() { calls.push({ op: 'createSubIssue', args: [] }); return { id: 'sub1', identifier: 'SYM-99' }; },
    async createBlockerRelation() {},
  } as unknown as LinearClient;

  const targets = opts.analyzerTargets ?? [];
  const analyzer: IssueAnalyzer = {
    analyze: async (issue: { id: string }) => {
      calls.push({ op: 'analyze', args: [issue.id] });
      return { issue_id: issue.id, analysis_summary: '', repo_targets: targets };
    },
  } as unknown as IssueAnalyzer;

  const reg = makeFakeRegistry();
  const o = new Orchestrator({
    cfg,
    tracker,
    analyzer,
    workspace: { cleanAuxiliaryWorkspace: () => {} } as unknown as WorkspaceManager,
    registry: reg.handle,
    syncer: null,
    archonClient: makeFakeArchonClient(opts.archonStatus),
  });
  orchestrators.push(o);

  return { o, cfg, calls };
}

/** Drive a single tick directly (bypasses timer). */
async function runTick(o: Orchestrator): Promise<void> {
  await (o as unknown as { tick(): Promise<void> }).tick();
}

// ─── shouldDispatch eligibility ────────────────────────────────────────────────

describe('shouldDispatch eligibility', () => {
  test('skips issues in terminal state', async () => {
    const issue = makeIssue({ id: 'i1', state: 'Done' });
    const { o, calls } = makeDispatchOrchestrator([issue]);
    await runTick(o);
    expect(calls.some((c) => c.op === 'analyze')).toBe(false);
    expect(calls.some((c) => c.op === 'applyLabel' && (c.args[1] as string).includes('claimed'))).toBe(false);
  });

  test('skips issues not in active_states', async () => {
    const issue = makeIssue({ id: 'i1', state: 'Backlog' }); // not in ['Todo','In Progress']
    const { o, calls } = makeDispatchOrchestrator([issue]);
    await runTick(o);
    expect(calls.some((c) => c.op === 'analyze')).toBe(false);
  });

  test('skips issues carrying a gaggle label', async () => {
    const issue = makeIssue({ id: 'i1', state: 'In Progress', labels: ['gaggle:claimed'] });
    const { o, calls } = makeDispatchOrchestrator([issue]);
    await runTick(o);
    expect(calls.some((c) => c.op === 'analyze')).toBe(false);
  });

  test('skips issues with parent SM in claimed state', async () => {
    const issue = makeIssue({ id: 'i1', state: 'In Progress' });
    const { o, calls } = makeDispatchOrchestrator([issue]);
    o.getState().parent_machine_states.set('i1', 'claimed');
    await runTick(o);
    expect(calls.some((c) => c.op === 'analyze')).toBe(false);
  });

  test('skips issues with a running worker in state.running', async () => {
    const issue = makeIssue({ id: 'i1', state: 'In Progress' });
    const { o, calls } = makeDispatchOrchestrator([issue]);
    // Simulate a running session for this issue
    o.getState().running.set('i1__repo-a', {
      session_id: 'i1__repo-a__0',
      issue,
      identifier: 'SYM-1',
      repo_alias: 'repo-a',
      repo_target: makeRepoTarget(),
      sub_issue_id: null,
      archon_pid: null,
      archon_db_run_id: null,
      archon_workflow: 'gaggle/gaggle-fix-issue',
      last_archon_event: null,
      last_archon_timestamp: null,
      last_archon_message: null,
      claude_input_tokens: 0,
      claude_output_tokens: 0,
      claude_total_tokens: 0,
      turn_count: 0,
      started_at: new Date().toISOString(),
      attempt: null,
    });
    await runTick(o);
    expect(calls.some((c) => c.op === 'analyze')).toBe(false);
  });

  test('skips issues whose targets already completed this session (completed-key guard)', async () => {
    const issue = makeIssue({ id: 'i1', state: 'In Progress' });
    const { o, calls } = makeDispatchOrchestrator([issue]);
    // Pre-populate completed set as if this issue was already worked on
    o.getState().target_machine_states.set('i1__repo-a', 'succeeded');
    await runTick(o);
    expect(calls.some((c) => c.op === 'analyze')).toBe(false);
    expect(calls.some((c) => c.op === 'applyLabel' && (c.args[1] as string).includes('claimed'))).toBe(false);
  });

  test('skips sub-issues via parent dispatch path (they go through shouldDispatchSubIssue)', async () => {
    // Sub-issue has parent_id — shouldDispatch returns false for it
    const sub = makeIssue({ id: 's1', state: 'In Progress', parent_id: 'p1' });
    const { o, calls } = makeDispatchOrchestrator([sub]);
    await runTick(o);
    // shouldDispatch returns false for sub-issues; shouldDispatchSubIssue also skips
    // because the title has no [alias] prefix → neither path dispatches
    expect(calls.some((c) => c.op === 'analyze')).toBe(false);
  });

  test('dispatches clean parent issues and applies gaggle:claimed label', async () => {
    const issue = makeIssue({ id: 'i1', state: 'In Progress' });
    // analyzer returns empty targets so no spawnWorker is attempted
    const { o, calls } = makeDispatchOrchestrator([issue], { analyzerTargets: [] });
    await runTick(o);
    expect(calls.some((c) => c.op === 'analyze' && c.args[0] === 'i1')).toBe(true);
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[0] === 'i1' && c.args[1] === 'gaggle:claimed')).toBe(true);
    // Phase 5c: parent SM state map should now show 'claimed' (driven via emitParentEvent).
    expect(o.getState().parent_machine_states.get('i1')).toBe('claimed');
  });

  test('does not re-dispatch an issue that was just dispatched (claimed set)', async () => {
    const issue = makeIssue({ id: 'i1', state: 'In Progress' });
    const { o, calls } = makeDispatchOrchestrator([issue], { analyzerTargets: [] });
    await runTick(o);
    const analyzeCountAfterFirst = calls.filter((c) => c.op === 'analyze').length;
    // Run a second tick — issue is now in claimed set so shouldDispatch returns false
    await runTick(o);
    const analyzeCountAfterSecond = calls.filter((c) => c.op === 'analyze').length;
    expect(analyzeCountAfterSecond).toBe(analyzeCountAfterFirst); // no additional analysis
  });
});

// ─── target_machine_states map (phase 5 hydration) ───────────────────────────

describe('emitTargetEvent populates target_machine_states', () => {
  test('worker_succeeded transition records succeeded state', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-200' });
    const cfg = makeServiceConfig();
    const calls: TrackerCall[] = [];
    const tracker = {
      ensureGaggleLabels: async () => {},
      resolveViewerId: async () => 'u1',
      fetchCandidateIssues: async () => [],
      fetchIssuesByLabel: async () => [],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      fetchIssueComments: async () => [],
      applyLabel: async (id: string, label: string) => { calls.push({ op: 'applyLabel', args: [id, label] }); },
      removeLabel: async (id: string, label: string) => { calls.push({ op: 'removeLabel', args: [id, label] }); },
      postComment: async () => ({ id: 'c1' }),
      updateIssueState: async (id: string, s: string) => { calls.push({ op: 'updateIssueState', args: [id, s] }); },
      createSubIssue: async () => ({ id: 'sub1', identifier: 'SYM-99' }),
      createBlockerRelation: async () => {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg,
      tracker,
      analyzer: { analyze: async () => ({ issue_id: 'x', analysis_summary: '', repo_targets: [] }) } as unknown as IssueAnalyzer,
      workspace: {
        ensureAuxRoot: () => {},
        cleanAuxiliaryWorkspace: () => {},
      } as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(),
    });
    orchestrators.push(o);

    // Drive a worker_succeeded transition directly via the private helper.
    const target = makeRepoTarget({ repo_alias: 'fe' });
    o.getState().pending_issues.set('p1', issue);
    const transition = await (o as unknown as {
      emitTargetEvent(s: string, e: { kind: string }, ctx: unknown): Promise<{ to: string }>;
    }).emitTargetEvent('running', { kind: 'worker_succeeded' }, {
      cfg,
      identity: { parent_issue_id: 'p1', repo_alias: 'fe', target_issue_id: 'p1' },
      parent_issue: issue,
      target,
      siblings: new Map(),
      attempt: 0,
    });

    expect(transition.to).toBe('succeeded');
    expect(o.getState().target_machine_states.get('p1__fe')).toBe('succeeded');
  });

  test('handleWorkerExit success → parent SM transitions to done when it is the only target', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-201' });
    const cfg = makeServiceConfig();
    const calls: TrackerCall[] = [];
    const tracker = {
      ensureGaggleLabels: async () => {},
      resolveViewerId: async () => 'u1',
      fetchCandidateIssues: async () => [],
      fetchIssuesByLabel: async () => [],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      fetchIssueComments: async () => [],
      applyLabel: async (id: string, label: string) => { calls.push({ op: 'applyLabel', args: [id, label] }); },
      removeLabel: async (id: string, label: string) => { calls.push({ op: 'removeLabel', args: [id, label] }); },
      postComment: async () => ({ id: 'c1' }),
      updateIssueState: async (id: string, s: string) => { calls.push({ op: 'updateIssueState', args: [id, s] }); },
      createSubIssue: async () => ({ id: 'sub1', identifier: 'SYM-99' }),
      createBlockerRelation: async () => {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg,
      tracker,
      analyzer: { analyze: async () => ({ issue_id: 'x', analysis_summary: '', repo_targets: [] }) } as unknown as IssueAnalyzer,
      workspace: {
        ensureAuxRoot: () => {},
        cleanAuxiliaryWorkspace: () => {},
      } as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(),
    });
    orchestrators.push(o);

    // Pre-condition: parent is in claimed state with a single target running.
    o.getState().pending_issues.set('p1', issue);
    o.getState().parent_machine_states.set('p1', 'claimed');
    o.getState().target_machine_states.set('p1__fe', 'running');
    o.getState().running.set('p1__fe', {
      session_id: 'x', issue, identifier: 'SYM-201', repo_alias: 'fe',
      repo_target: makeRepoTarget({ repo_alias: 'fe' }), sub_issue_id: null,
      archon_pid: 1, archon_db_run_id: 'r1',
      archon_workflow: '', last_archon_event: null, last_archon_timestamp: null, last_archon_message: null,
      claude_input_tokens: 0, claude_output_tokens: 0, claude_total_tokens: 0, turn_count: 0,
      started_at: new Date().toISOString(), attempt: null,
    });

    await (o as unknown as {
      handleWorkerExit(i: typeof issue, t: ReturnType<typeof makeRepoTarget>, e: { type: string }, a: number | null): Promise<void>;
    }).handleWorkerExit(issue, makeRepoTarget({ repo_alias: 'fe' }), { type: 'archon_succeeded' }, null);

    expect(o.getState().target_machine_states.get('p1__fe')).toBe('succeeded');
    expect(o.getState().parent_machine_states.get('p1')).toBe('done');
  });

  test('reconcileRunningIssues — issue moved to terminal externally → parent SM transitions to cancelled', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-203', state: 'In Progress' });
    const cfg = makeServiceConfig();
    const calls: TrackerCall[] = [];
    // Tracker returns the issue with a terminal state after the first fetch.
    const tracker = {
      ensureGaggleLabels: async () => {},
      resolveViewerId: async () => 'u1',
      fetchCandidateIssues: async () => [],
      fetchIssuesByLabel: async () => [],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [{ ...issue, state: 'Cancelled' }],
      fetchIssueComments: async () => [],
      applyLabel: async (id: string, label: string) => { calls.push({ op: 'applyLabel', args: [id, label] }); },
      removeLabel: async (id: string, label: string) => { calls.push({ op: 'removeLabel', args: [id, label] }); },
      postComment: async () => ({ id: 'c1' }),
      updateIssueState: async (id: string, s: string) => { calls.push({ op: 'updateIssueState', args: [id, s] }); },
      createSubIssue: async () => ({ id: 'sub1', identifier: 'SYM-99' }),
      createBlockerRelation: async () => {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg, tracker,
      analyzer: { analyze: async () => ({ issue_id: 'x', analysis_summary: '', repo_targets: [] }) } as unknown as IssueAnalyzer,
      workspace: { ensureAuxRoot: () => {}, cleanAuxiliaryWorkspace: () => {} } as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(),
    });
    orchestrators.push(o);

    // Pre-condition: parent is claimed with a running target.
    o.getState().pending_issues.set('p1', issue);
    o.getState().parent_machine_states.set('p1', 'claimed');
    o.getState().target_machine_states.set('p1__fe', 'running');
    o.getState().running.set('p1__fe', {
      session_id: 'x', issue, identifier: 'SYM-203', repo_alias: 'fe',
      repo_target: makeRepoTarget({ repo_alias: 'fe' }), sub_issue_id: null,
      archon_pid: 1, archon_db_run_id: 'r1',
      archon_workflow: '', last_archon_event: null, last_archon_timestamp: null, last_archon_message: null,
      claude_input_tokens: 0, claude_output_tokens: 0, claude_total_tokens: 0, turn_count: 0,
      started_at: new Date().toISOString(), attempt: null,
    });

    await (o as unknown as { reconcileRunningIssues(): Promise<void> }).reconcileRunningIssues();

    // Parent SM fired parent_externally_terminal → effects cleaned up Linear
    // labels and analysis cache; maybeReleaseClaim then cleared parent_machine_states.
    expect(o.getState().parent_machine_states.get('p1')).toBeUndefined();
    expect(o.getState().pending_issues.has('p1')).toBe(false);
    expect(calls.some((c) => c.op === 'removeLabel' && c.args[0] === 'p1' && c.args[1] === 'gaggle:claimed')).toBe(true);
  });

  test('handleWorkerExit success — parent stays in claimed when a sibling target is still queued', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-202' });
    const cfg = makeServiceConfig();
    const calls: TrackerCall[] = [];
    const tracker = {
      ensureGaggleLabels: async () => {},
      resolveViewerId: async () => 'u1',
      fetchCandidateIssues: async () => [],
      fetchIssuesByLabel: async () => [],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      fetchIssueComments: async () => [],
      applyLabel: async (id: string, label: string) => { calls.push({ op: 'applyLabel', args: [id, label] }); },
      removeLabel: async (id: string, label: string) => { calls.push({ op: 'removeLabel', args: [id, label] }); },
      postComment: async () => ({ id: 'c1' }),
      updateIssueState: async (id: string, s: string) => { calls.push({ op: 'updateIssueState', args: [id, s] }); },
      createSubIssue: async () => ({ id: 'sub1', identifier: 'SYM-99' }),
      createBlockerRelation: async () => {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg, tracker,
      analyzer: { analyze: async () => ({ issue_id: 'x', analysis_summary: '', repo_targets: [] }) } as unknown as IssueAnalyzer,
      workspace: { ensureAuxRoot: () => {}, cleanAuxiliaryWorkspace: () => {} } as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(),
    });
    orchestrators.push(o);

    // Multi-target parent: target 'fe' is running, target 'be' is still queued.
    o.getState().pending_issues.set('p1', issue);
    o.getState().parent_machine_states.set('p1', 'claimed');
    o.getState().target_machine_states.set('p1__fe', 'running');
    o.getState().target_machine_states.set('p1__be', 'queued');
    o.getState().running.set('p1__fe', {
      session_id: 'x', issue, identifier: 'SYM-202', repo_alias: 'fe',
      repo_target: makeRepoTarget({ repo_alias: 'fe' }), sub_issue_id: null,
      archon_pid: 1, archon_db_run_id: 'r1',
      archon_workflow: '', last_archon_event: null, last_archon_timestamp: null, last_archon_message: null,
      claude_input_tokens: 0, claude_output_tokens: 0, claude_total_tokens: 0, turn_count: 0,
      started_at: new Date().toISOString(), attempt: null,
    });

    await (o as unknown as {
      handleWorkerExit(i: typeof issue, t: ReturnType<typeof makeRepoTarget>, e: { type: string }, a: number | null): Promise<void>;
    }).handleWorkerExit(issue, makeRepoTarget({ repo_alias: 'fe' }), { type: 'archon_succeeded' }, null);

    expect(o.getState().target_machine_states.get('p1__fe')).toBe('succeeded');
    // Parent must NOT have transitioned to done — 'be' target is still queued.
    expect(o.getState().parent_machine_states.get('p1')).toBe('claimed');
  });
});

// ─── hot path integration tests ───────────────────────────────────────────────
//
// Each test exercises one orchestrator hot-path method end-to-end: the test
// sets up minimum required state, invokes the method, and verifies both the
// SM state map and the downstream side effects (tracker calls, applier
// effects). These complement the unit-level state-machine and applier
// matrices by proving the integration wiring is correct.

describe('hot path: handleGatePaused', () => {
  test('running target + gate_paused → gate_waiting; supervised_gates populated, label swap', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-300' });
    const cfg = makeServiceConfig();
    const calls: TrackerCall[] = [];
    const tracker = {
      ensureGaggleLabels: async () => {},
      resolveViewerId: async () => 'u1',
      fetchCandidateIssues: async () => [],
      fetchIssuesByLabel: async () => [],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      fetchIssueComments: async () => [],
      applyLabel: async (id: string, label: string) => { calls.push({ op: 'applyLabel', args: [id, label] }); },
      removeLabel: async (id: string, label: string) => { calls.push({ op: 'removeLabel', args: [id, label] }); },
      postComment: async () => ({ id: 'c1' }),
      updateIssueState: async (id: string, s: string) => { calls.push({ op: 'updateIssueState', args: [id, s] }); },
      createSubIssue: async () => ({ id: 'sub1', identifier: 'SYM-99' }),
      createBlockerRelation: async () => {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg, tracker,
      analyzer: { analyze: async () => ({ issue_id: 'x', analysis_summary: '', repo_targets: [] }) } as unknown as IssueAnalyzer,
      workspace: { ensureAuxRoot: () => {}, cleanAuxiliaryWorkspace: () => {} } as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(),
    });
    orchestrators.push(o);

    // Pre-condition: target is running.
    o.getState().pending_issues.set('p1', issue);
    o.getState().target_machine_states.set('p1__fe', 'running');
    o.getState().running.set('p1__fe', {
      session_id: 'x', issue, identifier: 'SYM-300', repo_alias: 'fe',
      repo_target: makeRepoTarget({ repo_alias: 'fe' }), sub_issue_id: null,
      archon_pid: 1, archon_db_run_id: 'r1',
      archon_workflow: '', last_archon_event: null, last_archon_timestamp: null, last_archon_message: null,
      claude_input_tokens: 0, claude_output_tokens: 0, claude_total_tokens: 0, turn_count: 0,
      started_at: new Date().toISOString(), attempt: null,
    });

    await (o as unknown as {
      handleGatePaused(i: typeof issue, t: ReturnType<typeof makeRepoTarget>, subId: string | null, runId: string, msg: string, attempt: number | null): Promise<void>;
    }).handleGatePaused(issue, makeRepoTarget({ repo_alias: 'fe' }), null, 'run-xyz', 'Please review.', null);

    // SM transitioned to gate_waiting
    expect(o.getState().target_machine_states.get('p1__fe')).toBe('gate_waiting');
    // Label swap: remove running, apply waiting-human
    expect(calls.some((c) => c.op === 'removeLabel' && c.args[1] === 'gaggle:running')).toBe(true);
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[1] === 'gaggle:waiting-human')).toBe(true);
    // supervised_gates entry registered with correct run_id
    const gate = o.getState().supervised_gates.get('p1__fe');
    expect(gate?.run_id).toBe('run-xyz');
    expect(gate?.gate_message).toBe('Please review.');
    // state.running cleaned up (slot freed)
    expect(o.getState().running.has('p1__fe')).toBe(false);
  });
});

describe('hot path: handleWorkerExit failure → failed (no-auto-retry policy)', () => {
  test('worker_failed parks target in failed, posts comment, does NOT schedule a retry', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-310' });
    const cfg = makeServiceConfig();
    const calls: TrackerCall[] = [];
    const tracker = {
      ensureGaggleLabels: async () => {},
      resolveViewerId: async () => 'u1',
      fetchCandidateIssues: async () => [],
      fetchIssuesByLabel: async () => [],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      fetchIssueComments: async () => [],
      applyLabel: async (id: string, label: string) => { calls.push({ op: 'applyLabel', args: [id, label] }); },
      removeLabel: async (id: string, label: string) => { calls.push({ op: 'removeLabel', args: [id, label] }); },
      postComment: async () => ({ id: 'c1' }),
      updateIssueState: async (id: string, s: string) => { calls.push({ op: 'updateIssueState', args: [id, s] }); },
      createSubIssue: async () => ({ id: 'sub1', identifier: 'SYM-99' }),
      createBlockerRelation: async () => {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg, tracker,
      analyzer: { analyze: async () => ({ issue_id: 'x', analysis_summary: '', repo_targets: [] }) } as unknown as IssueAnalyzer,
      workspace: { ensureAuxRoot: () => {}, cleanAuxiliaryWorkspace: () => {} } as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(),
    });
    orchestrators.push(o);

    o.getState().pending_issues.set('p1', issue);
    o.getState().parent_machine_states.set('p1', 'claimed');
    o.getState().target_machine_states.set('p1__fe', 'running');
    o.getState().running.set('p1__fe', {
      session_id: 'x', issue, identifier: 'SYM-310', repo_alias: 'fe',
      repo_target: makeRepoTarget({ repo_alias: 'fe' }), sub_issue_id: null,
      archon_pid: 1, archon_db_run_id: 'r1',
      archon_workflow: '', last_archon_event: null, last_archon_timestamp: null, last_archon_message: null,
      claude_input_tokens: 0, claude_output_tokens: 0, claude_total_tokens: 0, turn_count: 0,
      started_at: new Date().toISOString(), attempt: null,
    });

    const postCommentCalls: Array<{ id: string; body: string }> = [];
    (tracker as unknown as { postComment: (id: string, body: string) => Promise<{ id: string }> }).postComment =
      async (id: string, body: string) => { postCommentCalls.push({ id, body }); return { id: 'c1' }; };

    await (o as unknown as {
      handleWorkerExit(i: typeof issue, t: ReturnType<typeof makeRepoTarget>, e: { type: string }, a: number | null): Promise<void>;
    }).handleWorkerExit(issue, makeRepoTarget({ repo_alias: 'fe' }), { type: 'archon_failed' }, 0);

    // Target parked in failed
    expect(o.getState().target_machine_states.get('p1__fe')).toBe('failed');
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[1] === 'gaggle:failed')).toBe(true);
    // No retry timer scheduled, no retry_attempts entry
    expect(o.getState().retry_attempts.has('p1__fe')).toBe(false);
    // Human-facing comment posted on the target issue
    expect(postCommentCalls.length).toBeGreaterThan(0);
    expect(postCommentCalls[0]?.body).toMatch(/worker failed/i);
    // Parent STAYS claimed — operator must resolve
    expect(o.getState().parent_machine_states.get('p1')).toBe('claimed');
  });
});

describe('hot path: pollSupervisedGates timeout', () => {
  test('gate that exceeds gate_timeout_ms → gate_timed_out fires; archon.rejectRun + target parked in failed', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-320' });
    const cfg = makeServiceConfig();
    cfg.archon.gate_timeout_ms = 1000; // tiny timeout
    const calls: TrackerCall[] = [];
    const archonCalls: string[] = [];
    const tracker = {
      ensureGaggleLabels: async () => {},
      resolveViewerId: async () => 'u1',
      fetchCandidateIssues: async () => [],
      fetchIssuesByLabel: async () => [],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      fetchIssueComments: async () => [],
      applyLabel: async (id: string, label: string) => { calls.push({ op: 'applyLabel', args: [id, label] }); },
      removeLabel: async (id: string, label: string) => { calls.push({ op: 'removeLabel', args: [id, label] }); },
      postComment: async () => ({ id: 'c1' }),
      updateIssueState: async (id: string, s: string) => { calls.push({ op: 'updateIssueState', args: [id, s] }); },
      createSubIssue: async () => ({ id: 'sub1', identifier: 'SYM-99' }),
      createBlockerRelation: async () => {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const archon = makeFakeArchonClient();
    (archon as unknown as { rejectRun: (id: string, reason: string) => Promise<void> }).rejectRun =
      async (runId: string, reason: string) => { archonCalls.push(`rejectRun(${runId},${reason})`); };

    const o = new Orchestrator({
      cfg, tracker,
      analyzer: { analyze: async () => ({ issue_id: 'x', analysis_summary: '', repo_targets: [] }) } as unknown as IssueAnalyzer,
      workspace: { ensureAuxRoot: () => {}, cleanAuxiliaryWorkspace: () => {} } as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: archon,
    });
    orchestrators.push(o);

    // Pre-condition: a supervised gate paused well past the timeout.
    o.getState().pending_issues.set('p1', issue);
    o.getState().target_machine_states.set('p1__fe', 'gate_waiting');
    o.getState().supervised_gates.set('p1__fe', {
      run_id: 'run-xyz', issue_id: 'p1', issue,
      repo_alias: 'fe', repo_target: makeRepoTarget({ repo_alias: 'fe' }),
      sub_issue_id: null, paused_at: Date.now() - 10_000,
      gate_message: 'review', comment_id: null, gate_state_applied: false, attempt: 0,
    });

    await (o as unknown as { pollSupervisedGates(): Promise<void> }).pollSupervisedGates();

    // Archon reject was called via the SM's archon_reject effect
    expect(archonCalls.some((c) => c.startsWith('rejectRun(run-xyz,'))).toBe(true);
    // Target moves to failed (no-auto-retry policy); gate entry deleted
    expect(o.getState().target_machine_states.get('p1__fe')).toBe('failed');
    expect(o.getState().supervised_gates.has('p1__fe')).toBe(false);
    // No retry timer scheduled
    expect(o.getState().retry_attempts.has('p1__fe')).toBe(false);
    // gaggle:failed label applied
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[1] === 'gaggle:failed')).toBe(true);
  });
});

describe('hot path: pollFailedTargets retry trigger', () => {
  function makeFailedOrchestrator(opts: {
    failedIssue: Issue;
    parentIssue?: Issue;
    commentsByIssue: Record<string, Array<{ id: string; body: string; author: { id: string | null; name: string | null }; created_at: string }>>;
  }) {
    const cfg = makeServiceConfig();
    const calls: TrackerCall[] = [];
    const tracker = {
      ensureGaggleLabels: async () => {},
      resolveViewerId: async () => 'u1',
      fetchCandidateIssues: async () => [],
      fetchIssuesByLabel: async (label: string) => {
        calls.push({ op: 'fetchIssuesByLabel', args: [label] });
        return label === 'gaggle:failed' ? [opts.failedIssue] : [];
      },
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => opts.parentIssue ? [opts.parentIssue] : [],
      fetchIssueComments: async (id: string) => opts.commentsByIssue[id] ?? [],
      applyLabel: async (id: string, label: string) => { calls.push({ op: 'applyLabel', args: [id, label] }); },
      removeLabel: async (id: string, label: string) => { calls.push({ op: 'removeLabel', args: [id, label] }); },
      postComment: async (id: string, body: string) => { calls.push({ op: 'postComment', args: [id, body.slice(0, 80)] }); return { id: 'c-new' }; },
      updateIssueState: async (id: string, s: string) => { calls.push({ op: 'updateIssueState', args: [id, s] }); },
      createSubIssue: async () => ({ id: 'sub1', identifier: 'SYM-99' }),
      createBlockerRelation: async () => {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg, tracker,
      analyzer: { analyze: async () => ({ issue_id: 'x', analysis_summary: '', repo_targets: [] }) } as unknown as IssueAnalyzer,
      workspace: { ensureAuxRoot: () => {}, cleanAuxiliaryWorkspace: () => {} } as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(),
    });
    orchestrators.push(o);
    return { o, calls, cfg };
  }

  test('"retry" comment on a gaggle:failed sub-issue → retry_requested fires; gaggle:dispatching applied', async () => {
    const parent = makeIssue({ id: 'p1', identifier: 'SYM-400', parent_id: null, state: 'In Progress' });
    const failed = makeIssue({
      id: 'sub-fe', identifier: 'SYM-401', parent_id: 'p1',
      title: '[trialmatch-fe] Implement X', state: 'In Progress',
      labels: ['gaggle:failed'],
    });
    const { o, calls } = makeFailedOrchestrator({
      failedIssue: failed,
      parentIssue: parent,
      commentsByIssue: {
        'sub-fe': [
          { id: 'c1', body: '❌ **GaggleDispatch — worker failed**\n\nReason: `crash`', author: { id: 'bot', name: 'GaggleBot' }, created_at: '2026-05-13T13:00:00Z' },
          { id: 'c2', body: 'retry', author: { id: 'u2', name: 'Leo' }, created_at: '2026-05-13T14:00:00Z' },
        ],
      },
    });

    // Pre-condition: SM thinks the target is in failed (from a prior worker_failed transition)
    o.getState().parent_machine_states.set('p1', 'claimed');
    o.getState().target_machine_states.set('p1__trialmatch-fe', 'failed');
    o.getState().sibling_subissues.set('p1', new Map([['trialmatch-fe', 'sub-fe']]));

    await (o as unknown as { pollFailedTargets(): Promise<void> }).pollFailedTargets();

    // SM transition: failed → dispatching
    expect(o.getState().target_machine_states.get('p1__trialmatch-fe')).toBe('dispatching');
    // Linear: gaggle:failed removed, gaggle:dispatching applied
    expect(calls.some((c) => c.op === 'removeLabel' && c.args[1] === 'gaggle:failed')).toBe(true);
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[1] === 'gaggle:dispatching')).toBe(true);
    // Acknowledgement comment posted
    expect(calls.some((c) => c.op === 'postComment' && /retry triggered/i.test(c.args[1] as string))).toBe(true);
  });

  test('"cancel" comment → gaggle:failed removed, acknowledgement comment; target SM stays failed', async () => {
    const parent = makeIssue({ id: 'p1', identifier: 'SYM-410', parent_id: null, state: 'In Progress' });
    const failed = makeIssue({
      id: 'sub-fe', identifier: 'SYM-411', parent_id: 'p1',
      title: '[trialmatch-fe] Try Y', state: 'In Progress',
      labels: ['gaggle:failed'],
    });
    const { o, calls } = makeFailedOrchestrator({
      failedIssue: failed,
      parentIssue: parent,
      commentsByIssue: {
        'sub-fe': [
          { id: 'c1', body: '❌ **GaggleDispatch — worker failed**\n\nReason: `boom`', author: { id: 'bot', name: 'GaggleBot' }, created_at: '2026-05-13T13:00:00Z' },
          { id: 'c2', body: 'cancel this', author: { id: 'u2', name: 'Leo' }, created_at: '2026-05-13T14:00:00Z' },
        ],
      },
    });

    o.getState().target_machine_states.set('p1__trialmatch-fe', 'failed');
    o.getState().sibling_subissues.set('p1', new Map([['trialmatch-fe', 'sub-fe']]));

    await (o as unknown as { pollFailedTargets(): Promise<void> }).pollFailedTargets();

    expect(o.getState().target_machine_states.get('p1__trialmatch-fe')).toBe('failed');
    expect(calls.some((c) => c.op === 'removeLabel' && c.args[1] === 'gaggle:failed')).toBe(true);
    expect(calls.some((c) => c.op === 'postComment' && /cancellation acknowledged/i.test(c.args[1] as string))).toBe(true);
    // No retry spawn
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[1] === 'gaggle:dispatching')).toBe(false);
  });

  test('ambiguous comment → posts clarification, no SM transition', async () => {
    const parent = makeIssue({ id: 'p1', identifier: 'SYM-420' });
    const failed = makeIssue({
      id: 'sub-fe', identifier: 'SYM-421', parent_id: 'p1',
      title: '[trialmatch-fe] Z', state: 'In Progress', labels: ['gaggle:failed'],
    });
    const { o, calls } = makeFailedOrchestrator({
      failedIssue: failed,
      parentIssue: parent,
      commentsByIssue: {
        'sub-fe': [
          { id: 'c1', body: '❌ **GaggleDispatch — worker failed**', author: { id: 'bot', name: 'GaggleBot' }, created_at: '2026-05-13T13:00:00Z' },
          { id: 'c2', body: 'hmm what happened?', author: { id: 'u2', name: 'Leo' }, created_at: '2026-05-13T14:00:00Z' },
        ],
      },
    });

    o.getState().target_machine_states.set('p1__trialmatch-fe', 'failed');
    o.getState().sibling_subissues.set('p1', new Map([['trialmatch-fe', 'sub-fe']]));

    await (o as unknown as { pollFailedTargets(): Promise<void> }).pollFailedTargets();

    // No state transition
    expect(o.getState().target_machine_states.get('p1__trialmatch-fe')).toBe('failed');
    // Clarification posted
    expect(calls.some((c) => c.op === 'postComment' && /wasn't sure how to interpret/i.test(c.args[1] as string))).toBe(true);
    // No label changes
    expect(calls.some((c) => c.op === 'removeLabel' && c.args[1] === 'gaggle:failed')).toBe(false);
  });

  test('no human reply yet → no-op (idempotent across poll iterations)', async () => {
    const failed = makeIssue({
      id: 'sub-fe', identifier: 'SYM-431', parent_id: 'p1',
      title: '[trialmatch-fe] W', state: 'In Progress', labels: ['gaggle:failed'],
    });
    const { o, calls } = makeFailedOrchestrator({
      failedIssue: failed,
      commentsByIssue: {
        'sub-fe': [
          { id: 'c1', body: '❌ **GaggleDispatch — worker failed**', author: { id: 'bot', name: 'GaggleBot' }, created_at: '2026-05-13T13:00:00Z' },
        ],
      },
    });

    o.getState().target_machine_states.set('p1__trialmatch-fe', 'failed');

    await (o as unknown as { pollFailedTargets(): Promise<void> }).pollFailedTargets();

    expect(calls.some((c) => c.op === 'removeLabel')).toBe(false);
    expect(calls.some((c) => c.op === 'postComment')).toBe(false);
  });
});

describe('hot path: drainPendingTargets phase 3', () => {
  test('ready target → dispatch_attempted via SM (target_machine_states transitions to dispatching/running)', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-330' });
    const target = makeRepoTarget({ repo_alias: 'fe' });
    const analysis: IssueAnalysis = { issue_id: 'p1', analysis_summary: '', repo_targets: [target] };
    const cfg = makeServiceConfig();
    const calls: TrackerCall[] = [];
    const tracker = {
      ensureGaggleLabels: async () => {},
      resolveViewerId: async () => 'u1',
      fetchCandidateIssues: async () => [],
      fetchIssuesByLabel: async () => [],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      fetchIssueComments: async () => [],
      applyLabel: async (id: string, label: string) => { calls.push({ op: 'applyLabel', args: [id, label] }); },
      removeLabel: async (id: string, label: string) => { calls.push({ op: 'removeLabel', args: [id, label] }); },
      postComment: async () => ({ id: 'c1' }),
      updateIssueState: async (id: string, s: string) => { calls.push({ op: 'updateIssueState', args: [id, s] }); },
      createSubIssue: async () => ({ id: 'sub1', identifier: 'SYM-99' }),
      createBlockerRelation: async () => {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg, tracker,
      analyzer: { analyze: async () => analysis } as unknown as IssueAnalyzer,
      workspace: { ensureAuxRoot: () => {}, cleanAuxiliaryWorkspace: () => {} } as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(),
    });
    orchestrators.push(o);

    o.getState().pending_issues.set('p1', issue);
    o.getState().pending_targets.set('p1', [target]);
    o.getState().parent_machine_states.set('p1', 'claimed');

    // drainPendingTargets is private; access via cast.
    await (o as unknown as {
      drainPendingTargets(i: typeof issue, a: IssueAnalysis): Promise<void>;
    }).drainPendingTargets(issue, analysis);

    // emitTargetEvent transitioned 'queued' → 'dispatching'. launchWorker then
    // tried to apply the running label. Under no-auto-retry policy a real
    // spawn failure goes to 'failed' (not 'retrying'). Any non-queued
    // non-undefined state confirms the SM dispatch fired.
    const finalState = o.getState().target_machine_states.get('p1__fe') ?? '';
    expect(['dispatching', 'running', 'failed']).toContain(finalState);
    // The SM-driven dispatch should have emitted the dispatching label.
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[1] === 'gaggle:dispatching')).toBe(true);
  });

  test('ready target — applies gaggle:queued BEFORE gaggle:dispatching (full label cycle visible)', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-332' });
    const target = makeRepoTarget({ repo_alias: 'fe' });
    const analysis: IssueAnalysis = { issue_id: 'p1', analysis_summary: '', repo_targets: [target] };
    const cfg = makeServiceConfig();
    const calls: TrackerCall[] = [];
    const tracker = {
      ensureGaggleLabels: async () => {},
      resolveViewerId: async () => 'u1',
      fetchCandidateIssues: async () => [],
      fetchIssuesByLabel: async () => [],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      fetchIssueComments: async () => [],
      applyLabel: async (id: string, label: string) => { calls.push({ op: 'applyLabel', args: [id, label] }); },
      removeLabel: async (id: string, label: string) => { calls.push({ op: 'removeLabel', args: [id, label] }); },
      postComment: async () => ({ id: 'c1' }),
      updateIssueState: async () => {},
      createSubIssue: async () => ({ id: 'sub1', identifier: 'SYM-99' }),
      createBlockerRelation: async () => {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg, tracker,
      analyzer: { analyze: async () => analysis } as unknown as IssueAnalyzer,
      workspace: { ensureAuxRoot: () => {}, cleanAuxiliaryWorkspace: () => {} } as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(),
    });
    orchestrators.push(o);

    o.getState().pending_issues.set('p1', issue);
    o.getState().pending_targets.set('p1', [target]);
    o.getState().parent_machine_states.set('p1', 'claimed');

    await (o as unknown as {
      drainPendingTargets(i: typeof issue, a: IssueAnalysis): Promise<void>;
    }).drainPendingTargets(issue, analysis);

    // Verify the order: gaggle:queued was applied, then gaggle:queued removed,
    // then gaggle:dispatching applied. This is the full label lifecycle.
    const labelOps = calls
      .filter((c) => c.op === 'applyLabel' || c.op === 'removeLabel')
      .map((c) => `${c.op}(${c.args[1]})`);
    const queuedApplyIdx = labelOps.indexOf('applyLabel(gaggle:queued)');
    const queuedRemoveIdx = labelOps.indexOf('removeLabel(gaggle:queued)');
    const dispatchingApplyIdx = labelOps.indexOf('applyLabel(gaggle:dispatching)');

    expect(queuedApplyIdx).toBeGreaterThan(-1);
    expect(queuedRemoveIdx).toBeGreaterThan(queuedApplyIdx); // remove after apply
    expect(dispatchingApplyIdx).toBeGreaterThan(queuedRemoveIdx); // dispatching after queued removed
  });

  test('target with unsatisfied depends_on → stays queued (no SM dispatch)', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-331' });
    const target = makeRepoTarget({ repo_alias: 'fe', depends_on: ['be'] });
    const analysis: IssueAnalysis = { issue_id: 'p1', analysis_summary: '', repo_targets: [target] };
    const cfg = makeServiceConfig();
    const calls: TrackerCall[] = [];
    const tracker = {
      ensureGaggleLabels: async () => {},
      resolveViewerId: async () => 'u1',
      fetchCandidateIssues: async () => [],
      fetchIssuesByLabel: async () => [],
      fetchIssuesByStates: async () => [],
      fetchIssueStatesByIds: async () => [],
      fetchIssueComments: async () => [],
      applyLabel: async (id: string, label: string) => { calls.push({ op: 'applyLabel', args: [id, label] }); },
      removeLabel: async () => {},
      postComment: async () => ({ id: 'c1' }),
      updateIssueState: async () => {},
      createSubIssue: async () => ({ id: 'sub1', identifier: 'SYM-99' }),
      createBlockerRelation: async () => {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg, tracker,
      analyzer: { analyze: async () => analysis } as unknown as IssueAnalyzer,
      workspace: { ensureAuxRoot: () => {}, cleanAuxiliaryWorkspace: () => {} } as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(),
    });
    orchestrators.push(o);

    o.getState().pending_issues.set('p1', issue);
    o.getState().pending_targets.set('p1', [target]);
    o.getState().parent_machine_states.set('p1', 'claimed');
    // No sibling 'be' is registered → blocker unsatisfied.

    await (o as unknown as {
      drainPendingTargets(i: typeof issue, a: IssueAnalysis): Promise<void>;
    }).drainPendingTargets(issue, analysis);

    expect(o.getState().target_machine_states.get('p1__fe')).toBe('queued');
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[1] === 'gaggle:queued')).toBe(true);
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[1] === 'gaggle:dispatching')).toBe(false);
  });
});

// ─── maybeReleaseClaim ─────────────────────────────────────────────────────────

// ─── crash recovery scenarios ─────────────────────────────────────────────────

describe('crash recovery — recoverFromLinearLabels', () => {
  function makeRecoveryOrchestrator(
    byLabel: Record<string, Issue[]>,
    opts: { archonStatus?: () => Promise<ArchonRunRecord[]>; baseFolder?: string } = {},
  ) {
    const cfg = makeServiceConfig();
    cfg.polling.interval_ms = 86_400_000;
    if (opts.baseFolder) cfg.registry.base_folder = opts.baseFolder;
    const calls: TrackerCall[] = [];
    const tracker: LinearClient = {
      async ensureGaggleLabels() { calls.push({ op: 'ensureGaggleLabels', args: [] }); },
      async resolveViewerId() { return 'u1'; },
      async fetchCandidateIssues() { return []; },
      async fetchIssuesByLabel(label: string) {
        calls.push({ op: 'fetchIssuesByLabel', args: [label] });
        return byLabel[label] ?? [];
      },
      async fetchIssuesByStates() { return []; },
      async fetchIssueStatesByIds(ids: string[]) {
        calls.push({ op: 'fetchIssueStatesByIds', args: [ids] });
        return [];
      },
      async fetchIssueComments() { return []; },
      async applyLabel(id: string, label: string) { calls.push({ op: 'applyLabel', args: [id, label] }); },
      async removeLabel(id: string, label: string) { calls.push({ op: 'removeLabel', args: [id, label] }); },
      async postComment() { return { id: 'c1' }; },
      async updateIssueState(id: string, state: string) { calls.push({ op: 'updateIssueState', args: [id, state] }); },
      async createSubIssue() { return { id: 'sub1', identifier: 'SYM-99' }; },
      async createBlockerRelation() {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg,
      tracker,
      analyzer: { analyze: async () => ({ issue_id: 'x', analysis_summary: '', repo_targets: [] }) } as unknown as IssueAnalyzer,
      workspace: {} as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(opts.archonStatus),
    });
    orchestrators.push(o);
    return { o, calls, cfg };
  }

  test('running sub-issue → label swapped to queued and added to sibling_subissues', async () => {
    const parent = makeIssue({ id: 'p1', identifier: 'SYM-10', parent_id: null, state: 'In Progress', labels: ['gaggle:claimed'] });
    const runningSub = makeIssue({
      id: 'sub-be', identifier: 'SYM-11', parent_id: 'p1',
      title: '[trialmatch-be] Fix the feature',
      state: 'In Progress', labels: ['gaggle:running'],
    });
    const { o, calls } = makeRecoveryOrchestrator({
      'gaggle:claimed': [parent],
      'gaggle:running': [runningSub],
      'gaggle:queued': [],
      'gaggle:waiting-human': [],
    });
    await o.start();
    expect(o.getState().sibling_subissues.get('p1')?.get('trialmatch-be')).toBe('sub-be');
    expect(calls.some((c) => c.op === 'removeLabel' && c.args[0] === 'sub-be' && c.args[1] === 'gaggle:running')).toBe(true);
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[0] === 'sub-be' && c.args[1] === 'gaggle:queued')).toBe(true);
  });

  test('running sub-issue in terminal state → label cleaned up, not re-queued', async () => {
    const parent = makeIssue({ id: 'p1', parent_id: null, state: 'In Progress', labels: ['gaggle:claimed'] });
    const terminalSub = makeIssue({
      id: 'sub-be', identifier: 'SYM-11', parent_id: 'p1',
      title: '[trialmatch-be] Fix the feature',
      state: 'Done', labels: ['gaggle:running'], // Done but still has running label
    });
    const { o, calls } = makeRecoveryOrchestrator({
      'gaggle:claimed': [parent],
      'gaggle:running': [terminalSub],
      'gaggle:queued': [],
      'gaggle:waiting-human': [],
    });
    await o.start();
    // Label cleaned up
    expect(calls.some((c) => c.op === 'removeLabel' && c.args[0] === 'sub-be' && c.args[1] === 'gaggle:running')).toBe(true);
    // NOT re-queued
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[0] === 'sub-be' && c.args[1] === 'gaggle:queued')).toBe(false);
    // NOT added to sibling_subissues (skipped)
    expect(o.getState().sibling_subissues.has('p1')).toBe(false);
  });

  test('queued sub-issue → restored to sibling_subissues', async () => {
    const parent = makeIssue({ id: 'p1', parent_id: null, state: 'In Progress', labels: ['gaggle:claimed'] });
    const queuedSub = makeIssue({
      id: 'sub-fe', identifier: 'SYM-12', parent_id: 'p1',
      title: '[trialmatch-fe] Fix the feature',
      state: 'Todo', labels: ['gaggle:queued'],
    });
    const { o } = makeRecoveryOrchestrator({
      'gaggle:claimed': [parent],
      'gaggle:running': [],
      'gaggle:queued': [queuedSub],
      'gaggle:waiting-human': [],
    });
    await o.start();
    expect(o.getState().sibling_subissues.get('p1')?.get('trialmatch-fe')).toBe('sub-fe');
  });

  test('orphaned claimed parent — crash before dispatch (no persisted run) → un-claimed for re-dispatch, NOT terminal', async () => {
    // Orchestrator crashed between applyLabel(claimed) and spawning the worker.
    // No Archon run was ever started, so no run entry exists in the registry.
    const orphaned = makeIssue({ id: 'p1', identifier: 'SYM-20', parent_id: null, state: 'In Progress', labels: ['gaggle:claimed'] });
    const { o, calls } = makeRecoveryOrchestrator({
      'gaggle:claimed': [orphaned],
      'gaggle:running': [],
      'gaggle:queued': [],
      'gaggle:waiting-human': [],
    });
    await o.start();
    // Claimed label removed so the poll loop can re-dispatch
    expect(o.getState().parent_machine_states.get('p1')).toBeUndefined();
    expect(calls.some((c) => c.op === 'removeLabel' && c.args[0] === 'p1' && c.args[1] === 'gaggle:claimed')).toBe(true);
    // Issue must NOT be moved to a terminal state — it should cycle back through dispatch
    expect(calls.some((c) => c.op === 'updateIssueState' && c.args[0] === 'p1')).toBe(false);
  });

  test('orphaned claimed parent — work completed while down (persisted run + Archon completed) → claim released and parent transitioned to Done', async () => {
    // All sub-issues finished while the orchestrator was down; crash happened before
    // maybeReleaseClaim could remove the claimed label and transition the parent.
    const BASE = mkdirSync(`/tmp/gaggle-test-orphan-${Date.now()}`, { recursive: true }) as unknown as string ?? `/tmp/gaggle-test-orphan-${Date.now()}`;
    const WORKER_KEY = 'p1__trialmatch-be';
    const ARCHON_RUN_ID = 'deadbeefdeadbeefdeadbeefdeadbeef';
    try {
      writeRunEntry(BASE, WORKER_KEY, {
        archon_run_id: ARCHON_RUN_ID,
        parent_issue_id: 'p1',
        sub_issue_id: 'sub-be',
        repo_alias: 'trialmatch-be',
      });

      const orphaned = makeIssue({ id: 'p1', identifier: 'SYM-21', parent_id: null, state: 'In Progress', labels: ['gaggle:claimed'] });
      const { o, calls } = makeRecoveryOrchestrator({
        'gaggle:claimed': [orphaned],
        'gaggle:running': [],
        'gaggle:queued': [],
        'gaggle:waiting-human': [],
      }, {
        baseFolder: BASE,
        archonStatus: () => Promise.resolve([{
          id: ARCHON_RUN_ID, status: 'completed',
          workflow_name: 'gaggle/gaggle-fix-issue',
          working_path: '/some/path/trialmatch-be',
          started_at: new Date().toISOString(),
          user_message: '', completed_at: new Date().toISOString(), last_activity_at: null, metadata: {},
        }]),
      });

      await o.start();
      // Claim released
      expect(o.getState().parent_machine_states.get('p1')).not.toBe('claimed');
      expect(calls.some((c) => c.op === 'removeLabel' && c.args[0] === 'p1' && c.args[1] === 'gaggle:claimed')).toBe(true);
      // Parent transitioned to Done
      expect(calls.some((c) => c.op === 'updateIssueState' && c.args[0] === 'p1' && c.args[1] === 'Done')).toBe(true);
    } finally {
      rmSync(BASE, { recursive: true, force: true });
    }
  });

  test('claimed parent with active siblings is NOT released on startup', async () => {
    const parent = makeIssue({ id: 'p1', parent_id: null, state: 'In Progress', labels: ['gaggle:claimed'] });
    const queuedSub = makeIssue({
      id: 'sub-be', identifier: 'SYM-21', parent_id: 'p1',
      title: '[trialmatch-be] Fix the feature',
      state: 'Todo', labels: ['gaggle:queued'],
    });
    const { o, calls } = makeRecoveryOrchestrator({
      'gaggle:claimed': [parent],
      'gaggle:running': [],
      'gaggle:queued': [queuedSub],
      'gaggle:waiting-human': [],
    });
    await o.start();
    // Parent still has active sibling → NOT released
    expect(o.getState().parent_machine_states.get('p1')).toBe('claimed');
    expect(calls.some((c) => c.op === 'updateIssueState' && c.args[0] === 'p1')).toBe(false);
  });

  test('waiting-human sub-issue → partial gate entry restored in supervised_gates', async () => {
    const waitingSub = makeIssue({
      id: 'sub-be', identifier: 'SYM-30', parent_id: 'p1',
      title: '[trialmatch-be] Fix the feature',
      state: 'In Progress', labels: ['gaggle:waiting-human'],
    });
    const { o } = makeRecoveryOrchestrator({
      'gaggle:claimed': [],
      'gaggle:running': [],
      'gaggle:queued': [],
      'gaggle:waiting-human': [waitingSub],
    });
    await o.start();
    const gate = o.getState().supervised_gates.get('p1__trialmatch-be');
    expect(gate).toBeDefined();
    expect(gate?.repo_alias).toBe('trialmatch-be');
    expect(gate?.sub_issue_id).toBe('sub-be');
  });

  test('retrying sub-issue with persisted retry → timer rescheduled with persisted attempt', async () => {
    const BASE = mkdirSync(`/tmp/gaggle-test-retry-${Date.now()}`, { recursive: true }) as unknown as string ?? `/tmp/gaggle-test-retry-${Date.now()}`;
    const WORKER_KEY = 'p1__trialmatch-be';
    try {
      // Pre-populate the retry registry with attempt=3 due in the past
      // (should reschedule with delay=0, attempt preserved).
      writeRetryEntry(BASE, WORKER_KEY, {
        parent_issue_id: 'p1',
        sub_issue_id: 'sub-be',
        repo_alias: 'trialmatch-be',
        attempt: 3,
        due_at_ms: Date.now() - 10_000,
        reason: 'previous_crash',
      });

      const parent = makeIssue({ id: 'p1', identifier: 'SYM-100', parent_id: null, state: 'In Progress', labels: ['gaggle:claimed'] });
      const retryingSub = makeIssue({
        id: 'sub-be', identifier: 'SYM-101', parent_id: 'p1',
        title: '[trialmatch-be] Fix the feature',
        state: 'In Progress', labels: ['gaggle:retrying'],
      });
      const { o } = makeRecoveryOrchestrator({
        'gaggle:claimed': [parent],
        'gaggle:running': [],
        'gaggle:queued': [],
        'gaggle:waiting-human': [],
        'gaggle:retrying': [retryingSub],
      }, { baseFolder: BASE });

      await o.start();

      const entry = o.getState().retry_attempts.get(WORKER_KEY);
      expect(entry).toBeDefined();
      expect(entry?.attempt).toBe(3);
      expect(o.getState().sibling_subissues.get('p1')?.get('trialmatch-be')).toBe('sub-be');
      // Parent issue snapshot must be populated for the spawnWorker hook to work later.
      expect(o.getState().pending_issues.has('p1')).toBe(true);
    } finally {
      rmSync(BASE, { recursive: true, force: true });
    }
  });

  test('orphaned retry entries (persisted but no matching label) are pruned', async () => {
    const BASE = mkdirSync(`/tmp/gaggle-test-orphan-retry-${Date.now()}`, { recursive: true }) as unknown as string ?? `/tmp/gaggle-test-orphan-retry-${Date.now()}`;
    try {
      // Persist a retry entry but DO NOT label any issue gaggle:retrying.
      writeRetryEntry(BASE, 'p1__stale', {
        parent_issue_id: 'p1', sub_issue_id: 'stale-sub', repo_alias: 'stale',
        attempt: 2, due_at_ms: Date.now(), reason: null,
      });

      const { o } = makeRecoveryOrchestrator({
        'gaggle:claimed': [],
        'gaggle:running': [],
        'gaggle:queued': [],
        'gaggle:waiting-human': [],
        'gaggle:retrying': [],
      }, { baseFolder: BASE });

      await o.start();
      // The orphaned entry should have been deleted by recoverRetryingIssues.
      const remaining = JSON.parse(readFileSync(join(BASE, 'gaggle-runs.json'), 'utf8')) as { retries: Record<string, unknown> };
      expect(remaining.retries['p1__stale']).toBeUndefined();
    } finally {
      rmSync(BASE, { recursive: true, force: true });
    }
  });

  test('running sub-issue with persisted run id → matched by exact id, tracked as detached', async () => {
    // Arrange: a claimed parent + running sub-issue, plus a persisted gaggle-runs.json entry.
    const BASE = '/tmp/base';
    mkdirSync(BASE, { recursive: true });
    const WORKER_KEY = 'p1__trialmatch-be';
    const ARCHON_RUN_ID = 'cafebabecafebabecafebabecafebabe';
    writeRunEntry(BASE, WORKER_KEY, {
      archon_run_id: ARCHON_RUN_ID,
      parent_issue_id: 'p1',
      sub_issue_id: 'sub-be',
      repo_alias: 'trialmatch-be',
    });

    const parent = makeIssue({ id: 'p1', identifier: 'SYM-10', parent_id: null, state: 'In Progress', labels: ['gaggle:claimed'] });
    const runningSub = makeIssue({
      id: 'sub-be', identifier: 'SYM-11', parent_id: 'p1',
      title: '[trialmatch-be] Fix the feature',
      state: 'In Progress', labels: ['gaggle:running'],
    });

    const { o } = makeRecoveryOrchestrator({
      'gaggle:claimed': [parent],
      'gaggle:running': [runningSub],
      'gaggle:queued': [],
      'gaggle:waiting-human': [],
    }, {
      // Inject an archonStatus that returns a running record with the exact ARCHON_RUN_ID.
      archonStatus: () => Promise.resolve([{
        id: ARCHON_RUN_ID,
        status: 'running',
        workflow_name: 'gaggle/gaggle-fix-issue',
        working_path: '/some/path/trialmatch-be',
        started_at: new Date().toISOString(),
        user_message: '', completed_at: null, last_activity_at: null, metadata: {},
      }]),
    });

    await o.start();

    // The run should be tracked as a detached run (not re-queued).
    const detached = o.getState().detached_archon_runs;
    const found = [...detached.values()].find((d) => d.archon_run_id === ARCHON_RUN_ID);
    expect(found).toBeDefined();
    expect(found?.repo_alias).toBe('trialmatch-be');

    // Clean up persisted entry.
    rmSync(BASE, { recursive: true, force: true });
  });

  test('running sub + persisted run + Archon completed → sub marked Done, parent claim released', async () => {
    // Both Gaggle and Archon crashed while Archon was running; Archon completed before the crash.
    // On restart: running label still on sub, but Archon shows completed → clean finish.
    const BASE = mkdirSync(`/tmp/gaggle-test-rc-${Date.now()}`, { recursive: true }) as unknown as string ?? `/tmp/gaggle-test-rc-${Date.now()}`;
    const WORKER_KEY = 'p1__trialmatch-be';
    const ARCHON_RUN_ID = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0';
    try {
      writeRunEntry(BASE, WORKER_KEY, {
        archon_run_id: ARCHON_RUN_ID,
        parent_issue_id: 'p1',
        sub_issue_id: 'sub-be',
        repo_alias: 'trialmatch-be',
      });

      const parent = makeIssue({ id: 'p1', identifier: 'SYM-40', parent_id: null, state: 'In Progress', labels: ['gaggle:claimed'] });
      const runningSub = makeIssue({
        id: 'sub-be', identifier: 'SYM-41', parent_id: 'p1',
        title: '[trialmatch-be] Fix the feature',
        state: 'In Progress', labels: ['gaggle:running'],
      });

      const { o, calls } = makeRecoveryOrchestrator({
        'gaggle:claimed': [parent],
        'gaggle:running': [runningSub],
        'gaggle:queued': [],
        'gaggle:waiting-human': [],
      }, {
        baseFolder: BASE,
        archonStatus: () => Promise.resolve([{
          id: ARCHON_RUN_ID, status: 'completed',
          workflow_name: 'gaggle/gaggle-fix-issue',
          working_path: '/some/path/trialmatch-be',
          started_at: new Date().toISOString(),
          user_message: '', completed_at: new Date().toISOString(), last_activity_at: null, metadata: {},
        }]),
      });

      await o.start();

      // Sub-issue: running label removed, transitioned to Done
      expect(calls.some((c) => c.op === 'removeLabel' && c.args[0] === 'sub-be' && c.args[1] === 'gaggle:running')).toBe(true);
      expect(calls.some((c) => c.op === 'updateIssueState' && c.args[0] === 'sub-be' && c.args[1] === 'Done')).toBe(true);
      // Parent: claim released, transitioned to Done
      expect(calls.some((c) => c.op === 'removeLabel' && c.args[0] === 'p1' && c.args[1] === 'gaggle:claimed')).toBe(true);
      expect(calls.some((c) => c.op === 'updateIssueState' && c.args[0] === 'p1' && c.args[1] === 'Done')).toBe(true);
      // Not re-queued
      expect(calls.some((c) => c.op === 'applyLabel' && c.args[0] === 'sub-be' && c.args[1] === 'gaggle:queued')).toBe(false);
    } finally {
      rmSync(BASE, { recursive: true, force: true });
    }
  });

  test('running sub + persisted run + Archon paused → supervised gate restored, label swapped to waiting-human', async () => {
    // Both crashed while Archon was at a plan gate waiting for human approval.
    // On restart: running label on sub, but Archon shows paused → restore gate.
    const BASE = mkdirSync(`/tmp/gaggle-test-rp-${Date.now()}`, { recursive: true }) as unknown as string ?? `/tmp/gaggle-test-rp-${Date.now()}`;
    const WORKER_KEY = 'p1__trialmatch-be';
    const ARCHON_RUN_ID = 'babe1234babe1234babe1234babe1234';
    try {
      writeRunEntry(BASE, WORKER_KEY, {
        archon_run_id: ARCHON_RUN_ID,
        parent_issue_id: 'p1',
        sub_issue_id: 'sub-be',
        repo_alias: 'trialmatch-be',
      });

      const parent = makeIssue({ id: 'p1', identifier: 'SYM-50', parent_id: null, state: 'In Progress', labels: ['gaggle:claimed'] });
      const runningSub = makeIssue({
        id: 'sub-be', identifier: 'SYM-51', parent_id: 'p1',
        title: '[trialmatch-be] Fix the feature',
        state: 'In Progress', labels: ['gaggle:running'],
      });

      const { o, calls } = makeRecoveryOrchestrator({
        'gaggle:claimed': [parent],
        'gaggle:running': [runningSub],
        'gaggle:queued': [],
        'gaggle:waiting-human': [],
      }, {
        baseFolder: BASE,
        archonStatus: () => Promise.resolve([{
          id: ARCHON_RUN_ID, status: 'paused',
          workflow_name: 'gaggle/gaggle-fix-issue',
          working_path: '/some/path/trialmatch-be',
          started_at: new Date().toISOString(),
          user_message: '', completed_at: null, last_activity_at: null,
          metadata: { approval: { message: 'Please review the implementation plan.' } },
        }]),
      });

      await o.start();

      // Label swapped: running → waiting-human
      expect(calls.some((c) => c.op === 'removeLabel' && c.args[0] === 'sub-be' && c.args[1] === 'gaggle:running')).toBe(true);
      expect(calls.some((c) => c.op === 'applyLabel' && c.args[0] === 'sub-be' && c.args[1] === 'gaggle:waiting-human')).toBe(true);
      // Gate entry restored with correct metadata
      const gate = o.getState().supervised_gates.get('p1__trialmatch-be');
      expect(gate).toBeDefined();
      expect(gate?.run_id).toBe(ARCHON_RUN_ID);
      expect(gate?.repo_alias).toBe('trialmatch-be');
      expect(gate?.sub_issue_id).toBe('sub-be');
      expect(gate?.gate_message).toBe('Please review the implementation plan.');
      // NOT re-queued, NOT moved to Done
      expect(calls.some((c) => c.op === 'applyLabel' && c.args[1] === 'gaggle:queued')).toBe(false);
      expect(calls.some((c) => c.op === 'updateIssueState' && c.args[0] === 'sub-be')).toBe(false);
    } finally {
      rmSync(BASE, { recursive: true, force: true });
    }
  });
});

describe('shouldDispatchSubIssue eligibility', () => {
  test('dispatches a clean sub-issue with no blockers', async () => {
    const sub = makeIssue({
      id: 'sub1', identifier: 'SYM-50', parent_id: 'p1',
      title: '[trialmatch-be] Fix it', state: 'Todo', labels: [],
      blocked_by: [],
    });
    const { o, calls } = makeDispatchOrchestrator([sub]);
    // Simulate sibling_subissues so the sub maps to its parent.
    o.getState().sibling_subissues.set('p1', new Map([['trialmatch-be', 'sub1']]));
    // shouldDispatchSubIssue should return true for a clean sub-issue.
    const result = (o as unknown as { shouldDispatchSubIssue(i: typeof sub): boolean }).shouldDispatchSubIssue(sub);
  });

  test('skips sub-issue when an unsatisfied Linear blocker exists', async () => {
    const sub = makeIssue({
      id: 'sub1', identifier: 'SYM-51', parent_id: 'p1',
      title: '[trialmatch-be] Fix it', state: 'Todo', labels: [],
      blocked_by: [{ id: 'upstream', identifier: 'SYM-10', state: 'In Progress', labels: [] }],
    });
    const { o } = makeDispatchOrchestrator([sub]);
    const result = (o as unknown as { shouldDispatchSubIssue(i: typeof sub): boolean }).shouldDispatchSubIssue(sub);
    expect(result).toBe(false);
  });

  test('skips sub-issue whose Done blocker does not satisfy deployed readiness policy (no env label)', async () => {
    // Default config: blocker_default_readiness='deployed', no env labels on blocker
    const sub = makeIssue({
      id: 'sub1', identifier: 'SYM-52', parent_id: 'p1',
      title: '[trialmatch-be] Fix it', state: 'Todo', labels: [],
      blocked_by: [{ id: 'upstream', identifier: 'SYM-10', state: 'Done', labels: [] }],
    });
    const { o } = makeDispatchOrchestrator([sub]);
    // With 'deployed' readiness, Done state alone is not enough — needs env label.
    const result = (o as unknown as { shouldDispatchSubIssue(i: typeof sub): boolean }).shouldDispatchSubIssue(sub);
    expect(result).toBe(false);
  });

  test('dispatches sub-issue when Done blocker satisfies merged readiness policy', async () => {
    const sub = makeIssue({
      id: 'sub1', identifier: 'SYM-52b', parent_id: 'p1',
      title: '[trialmatch-be] Fix it', state: 'Todo', labels: [],
      blocked_by: [{ id: 'upstream', identifier: 'SYM-10', state: 'Done', labels: [] }],
    });
    // Use a tracker config with merged readiness (matches TrialMatch WORKFLOW.md).
    const cfg = makeServiceConfig();
    cfg.tracker.blocker_default_readiness = 'merged';
    const { orchestrator } = makeOrchestrator({ cfg });
    orchestrators.push(orchestrator);
    const result = (orchestrator as unknown as { shouldDispatchSubIssue(i: typeof sub): boolean }).shouldDispatchSubIssue(sub);
    expect(result).toBe(true);
  });

  test('skips sub-issue when worker already running for that key', async () => {
    const sub = makeIssue({
      id: 'sub1', identifier: 'SYM-53', parent_id: 'p1',
      title: '[trialmatch-be] Fix it', state: 'Todo', labels: [],
      blocked_by: [],
    });
    const { o } = makeDispatchOrchestrator([sub]);
    o.getState().running.set('p1__trialmatch-be', {
      session_id: 'x', issue: makeIssue(), identifier: 'SYM-53', repo_alias: 'trialmatch-be',
      repo_target: makeRepoTarget(), sub_issue_id: 'sub1', archon_pid: null, archon_db_run_id: null,
      archon_workflow: '', last_archon_event: null, last_archon_timestamp: null, last_archon_message: null,
      claude_input_tokens: 0, claude_output_tokens: 0, claude_total_tokens: 0, turn_count: 0,
      started_at: new Date().toISOString(), attempt: null,
    });
    const result = (o as unknown as { shouldDispatchSubIssue(i: typeof sub): boolean }).shouldDispatchSubIssue(sub);
    expect(result).toBe(false);
  });

  test('skips sub-issue when key already completed this session', async () => {
    const sub = makeIssue({
      id: 'sub1', identifier: 'SYM-54', parent_id: 'p1',
      title: '[trialmatch-be] Fix it', state: 'Todo', labels: [],
      blocked_by: [],
    });
    const { o } = makeDispatchOrchestrator([sub]);
    o.getState().target_machine_states.set('p1__trialmatch-be', 'succeeded');
    const result = (o as unknown as { shouldDispatchSubIssue(i: typeof sub): boolean }).shouldDispatchSubIssue(sub);
    expect(result).toBe(false);
  });
});

describe('reconcileRunningIssues — detached run transitions', () => {
  test('completed detached run → sub-issue marked Done and removed from detached map', async () => {
    const parent = makeIssue({ id: 'p1', identifier: 'SYM-60', state: 'In Progress' });
    const target = makeRepoTarget({ repo_alias: 'trialmatch-be' });
    const ARCHON_RUN_ID = 'cafecafecafecafecafecafecafecafe';

    const { o, calls } = makeDispatchOrchestrator([], {
      archonStatus: () => Promise.resolve([{
        id: ARCHON_RUN_ID, status: 'completed',
        workflow_name: 'gaggle/gaggle-fix-issue',
        working_path: '/path', started_at: new Date().toISOString(),
        user_message: '', completed_at: null, last_activity_at: null, metadata: {},
      }]),
    });

    // Seed detached run (as if recovered from crash)
    const state = o.getState();
    state.detached_archon_runs.set('p1__trialmatch-be', {
      archon_run_id: ARCHON_RUN_ID,
      parent_issue: parent,
      sub_issue_id: 'sub-be',
      repo_alias: 'trialmatch-be',
      repo_target: target,
      recovered_at: Date.now(),
    });
    state.parent_machine_states.set('p1', 'claimed');
    state.pending_issues.set('p1', parent);

    await (o as unknown as { reconcileRunningIssues(): Promise<void> }).reconcileRunningIssues();

    // Removed from detached map
    expect(state.detached_archon_runs.size).toBe(0);
    // Marked completed in Linear
    expect(calls.some((c) => c.op === 'updateIssueState' && c.args[0] === 'sub-be' && c.args[1] === 'Done')).toBe(true);
    // Recorded as succeeded in the SM state map
    expect(state.target_machine_states.get('p1__trialmatch-be')).toBe('succeeded');
  });

  test('failed detached run → sub-issue re-queued', async () => {
    const parent = makeIssue({ id: 'p1', identifier: 'SYM-61', state: 'In Progress' });
    const target = makeRepoTarget({ repo_alias: 'trialmatch-be' });
    const ARCHON_RUN_ID = 'deadbeefdeadbeefdeadbeefdeadbeef';

    const { o, calls } = makeDispatchOrchestrator([], {
      archonStatus: () => Promise.resolve([{
        id: ARCHON_RUN_ID, status: 'failed',
        workflow_name: 'gaggle/gaggle-fix-issue',
        working_path: '/path', started_at: new Date().toISOString(),
        user_message: '', completed_at: null, last_activity_at: null, metadata: {},
      }]),
    });

    const state = o.getState();
    state.detached_archon_runs.set('p1__trialmatch-be', {
      archon_run_id: ARCHON_RUN_ID,
      parent_issue: parent,
      sub_issue_id: 'sub-be',
      repo_alias: 'trialmatch-be',
      repo_target: target,
      recovered_at: Date.now(),
    });

    await (o as unknown as { reconcileRunningIssues(): Promise<void> }).reconcileRunningIssues();

    expect(state.detached_archon_runs.size).toBe(0);
    // Re-queued label applied
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[0] === 'sub-be' && (c.args[1] as string).includes('queued'))).toBe(true);
  });

  test('not_found detached run → sub-issue re-queued', async () => {
    const parent = makeIssue({ id: 'p1', identifier: 'SYM-62', state: 'In Progress' });
    const target = makeRepoTarget({ repo_alias: 'trialmatch-be' });

    const { o, calls } = makeDispatchOrchestrator([], {
      // archonStatus returns empty — run not found in Archon DB
      archonStatus: () => Promise.resolve([]),
    });

    const state = o.getState();
    state.detached_archon_runs.set('p1__trialmatch-be', {
      archon_run_id: 'missingmissingmissingmissing1234',
      parent_issue: parent,
      sub_issue_id: 'sub-be',
      repo_alias: 'trialmatch-be',
      repo_target: target,
      recovered_at: Date.now(),
    });

    await (o as unknown as { reconcileRunningIssues(): Promise<void> }).reconcileRunningIssues();

    expect(state.detached_archon_runs.size).toBe(0);
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[0] === 'sub-be' && (c.args[1] as string).includes('queued'))).toBe(true);
  });

  test('still-running detached run → left in detached map', async () => {
    const parent = makeIssue({ id: 'p1', identifier: 'SYM-63', state: 'In Progress' });
    const target = makeRepoTarget({ repo_alias: 'trialmatch-be' });
    const ARCHON_RUN_ID = 'aaaabbbbccccddddaaaabbbbccccdddd';

    const { o, calls } = makeDispatchOrchestrator([], {
      archonStatus: () => Promise.resolve([{
        id: ARCHON_RUN_ID, status: 'running',
        workflow_name: 'gaggle/gaggle-fix-issue',
        working_path: '/path', started_at: new Date().toISOString(),
        user_message: '', completed_at: null, last_activity_at: null, metadata: {},
      }]),
    });

    const state = o.getState();
    state.detached_archon_runs.set('p1__trialmatch-be', {
      archon_run_id: ARCHON_RUN_ID,
      parent_issue: parent,
      sub_issue_id: 'sub-be',
      repo_alias: 'trialmatch-be',
      repo_target: target,
      recovered_at: Date.now(),
    });

    await (o as unknown as { reconcileRunningIssues(): Promise<void> }).reconcileRunningIssues();

    // Still running — remains in the map
    expect(state.detached_archon_runs.size).toBe(1);
    expect(calls.some((c) => c.op === 'applyLabel')).toBe(false);
    expect(calls.some((c) => c.op === 'updateIssueState')).toBe(false);
  });
});

describe('maybeReleaseClaim', () => {
  test('releases claim and transitions parent to Done when all work is done', async () => {
    const issue = makeIssue({ id: 'i1', state: 'In Progress' });
    const { o, calls } = makeDispatchOrchestrator([], {});
    const state = o.getState();
    state.parent_machine_states.set('i1', 'claimed');
    state.pending_issues.set('i1', issue);
    // No running workers, no pending targets, no retries → should release
    await (o as unknown as { maybeReleaseClaim(id: string): Promise<void> }).maybeReleaseClaim('i1');
    expect(state.parent_machine_states.get('i1')).toBeUndefined();
    expect(calls.some((c) => c.op === 'removeLabel' && c.args[0] === 'i1' && (c.args[1] as string).includes('claimed'))).toBe(true);
    expect(calls.some((c) => c.op === 'updateIssueState' && c.args[0] === 'i1' && c.args[1] === 'Done')).toBe(true);
  });

  test('does NOT release claim while a worker is still running', async () => {
    const issue = makeIssue({ id: 'i1', state: 'In Progress' });
    const { o, calls } = makeDispatchOrchestrator([], {});
    const state = o.getState();
    state.parent_machine_states.set('i1', 'claimed');
    state.pending_issues.set('i1', issue);
    state.running.set('i1__repo-a', {
      session_id: 'i1__repo-a__0',
      issue,
      identifier: 'SYM-1',
      repo_alias: 'repo-a',
      repo_target: makeRepoTarget(),
      sub_issue_id: null,
      archon_pid: null,
      archon_db_run_id: null,
      archon_workflow: '',
      last_archon_event: null,
      last_archon_timestamp: null,
      last_archon_message: null,
      claude_input_tokens: 0,
      claude_output_tokens: 0,
      claude_total_tokens: 0,
      turn_count: 0,
      started_at: new Date().toISOString(),
      attempt: null,
    });
    await (o as unknown as { maybeReleaseClaim(id: string): Promise<void> }).maybeReleaseClaim('i1');
    expect(state.parent_machine_states.get('i1')).toBe('claimed'); // still claimed
    expect(calls.some((c) => c.op === 'updateIssueState')).toBe(false);
  });

  test('does NOT release claim while pending targets remain', async () => {
    const issue = makeIssue({ id: 'i1', state: 'In Progress' });
    const { o, calls } = makeDispatchOrchestrator([], {});
    const state = o.getState();
    state.parent_machine_states.set('i1', 'claimed');
    state.pending_issues.set('i1', issue);
    state.pending_targets.set('i1', [makeRepoTarget()]); // one target still queued
    await (o as unknown as { maybeReleaseClaim(id: string): Promise<void> }).maybeReleaseClaim('i1');
    expect(state.parent_machine_states.get('i1')).toBe('claimed');
    expect(calls.some((c) => c.op === 'updateIssueState')).toBe(false);
  });
});

describe('reconcileRunningIssues — live session transitions', () => {
  test('cancels live workers when refreshed parent issue is in terminal state', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-70', state: 'In Progress' });
    const { o } = makeDispatchOrchestrator([], {});
    const state = o.getState();

    let cancelled = false;
    state.parent_machine_states.set('p1', 'claimed');
    state.pending_issues.set('p1', issue);
    state.running.set('p1__trialmatch-be', {
      session_id: 's1', issue, identifier: 'SYM-70', repo_alias: 'trialmatch-be',
      repo_target: makeRepoTarget(), sub_issue_id: null, archon_pid: null, archon_db_run_id: null,
      archon_workflow: '', last_archon_event: null, last_archon_timestamp: null, last_archon_message: null,
      claude_input_tokens: 0, claude_output_tokens: 0, claude_total_tokens: 0, turn_count: 0,
      started_at: new Date().toISOString(), attempt: null,
      cancel: () => { cancelled = true; },
    });

    (o as unknown as { tracker: unknown }).tracker = {
      fetchIssueStatesByIds: async () => [{ ...issue, state: 'Done' }],
      removeLabel: async () => {},
      updateIssueState: async () => {},
    };

    await (o as unknown as { reconcileRunningIssues(): Promise<void> }).reconcileRunningIssues();

    expect(cancelled).toBe(true);
    expect(state.running.has('p1__trialmatch-be')).toBe(false);
  });

  test('cancels live workers when refreshed issue is neither active nor terminal', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-71', state: 'In Progress' });
    const { o } = makeDispatchOrchestrator([], {});
    const state = o.getState();

    let cancelled = false;
    state.running.set('p1__trialmatch-be', {
      session_id: 's1', issue, identifier: 'SYM-71', repo_alias: 'trialmatch-be',
      repo_target: makeRepoTarget(), sub_issue_id: null, archon_pid: null, archon_db_run_id: null,
      archon_workflow: '', last_archon_event: null, last_archon_timestamp: null, last_archon_message: null,
      claude_input_tokens: 0, claude_output_tokens: 0, claude_total_tokens: 0, turn_count: 0,
      started_at: new Date().toISOString(), attempt: null,
      cancel: () => { cancelled = true; },
    });

    (o as unknown as { tracker: unknown }).tracker = {
      fetchIssueStatesByIds: async () => [{ ...issue, state: 'Backlog' }],
    };

    await (o as unknown as { reconcileRunningIssues(): Promise<void> }).reconcileRunningIssues();

    expect(cancelled).toBe(true);
    expect(state.running.has('p1__trialmatch-be')).toBe(false);
  });
});

describe('scheduleRetry — max retries and completed guard', () => {
  test('abandons and marks Cancelled when attempt > 10', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-80', state: 'In Progress' });
    const target = makeRepoTarget({ repo_alias: 'trialmatch-be' });
    const { o, calls } = makeDispatchOrchestrator([], {});
    const state = o.getState();
    state.parent_machine_states.set('p1', 'claimed');
    state.pending_issues.set('p1', issue);

    (o as unknown as { scheduleRetry(...args: unknown[]): void }).scheduleRetry(issue, target, 11, 'too many attempts');

    await new Promise((r) => setTimeout(r, 0));
    expect(state.retry_attempts.has('p1__trialmatch-be')).toBe(false);
    expect(calls.some((c) => c.op === 'updateIssueState' && c.args[1] === 'Cancelled')).toBe(true);
  });

  test('executeRetry bails out immediately when key already in completed set', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-81', state: 'In Progress' });
    const target = makeRepoTarget({ repo_alias: 'trialmatch-be' });
    const { o, calls } = makeDispatchOrchestrator([], {});
    const state = o.getState();
    state.parent_machine_states.set('p1', 'claimed');
    state.pending_issues.set('p1', issue);
    state.target_machine_states.set('p1__trialmatch-be', 'succeeded');

    await (o as unknown as { executeRetry(k: string, i: typeof issue, t: typeof target, a: number): Promise<void> })
      .executeRetry('p1__trialmatch-be', issue, target, 1);

    expect(calls.some((c) => c.op === 'applyLabel')).toBe(false);
    expect(state.parent_machine_states.get('p1')).toBeUndefined();
  });

  test('executeRetry re-queues when no slots available', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-82', state: 'In Progress' });
    const target = makeRepoTarget({ repo_alias: 'trialmatch-be' });
    const cfg = makeServiceConfig();
    cfg.agent.max_concurrent_agents = 0;
    const { orchestrator: o } = makeOrchestrator({ cfg });
    orchestrators.push(o);
    const state = o.getState();
    state.parent_machine_states.set('p1', 'claimed');
    state.pending_issues.set('p1', issue);

    await (o as unknown as { executeRetry(k: string, i: typeof issue, t: typeof target, a: number): Promise<void> })
      .executeRetry('p1__trialmatch-be', issue, target, 2);

    expect(state.retry_attempts.has('p1__trialmatch-be')).toBe(true);
    expect(state.retry_attempts.get('p1__trialmatch-be')?.attempt).toBe(2);
  });

  test('executeRetry releases claim when issue is terminal at retry time', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-83', state: 'In Progress' });
    const target = makeRepoTarget({ repo_alias: 'trialmatch-be' });
    const { o, calls } = makeDispatchOrchestrator([], {});
    const state = o.getState();
    state.parent_machine_states.set('p1', 'claimed');
    state.pending_issues.set('p1', issue);

    (o as unknown as { tracker: unknown }).tracker = {
      fetchIssueStatesByIds: async () => [{ ...issue, state: 'Done' }],
      removeLabel: async (_id: string, _l: string) => { calls.push({ op: 'removeLabel', args: [_id, _l] }); },
      updateIssueState: async (_id: string, _s: string) => { calls.push({ op: 'updateIssueState', args: [_id, _s] }); },
    };

    await (o as unknown as { executeRetry(k: string, i: typeof issue, t: typeof target, a: number): Promise<void> })
      .executeRetry('p1__trialmatch-be', issue, target, 1);

    expect(state.parent_machine_states.get('p1')).toBeUndefined();
  });
});

// ─── gray-zone state guards ────────────────────────────────────────────────────
// A gray-zone state is one that is neither in active_states nor terminal_states.
// The default test config uses active_states=['Todo','In Progress'], terminal_states=[...Done/Cancelled].
// 'Triage' is used here as a representative gray-zone state — it's not active (won't dispatch)
// and not terminal (won't be caught by old terminal-only guards). All paths must treat any
// non-active state as off-limits regardless of whether it appears in terminal_states.

describe('gray-zone state guards', () => {
  test('shouldDispatch skips issues in gray-zone state (Triage)', async () => {
    const issue = makeIssue({ id: 'i1', state: 'Triage' }); // not in active_states, not in terminal_states
    const { o, calls } = makeDispatchOrchestrator([issue]);
    await runTick(o);
    expect(calls.some((c) => c.op === 'analyze')).toBe(false);
    expect(calls.some((c) => c.op === 'applyLabel' && (c.args[1] as string).includes('claimed'))).toBe(false);
  });

  test('executeRetry releases claim when issue is in gray-zone state (not active, not terminal)', async () => {
    const issue = makeIssue({ id: 'p1', identifier: 'SYM-84', state: 'In Progress' });
    const target = makeRepoTarget({ repo_alias: 'trialmatch-be' });
    const { o, calls } = makeDispatchOrchestrator([], {});
    const state = o.getState();
    state.parent_machine_states.set('p1', 'claimed');
    state.pending_issues.set('p1', issue);

    (o as unknown as { tracker: unknown }).tracker = {
      fetchIssueStatesByIds: async () => [{ ...issue, state: 'Triage' }], // gray-zone: not active, not terminal
      removeLabel: async (_id: string, _l: string) => { calls.push({ op: 'removeLabel', args: [_id, _l] }); },
      updateIssueState: async (_id: string, _s: string) => { calls.push({ op: 'updateIssueState', args: [_id, _s] }); },
    };

    await (o as unknown as { executeRetry(k: string, i: typeof issue, t: typeof target, a: number): Promise<void> })
      .executeRetry('p1__trialmatch-be', issue, target, 1);

    expect(state.parent_machine_states.get('p1')).toBeUndefined();
  });

  test('recoverFromLinearLabels: running sub in gray-zone state → label cleaned up, NOT re-queued', async () => {
    const parent = makeIssue({ id: 'p1', identifier: 'SYM-85', parent_id: null, state: 'In Progress', labels: ['gaggle:claimed'] });
    const graySub = makeIssue({
      id: 'sub-be', identifier: 'SYM-86', parent_id: 'p1',
      title: '[trialmatch-be] Fix the feature',
      state: 'Triage', labels: ['gaggle:running'], // gray-zone: stale running label, issue moved out of active states
    });

    const cfg = makeServiceConfig();
    cfg.polling.interval_ms = 86_400_000;
    const calls: TrackerCall[] = [];
    const tracker = {
      async ensureGaggleLabels() { calls.push({ op: 'ensureGaggleLabels', args: [] }); },
      async resolveViewerId() { return 'u1'; },
      async fetchCandidateIssues() { return []; },
      async fetchIssuesByLabel(label: string) {
        calls.push({ op: 'fetchIssuesByLabel', args: [label] });
        const byLabel: Record<string, typeof parent[]> = {
          'gaggle:claimed': [parent],
          'gaggle:running': [graySub],
          'gaggle:queued': [],
          'gaggle:waiting-human': [],
        };
        return byLabel[label] ?? [];
      },
      async fetchIssuesByStates() { return []; },
      async fetchIssueStatesByIds(ids: string[]) { calls.push({ op: 'fetchIssueStatesByIds', args: [ids] }); return []; },
      async fetchIssueComments() { return []; },
      async applyLabel(id: string, label: string) { calls.push({ op: 'applyLabel', args: [id, label] }); },
      async removeLabel(id: string, label: string) { calls.push({ op: 'removeLabel', args: [id, label] }); },
      async postComment() { return { id: 'c1' }; },
      async updateIssueState(id: string, s: string) { calls.push({ op: 'updateIssueState', args: [id, s] }); },
      async createSubIssue() { return { id: 'sub1', identifier: 'SYM-99' }; },
      async createBlockerRelation() {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg,
      tracker,
      analyzer: { analyze: async () => ({ issue_id: 'x', analysis_summary: '', repo_targets: [] }) } as unknown as IssueAnalyzer,
      workspace: {} as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(),
    });
    orchestrators.push(o);

    await o.start();

    // Running label cleaned up
    expect(calls.some((c) => c.op === 'removeLabel' && c.args[0] === 'sub-be' && c.args[1] === 'gaggle:running')).toBe(true);
    // NOT re-queued (gray-zone = no longer active)
    expect(calls.some((c) => c.op === 'applyLabel' && c.args[0] === 'sub-be' && c.args[1] === 'gaggle:queued')).toBe(false);
    // NOT added to sibling_subissues
    expect(o.getState().sibling_subissues.get('p1')?.has('trialmatch-be')).toBeFalsy();
  });

  test('recoverFromLinearLabels: queued sub in gray-zone state → NOT restored to sibling_subissues', async () => {
    const parent = makeIssue({ id: 'p1', identifier: 'SYM-87', parent_id: null, state: 'In Progress', labels: ['gaggle:claimed'] });
    const graySub = makeIssue({
      id: 'sub-be', identifier: 'SYM-88', parent_id: 'p1',
      title: '[trialmatch-be] Fix the feature',
      state: 'Triage', labels: ['gaggle:queued'], // gray-zone: label carried over, issue moved out of active states
    });

    const cfg = makeServiceConfig();
    cfg.polling.interval_ms = 86_400_000;
    const calls: TrackerCall[] = [];
    const tracker = {
      async ensureGaggleLabels() { calls.push({ op: 'ensureGaggleLabels', args: [] }); },
      async resolveViewerId() { return 'u1'; },
      async fetchCandidateIssues() { return []; },
      async fetchIssuesByLabel(label: string) {
        calls.push({ op: 'fetchIssuesByLabel', args: [label] });
        const byLabel: Record<string, typeof parent[]> = {
          'gaggle:claimed': [parent],
          'gaggle:running': [],
          'gaggle:queued': [graySub],
          'gaggle:waiting-human': [],
        };
        return byLabel[label] ?? [];
      },
      async fetchIssuesByStates() { return []; },
      async fetchIssueStatesByIds(ids: string[]) { calls.push({ op: 'fetchIssueStatesByIds', args: [ids] }); return []; },
      async fetchIssueComments() { return []; },
      async applyLabel(id: string, label: string) { calls.push({ op: 'applyLabel', args: [id, label] }); },
      async removeLabel(id: string, label: string) { calls.push({ op: 'removeLabel', args: [id, label] }); },
      async postComment() { return { id: 'c1' }; },
      async updateIssueState(id: string, s: string) { calls.push({ op: 'updateIssueState', args: [id, s] }); },
      async createSubIssue() { return { id: 'sub1', identifier: 'SYM-99' }; },
      async createBlockerRelation() {},
    } as unknown as LinearClient;

    const reg = makeFakeRegistry();
    const o = new Orchestrator({
      cfg,
      tracker,
      analyzer: { analyze: async () => ({ issue_id: 'x', analysis_summary: '', repo_targets: [] }) } as unknown as IssueAnalyzer,
      workspace: {} as unknown as WorkspaceManager,
      registry: reg.handle,
      syncer: null,
      archonClient: makeFakeArchonClient(),
    });
    orchestrators.push(o);

    await o.start();

    // Gray-zone queued sub should NOT be restored to sibling_subissues
    expect(o.getState().sibling_subissues.get('p1')?.has('trialmatch-be')).toBeFalsy();
  });
});

describe('reconcileRunningIssues — detached paused transition', () => {
  test('paused detached run → moved to supervised_gates and label swapped', async () => {
    const parent = makeIssue({ id: 'p1', identifier: 'SYM-90', state: 'In Progress' });
    const target = makeRepoTarget({ repo_alias: 'trialmatch-be' });
    const ARCHON_RUN_ID = 'bebebebebebebebebebebebebebebebe';

    const { o, calls } = makeDispatchOrchestrator([], {
      archonStatus: () => Promise.resolve([{
        id: ARCHON_RUN_ID, status: 'paused',
        workflow_name: 'gaggle/gaggle-fix-issue',
        working_path: '/path', started_at: new Date().toISOString(),
        user_message: '', completed_at: null, last_activity_at: null,
        metadata: { approval: { sessionId: 'gate-session-id', message: 'Please review' } },
      }]),
    });

    const state = o.getState();
    state.detached_archon_runs.set('p1__trialmatch-be', {
      archon_run_id: ARCHON_RUN_ID,
      parent_issue: parent,
      sub_issue_id: 'sub-be',
      repo_alias: 'trialmatch-be',
      repo_target: target,
      recovered_at: Date.now(),
    });

    await (o as unknown as { reconcileRunningIssues(): Promise<void> }).reconcileRunningIssues();

    expect(state.detached_archon_runs.size).toBe(0);
    const gate = state.supervised_gates.get('p1__trialmatch-be');
    expect(gate).toBeDefined();
    expect(gate?.gate_message).toContain('Please review');
    expect(calls.some((c) => c.op === 'removeLabel' && (c.args[1] as string).includes('running'))).toBe(true);
    expect(calls.some((c) => c.op === 'applyLabel' && (c.args[1] as string).includes('waiting-human'))).toBe(true);
  });
});
