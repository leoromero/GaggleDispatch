/**
 * The orchestrator, wired.
 *
 * The unit-level behaviour lives in the control-plane suites; this file exercises
 * the wiring, which is the part a refactor of this size is most likely to get
 * wrong. It drives real ticks against a real (in-memory) control plane with only
 * the process boundaries faked, and asserts the property the whole redesign is
 * for: **a tick over an imported ticket starts nothing.**
 *
 * This replaces the previous 2,400-line suite, most of which pinned the
 * poll-then-dispatch contract that no longer exists — `shouldDispatch`, label
 * recovery, comment-intent classification, retry timers. What survives here is
 * the part that still has meaning: does a click end in a subprocess, and does an
 * exiting subprocess end in the right status.
 */

import { describe, expect, test } from 'bun:test';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { MemoryControlStore } from '../control/store/memory.ts';
import type { WorkerCallbacks, WorkerStartArgs } from '../orchestrator/worker.ts';
import type { ArchonRunDetail } from '../executor/archon-client.ts';
import type { Issue, IssueAnalysis, RegistryContext } from '../domain/types.ts';
import { makeServiceConfig } from './helpers/fixtures.ts';

// ─── fakes for the process boundaries ───────────────────────────────────────

const REGISTRY: RegistryContext = {
  repositories: [
    {
      name: 'api',
      url: 'https://github.com/acme/api',
      local_path: '/repos/api',
      description: '',
      default_workflow: 'gaggle/gaggle-fix-issue',
      available_workflows: [],
      components: [],
      narrative: '',
    },
    {
      name: 'web',
      url: 'https://github.com/acme/web',
      local_path: '/repos/web',
      description: '',
      default_workflow: 'gaggle/gaggle-fix-issue',
      available_workflows: [],
      components: [],
      narrative: '',
    },
  ],
  components: [],
  last_synced_at: '',
  warnings: [],
  repos_dir: '/repos',
};

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 'lin-1',
    identifier: 'GAG-1',
    title: 'Fix the widget',
    description: 'broken',
    priority: 2,
    state: 'In Progress',
    branch_name: null,
    url: 'https://linear.app/gag-1',
    labels: [],
    blocked_by: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    parent_id: null,
    ...over,
  };
}

interface Rig {
  orchestrator: Orchestrator;
  store: MemoryControlStore;
  /** Worker launches, and the callbacks each was given. */
  spawns: Array<{ args: WorkerStartArgs; cb: WorkerCallbacks }>;
  cancels: string[];
  tracker: {
    candidates: Issue[];
    byId: Issue[];
    comments: Array<{ id: string; body: string }>;
    states: Array<{ id: string; state: string }>;
    subIssues: string[];
    labels: Array<{ id: string; label: string }>;
  };
  /** Archon's answer for getRunDetail, keyed by run id. */
  runDetail: Map<string, ArchonRunDetail | null>;
  analysisTargets: () => IssueAnalysis['repo_targets'];
  setAnalysisTargets: (t: IssueAnalysis['repo_targets']) => void;
  tick: () => Promise<void>;
}

