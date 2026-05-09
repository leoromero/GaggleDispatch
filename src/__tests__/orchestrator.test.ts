/**
 * Orchestrator full-cycle tests using fakes — exercises the parts of the state
 * machine that don't require spawning real Archon subprocesses:
 *
 *  • startup label-driven recovery (Section 12.4)
 *  • `ensureSymphonyLabels` is called on start
 *  • analysis cache invalidation when registry context changes
 *  • `stop()` cancels in-flight LiveSessions
 *  • candidate sort/dispatch eligibility (via shouldDispatch invoked indirectly)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import type { LinearClient } from '../tracker/linear.ts';
import type { IssueAnalyzer } from '../analyzer/issue-analyzer.ts';
import type { WorkspaceManager } from '../workspace/workspace-manager.ts';
import type { RegistryLoaderHandle } from '../registry/loader.ts';
import type {
  Issue,
  RegistryContext,
} from '../domain/types.ts';
import { makeIssue, makeRegistryContext, makeServiceConfig } from './helpers/fixtures.ts';

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
    async ensureSymphonyLabels() {
      calls.push({ op: 'ensureSymphonyLabels', args: [] });
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

function makeOrchestrator(extra: { tracker?: ReturnType<typeof makeFakeTracker>['tracker']; registry?: RegistryLoaderHandle } = {}) {
  const cfg = makeServiceConfig();
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
  test('calls ensureSymphonyLabels and resolveViewerId during startup', async () => {
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
    expect(ops).toContain('ensureSymphonyLabels');
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
    const { tracker } = makeFakeTracker({
      byLabel: {
        'symphony:claimed': [claimedParent, claimedSub],
        'symphony:running': [],
        'symphony:waiting-human': [],
        'symphony:queued': [],
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
    expect(state.claimed.has('p1')).toBe(true);
    expect(state.claimed.has('s1')).toBe(false); // sub-issue does NOT count
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
        'symphony:claimed': [],
        'symphony:running': [runningSub],
        'symphony:waiting-human': [],
        'symphony:queued': [],
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
    expect(ops).toContain('removeLabel:symphony:running');
    expect(ops).toContain('applyLabel:symphony:queued');
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
    expect(s.claimed.size).toBe(0);
    expect(s.pending_issues.size).toBe(0);
    expect(s.poll_interval_ms).toBe(cfg.polling.interval_ms);
  });
});