async function rig(over: { mirrorLabels?: boolean; maxAgents?: number } = {}): Promise<Rig> {
  const cfg = makeServiceConfig({
    agent: {
      max_concurrent_agents: over.maxAgents ?? 5,
      max_turns: 20,
      max_retry_backoff_ms: 1000,
      max_concurrent_agents_by_state: {},
    },
  });
  cfg.tracker.mirror_labels = over.mirrorLabels ?? false;
  cfg.tracker.terminal_states = ['Done', 'Cancelled'];
  cfg.tracker.active_states = ['Todo', 'In Progress'];
  cfg.tracker.pr_ready_state = null; // keep the PR watcher out of these tests
  cfg.database.url = 'unused-because-a-store-is-injected';

  const tracker: Rig['tracker'] = {
    candidates: [],
    byId: [],
    comments: [],
    states: [],
    subIssues: [],
    labels: [],
  };
  const spawns: Rig['spawns'] = [];
  const cancels: string[] = [];
  const runDetail = new Map<string, ArchonRunDetail | null>();
  let analysisTargets: IssueAnalysis['repo_targets'] = [
    {
      repo_url: 'https://github.com/acme/api',
      repo_alias: 'api',
      local_path: '/repos/api',
      workflow: 'gaggle/gaggle-fix-issue',
      rationale: 'owns it',
      components: [],
    },
  ];

  const store = new MemoryControlStore();
  await store.migrate();

  const orchestrator = new Orchestrator({
    cfg,
    workspaceName: 'acme',
    tracker: {
      async fetchCandidateIssues() {
        return tracker.candidates;
      },
      async fetchIssueStatesByIds(ids: string[]) {
        return tracker.byId.filter((i) => ids.includes(i.id));
      },
      async postComment(id: string, body: string) {
        tracker.comments.push({ id, body });
        return { id: 'c1' };
      },
      async updateIssueState(id: string, state: string) {
        tracker.states.push({ id, state });
      },
      async applyLabel(id: string, label: string) {
        tracker.labels.push({ id, label });
      },
      async removeLabel() {},
      async createSubIssue(args: { parent_id: string; title: string }) {
        tracker.subIssues.push(args.title);
        return { id: `sub-${tracker.subIssues.length}`, identifier: 'GAG-9', url: 'https://x' };
      },
      async createIssue() {
        return { id: 'blk-1', identifier: 'GAG-99', url: null };
      },
      async createBlockerRelation() {},
      async resolveViewerId() {
        return 'me';
      },
      async ensureGaggleLabels() {},
    } as never,
    analyzer: {
      async analyze(): Promise<IssueAnalysis> {
        return {
          issue_id: 'lin-1',
          analysis_summary: 'analysed',
          repo_targets: analysisTargets,
          complexity: 'simple',
        };
      },
    } as never,
    workspace: {
      validateRepoTarget() {},
      async refreshBaseCheckout() {},
      async syncTemplatesIfEnabled() {},
      async runHook() {},
      ensureAuxRoot() {},
      cleanAuxiliaryWorkspace() {},
    } as never,
    registry: { getContext: () => REGISTRY, on() {} } as never,
    syncer: null,
    controlStore: store,
    archonClient: {
      async getRunDetail(id: string) {
        return runDetail.get(id) ?? null;
      },
      async cancelRun() {},
      async approveRun() {
        return true;
      },
      async rejectRun() {},
    } as never,
    spawn: async (args: WorkerStartArgs, cb: WorkerCallbacks) => {
      spawns.push({ args, cb });
      return { cancel: (r?: string) => cancels.push(r ?? 'cancelled'), done: Promise.resolve() };
    },
  });

  await orchestrator.start();

  return {
    orchestrator,
    store,
    spawns,
    cancels,
    tracker,
    runDetail,
    analysisTargets: () => analysisTargets,
    setAnalysisTargets: (t) => {
      analysisTargets = t;
    },
    // `start()` schedules its own timer; drive ticks explicitly instead of waiting.
    tick: () => (orchestrator as unknown as { tick(): Promise<void> }).tick(),
  };
}

function detail(status: string, approvalMessage?: string): ArchonRunDetail {
  return {
    run: {
      id: 'run-1',
      workflow_name: 'wf',
      user_message: 'm',
      status,
      started_at: '2026-07-01T00:00:00.000Z',
      completed_at: null,
      last_activity_at: null,
      working_path: null,
      metadata: approvalMessage ? { approval: { message: approvalMessage } } : {},
    },
  } as unknown as ArchonRunDetail;
}

const only = async (r: Rig) => (await r.store.listTickets({ workspace: 'acme' }))[0]!;
const targetsOf = async (r: Rig, ticketId: string) => r.store.listTargets(ticketId);

// ─── the invariant ──────────────────────────────────────────────────────────

describe('Orchestrator — nothing runs without a click', () => {
  test('a tick imports a ticket and starts nothing', async () => {
    const r = await rig();
    r.tracker.candidates = [issue()];

    await r.tick();
    await r.tick();
    await r.tick();

    const ticket = await only(r);
    expect(ticket.status).toBe('imported');
    expect(await targetsOf(r, ticket.id)).toHaveLength(0);
    expect(r.spawns).toHaveLength(0);
    // Nothing was written to the tracker either.
    expect(r.tracker.comments).toEqual([]);
    expect(r.tracker.states).toEqual([]);
  });

  test('an analyzed ticket still waits for Start', async () => {
    const r = await rig();
    r.tracker.candidates = [issue()];
    await r.tick();

    const ticket = await only(r);
    await r.orchestrator.controlApi()!.handle({ method: 'POST', path: `/tickets/${ticket.id}/analyze` });
    await r.tick(); // performs the analysis

    expect((await only(r)).status).toBe('analyzed');
    expect(await targetsOf(r, ticket.id)).toHaveLength(1);
    await r.tick();
    expect(r.spawns).toHaveLength(0);
  });
});

// ─── the happy path, end to end ─────────────────────────────────────────────

describe('Orchestrator — Analyze, Start, run, complete', () => {
  async function upToStart(r: Rig) {
    r.tracker.candidates = [issue()];
    await r.tick();
    const api = r.orchestrator.controlApi()!;
    const ticket = await only(r);
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/analyze` });
    await r.tick();
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/start` });
    return { api, ticket };
  }

  test('Start then a tick spawns exactly one worker with the right context', async () => {
    const r = await rig();
    const { ticket } = await upToStart(r);

    await r.tick();

    expect(r.spawns).toHaveLength(1);
    const { args } = r.spawns[0]!;
    expect(args.issue.identifier).toBe('GAG-1');
    // The tracker id, not the control-plane row id — the worker talks to Linear.
    expect(args.issue.id).toBe('lin-1');
    expect(args.repo_target.repo_alias).toBe('api');
    expect(args.repo_target.local_path).toBe('/repos/api');
    expect(args.repo_target.workflow).toBe('gaggle/gaggle-fix-issue');

    const target = (await targetsOf(r, ticket.id))[0]!;
    expect(target.status).toBe('running');
  });

  test('a second tick does not spawn the same target twice', async () => {
    const r = await rig();
    await upToStart(r);
    await r.tick();
    await r.tick();
    await r.tick();
    expect(r.spawns).toHaveLength(1);
  });

  test('the run id from a log line lands on the target', async () => {
    const r = await rig();
    const { ticket } = await upToStart(r);
    await r.tick();

    r.spawns[0]!.cb.onRunId!('9136a16135d082cb9f0ac75523b3b56e');
    await Bun.sleep(10);

    // Stored verbatim: Archon's ids are not UUIDs and must survive unchanged.
    expect((await targetsOf(r, ticket.id))[0]!.run_id).toBe('9136a16135d082cb9f0ac75523b3b56e');
  });

  test('a clean exit completes the target and the ticket, and closes the tracker issue', async () => {
    const r = await rig();
    const { ticket } = await upToStart(r);
    await r.tick();
    r.spawns[0]!.cb.onRunId!('run-1');
    r.runDetail.set('run-1', detail('completed'));

    r.spawns[0]!.cb.onExit({ type: 'run_succeeded' });
    await Bun.sleep(10);
    await r.tick(); // drains the outbox

    expect((await targetsOf(r, ticket.id))[0]!.status).toBe('succeeded');
    expect((await only(r)).status).toBe('done');
    expect(r.tracker.states).toContainEqual({ id: 'lin-1', state: 'Done' });
  });

  test('live telemetry appears while a worker runs and clears when it exits', async () => {
    const r = await rig();
    await upToStart(r);
    await r.tick();

    r.spawns[0]!.cb.onStarted(4242);
    r.spawns[0]!.cb.onOutput('thinking about the widget');
    const running = [...r.orchestrator.getState().running.values()];
    expect(running).toHaveLength(1);
    expect(running[0]!.run_pid).toBe(4242);
    expect(running[0]!.last_message).toBe('thinking about the widget');
    expect(running[0]!.turn_count).toBe(1);

    r.spawns[0]!.cb.onExit({ type: 'run_succeeded' });
    await Bun.sleep(10);
    expect(r.orchestrator.getState().running.size).toBe(0);
  });
});

// ─── failure and gates ──────────────────────────────────────────────────────

describe('Orchestrator — failure and gates', () => {
  async function started(r: Rig) {
    r.tracker.candidates = [issue()];
    await r.tick();
    const api = r.orchestrator.controlApi()!;
    const ticket = await only(r);
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/analyze` });
    await r.tick();
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/start` });
    await r.tick();
    return { api, ticket };
  }

  test('a non-zero exit parks the target and comments the reason', async () => {
    const r = await rig();
    const { ticket } = await started(r);

    r.spawns[0]!.cb.onExit({ type: 'run_failed', exit_code: 1 });
    await Bun.sleep(10);
    await r.tick();

    const target = (await targetsOf(r, ticket.id))[0]!;
    expect(target.status).toBe('failed');
    expect(target.failure_reason).toBe('run_failed');
    // The ticket stays running: a failed target keeps it on the operator's board.
    expect((await only(r)).status).toBe('running');
    expect(r.tracker.comments.some((c) => c.body.includes('run_failed'))).toBe(true);
  });

  test('Re-dispatch after a failure runs it again with a bumped attempt', async () => {
    const r = await rig();
    const { api, ticket } = await started(r);
    r.spawns[0]!.cb.onExit({ type: 'run_failed' });
    await Bun.sleep(10);

    const target = (await targetsOf(r, ticket.id))[0]!;
    await api.handle({ method: 'POST', path: `/targets/${target.id}/redispatch` });
    await r.tick();

    expect(r.spawns).toHaveLength(2);
    expect((await targetsOf(r, ticket.id))[0]!.attempt).toBe(1);
  });

  test('a gate pause opens a gate rather than completing the target', async () => {
    const r = await rig();
    const { ticket } = await started(r);

    r.spawns[0]!.cb.onGatePaused('run-7', 'Approve the plan?');
    await Bun.sleep(10);

    const gates = await r.store.listPendingGates('acme');
    expect(gates).toHaveLength(1);
    expect(gates[0]!.gate_message).toBe('Approve the plan?');
    expect((await targetsOf(r, ticket.id))[0]!.status).toBe('gate_waiting');
    // The comment tells the operator where the buttons are.
    await r.tick();
    const comment = r.tracker.comments.find((c) => c.body.includes('Approve the plan?'));
    expect(comment).toBeTruthy();
    expect(comment!.body).toMatch(/no effect/i);
  });

  test('an exit-0 that is really a gate pause does not complete the target', async () => {
    // Archon exits 0 when a workflow pauses. Believing the exit code would mark a
    // half-finished workflow as succeeded.
    const r = await rig();
    const { ticket } = await started(r);
    r.spawns[0]!.cb.onRunId!('run-1');
    r.runDetail.set('run-1', detail('paused', 'Still need approval'));

    r.spawns[0]!.cb.onExit({ type: 'run_succeeded' });
    await Bun.sleep(10);

    expect((await targetsOf(r, ticket.id))[0]!.status).toBe('gate_waiting');
    expect((await only(r)).status).toBe('running');
  });

  test('approving in the dashboard resumes on the next tick', async () => {
    const r = await rig();
    const { api, ticket } = await started(r);
    r.spawns[0]!.cb.onGatePaused('run-7', 'ok?');
    await Bun.sleep(10);
    const target = (await targetsOf(r, ticket.id))[0]!;

    await api.handle({
      method: 'POST',
      path: `/gates/${target.id}/approve`,
      body: { comment: 'ship it' },
    });
    // Intent only until the daemon acts — the hub cannot resume a run.
    expect((await targetsOf(r, ticket.id))[0]!.status).toBe('gate_waiting');

    await r.tick();
    expect((await targetsOf(r, ticket.id))[0]!.status).toBe('running');
  });

  test('cancelling a live target kills the subprocess on the next tick', async () => {
    const r = await rig();
    const { api, ticket } = await started(r);
    const target = (await targetsOf(r, ticket.id))[0]!;

    await api.handle({ method: 'POST', path: `/targets/${target.id}/cancel` });
    expect(r.cancels).toHaveLength(0);

    await r.tick();
    expect(r.cancels).toHaveLength(1);
    expect((await targetsOf(r, ticket.id))[0]!.status).toBe('cancelled');
  });
});

// ─── fan-out ────────────────────────────────────────────────────────────────

describe('Orchestrator — multi-repo fan-out', () => {
  test('a dependency is respected across ticks, and sub-issues are created', async () => {
    const r = await rig();
    r.setAnalysisTargets([
      {
        repo_url: 'https://github.com/acme/api',
        repo_alias: 'api',
        local_path: '/repos/api',
        workflow: 'gaggle/gaggle-fix-issue',
        rationale: 'be',
        components: [],
      },
      {
        repo_url: 'https://github.com/acme/web',
        repo_alias: 'web',
        local_path: '/repos/web',
        workflow: 'gaggle/gaggle-fix-issue',
        rationale: 'fe',
        components: [],
        depends_on: ['api'],
      },
    ]);

    r.tracker.candidates = [issue()];
    await r.tick();
    const api = r.orchestrator.controlApi()!;
    const ticket = await only(r);
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/analyze` });
    await r.tick();
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/start` });

    await r.tick();
    // Only the upstream runs; the dependent waits.
    expect(r.spawns.map((s) => s.args.repo_target.repo_alias)).toEqual(['api']);
    let byAlias = Object.fromEntries((await targetsOf(r, ticket.id)).map((t) => [t.repo_alias, t]));
    expect(byAlias.web!.status).toBe('blocked');
    // A genuine fan-out gets sub-issues so the tracker shows per-repo progress.
    expect(r.tracker.subIssues).toEqual(['[api] Fix the widget', '[web] Fix the widget']);

    r.spawns[0]!.cb.onRunId!('run-api');
    r.runDetail.set('run-api', detail('completed'));
    r.spawns[0]!.cb.onExit({ type: 'run_succeeded' });
    await Bun.sleep(10);

    await r.tick();
    expect(r.spawns.map((s) => s.args.repo_target.repo_alias)).toEqual(['api', 'web']);
    byAlias = Object.fromEntries((await targetsOf(r, ticket.id)).map((t) => [t.repo_alias, t]));
    expect(byAlias.api!.status).toBe('succeeded');
    expect(byAlias.web!.status).toBe('running');
    // Not done until both land.
    expect((await only(r)).status).toBe('running');
  });

  test('the concurrency ceiling holds across ticks', async () => {
    const r = await rig({ maxAgents: 1 });
    r.setAnalysisTargets([
      { repo_url: 'https://github.com/acme/api', repo_alias: 'api', local_path: '/repos/api', workflow: 'w', rationale: '', components: [] },
      { repo_url: 'https://github.com/acme/web', repo_alias: 'web', local_path: '/repos/web', workflow: 'w', rationale: '', components: [] },
    ]);
    r.tracker.candidates = [issue()];
    await r.tick();
    const api = r.orchestrator.controlApi()!;
    const ticket = await only(r);
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/analyze` });
    await r.tick();
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/start` });

    await r.tick();
    await r.tick();
    expect(r.spawns).toHaveLength(1);
  });
});

// ─── sync and recovery ──────────────────────────────────────────────────────

describe('Orchestrator — sync and recovery', () => {
  test('a ticket closed in the tracker mid-run is flagged, not killed', async () => {
    const r = await rig();
    r.tracker.candidates = [issue()];
    await r.tick();
    const api = r.orchestrator.controlApi()!;
    const ticket = await only(r);
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/analyze` });
    await r.tick();
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/start` });
    await r.tick();

    r.tracker.candidates = [];
    r.tracker.byId = [issue({ state: 'Done' })];
    await r.tick();

    const after = await only(r);
    expect(after.status).toBe('running');
    expect(after.external_terminal_at).toBeTruthy();
    expect((await targetsOf(r, ticket.id))[0]!.status).toBe('running');
    expect(r.cancels).toEqual([]);
  });

  test('recovery is wired in, and a claim younger than the grace window is left alone', async () => {
    // The requeue *policy* — including the age guard that stops a live peer's
    // claim being stolen — is covered in control-reconciler.test.ts, where the
    // grace window is configurable. What matters here is that the orchestrator
    // actually runs recovery against the store rather than reconstructing state
    // from tracker labels, and that a just-made claim is not disturbed.
    const r = await rig();
    r.tracker.candidates = [issue()];
    await r.tick();
    const api = r.orchestrator.controlApi()!;
    const ticket = await only(r);
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/analyze` });
    await r.tick();
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/start` });

    // Simulate the crash window: the claim committed, the spawn never happened.
    await r.store.claimReadyTargets('acme', 10);
    expect((await targetsOf(r, ticket.id))[0]!.status).toBe('dispatching');

    const recovered = await (
      r.orchestrator as unknown as {
        control: {
          reconciler: {
            recoverOnStartup(): Promise<{ requeued: number; adopted: number; reopened: number }>;
          };
        };
      }
    ).control.reconciler.recoverOnStartup();

    expect(recovered.requeued).toBe(0);
    expect((await targetsOf(r, ticket.id))[0]!.status).toBe('dispatching');
    // And critically: no second run is started for it.
    await r.tick();
    expect(r.spawns).toHaveLength(0);
  });

  test('mirroring off keeps labels off the tracker entirely', async () => {
    const r = await rig({ mirrorLabels: false });
    r.tracker.candidates = [issue()];
    await r.tick();
    const api = r.orchestrator.controlApi()!;
    const ticket = await only(r);
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/analyze` });
    await r.tick();
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/start` });
    await r.tick();
    await r.tick();

    expect(r.tracker.labels).toEqual([]);
  });

  test('mirroring on writes labels one-way', async () => {
    const r = await rig({ mirrorLabels: true });
    r.tracker.candidates = [issue()];
    await r.tick();
    const api = r.orchestrator.controlApi()!;
    const ticket = await only(r);
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/analyze` });
    await r.tick();
    await r.tick();

    expect(r.tracker.labels.map((l) => l.label)).toContain('gaggle:analyzing');
  });

  test('syncNow runs a pass on demand', async () => {
    const r = await rig();
    r.tracker.candidates = [issue()];
    const result = await r.orchestrator.syncNow();
    expect(result.imported).toBe(1);
    expect(r.spawns).toHaveLength(0);
  });

  test('a tracker outage does not stop the rest of the tick', async () => {
    const r = await rig();
    r.tracker.candidates = [issue()];
    await r.tick();
    const api = r.orchestrator.controlApi()!;
    const ticket = await only(r);
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/analyze` });
    await r.tick();
    await api.handle({ method: 'POST', path: `/tickets/${ticket.id}/start` });

    // Sync will throw on the next tick; dispatch must still happen.
    (r.orchestrator as unknown as { control: { sync: { sync(): Promise<never> } } }).control.sync.sync =
      async () => {
        throw new Error('tracker 503');
      };
    await r.tick();

    expect(r.spawns).toHaveLength(1);
  });
});
