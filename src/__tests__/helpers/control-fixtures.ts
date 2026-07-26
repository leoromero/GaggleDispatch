/**
 * Shared fixtures and fakes for the control-plane suites.
 *
 * The fakes record what they were asked to do rather than simulating it, so a
 * test asserts on the boundary crossing ("a run was spawned for `api`") instead
 * of on internals.
 */

import { MemoryControlStore } from '../../control/store/memory.ts';
import { ControlService, type ControlServiceConfig } from '../../control/service.ts';
import { DEFAULT_MIRROR_LABELS, type BlockerSpec } from '../../control/transitions.ts';
import type {
  AnalysisResult,
  AnalyzerPort,
  DispatchContext,
  ExecutorPort,
  SpawnResult,
  TrackerStructurePort,
  TrackerWritePort,
} from '../../control/ports.ts';
import type { TargetSpec, UpsertTicketInput } from '../../control/store/types.ts';
import type { TicketRow } from '../../control/types.ts';

export const WS = 'acme';

export function ticketInput(over: Partial<UpsertTicketInput> = {}): UpsertTicketInput {
  return {
    workspace: WS,
    external_id: 'lin-1',
    identifier: 'GAG-1',
    title: 'Fix the widget',
    description: 'It is broken',
    priority: 2,
    url: 'https://linear.app/gag-1',
    external_state: 'Todo',
    external_labels: [],
    blocked_by: [],
    external_created_at: '2026-07-01T00:00:00.000Z',
    external_updated_at: '2026-07-02T00:00:00.000Z',
    ...over,
  };
}

export function targetSpec(over: Partial<TargetSpec> = {}): TargetSpec {
  return {
    repo_alias: 'api',
    repo_url: 'https://github.com/acme/api',
    local_path: '/repos/api',
    workflow: 'gaggle/gaggle-fix-issue',
    rationale: 'owns the widget endpoint',
    components: [],
    depends_on: [],
    ...over,
  };
}

export function controlConfig(over: Partial<ControlServiceConfig> = {}): ControlServiceConfig {
  return {
    workspace: WS,
    tracker_kind: 'linear',
    mirror_labels: false,
    labels: DEFAULT_MIRROR_LABELS,
    completed_state: 'Done',
    gate_waiting_state: null,
    gate_resume_state: null,
    max_gate_rework_attempts: 3,
    readiness: {
      terminal_states: ['Done', 'Merged', 'Cancelled'],
      blocker_satisfied_states: ['Deployed'],
      deploy_env_labels: {},
      default_ready_env: 'staging',
      blocker_default_readiness: 'merged',
    },
    ...over,
  };
}

// ─── fakes ──────────────────────────────────────────────────────────────────

export class FakeExecutor implements ExecutorPort {
  spawned: DispatchContext[] = [];
  killed: Array<{ run_id: string | null; alias: string }> = [];
  approved: Array<{ approval_id: string | null; comment: string | null; alias: string }> = [];
  rejected: Array<{ approval_id: string | null; reason: string; alias: string }> = [];
  /** Set to make the next spawn throw. */
  spawnError: string | null = null;
  /**
   * Set to null to model an executor that reports its run id asynchronously.
   * Otherwise each spawn gets a *distinct* id — a shared one silently collides
   * when a test keys per-run observations by run id, which made a two-target
   * failure look like a success.
   */
  nextRunId: string | null | undefined = undefined;
  /** The id handed out by the most recent spawn, for assertions. */
  lastRunId: string | null = null;
  private runSeq = 0;

  async spawnRun(ctx: DispatchContext): Promise<SpawnResult> {
    if (this.spawnError) {
      const message = this.spawnError;
      this.spawnError = null;
      throw new Error(message);
    }
    this.spawned.push(ctx);
    const runId =
      this.nextRunId === undefined
        ? `${++this.runSeq}`.padStart(8, '0') + '-1111-4111-8111-111111111111'
        : this.nextRunId;
    this.lastRunId = runId;
    return { run_id: runId };
  }

  async killRun(runId: string | null, ctx: DispatchContext): Promise<void> {
    this.killed.push({ run_id: runId, alias: ctx.target.repo_alias });
  }

  async approveGate(args: {
    approval_id: string | null;
    run_id: string | null;
    comment: string | null;
    ctx: DispatchContext;
  }): Promise<void> {
    this.approved.push({
      approval_id: args.approval_id,
      comment: args.comment,
      alias: args.ctx.target.repo_alias,
    });
  }

  async rejectGate(args: {
    approval_id: string | null;
    run_id: string | null;
    reason: string;
    ctx: DispatchContext;
  }): Promise<void> {
    this.rejected.push({
      approval_id: args.approval_id,
      reason: args.reason,
      alias: args.ctx.target.repo_alias,
    });
  }
}

export class FakeTrackerStructure implements TrackerStructurePort {
  blockers: Array<{ spec: BlockerSpec; blocks: string }> = [];
  subIssues: Array<{ alias: string }> = [];

  async createBlockerIssue(spec: BlockerSpec, blocksExternalId: string): Promise<void> {
    this.blockers.push({ spec, blocks: blocksExternalId });
  }

  async createSubIssue(args: {
    ticket: TicketRow;
    target: { repo_alias: string };
  }): Promise<{ external_id: string; url: string | null }> {
    this.subIssues.push({ alias: args.target.repo_alias });
    return {
      external_id: `sub-${args.target.repo_alias}`,
      url: `https://linear.app/sub-${args.target.repo_alias}`,
    };
  }
}

export class FakeTrackerWrites implements TrackerWritePort {
  states: Array<{ id: string; state: string }> = [];
  comments: Array<{ id: string; body: string }> = [];
  applied: Array<{ id: string; label: string }> = [];
  removed: Array<{ id: string; label: string }> = [];
  /** Number of upcoming calls that should throw. */
  failNext = 0;

  private maybeFail(): void {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('tracker unreachable');
    }
  }

  async setState(id: string, state: string): Promise<void> {
    this.maybeFail();
    this.states.push({ id, state });
  }

  async postComment(id: string, body: string): Promise<void> {
    this.maybeFail();
    this.comments.push({ id, body });
  }

  async applyLabel(id: string, label: string): Promise<void> {
    this.maybeFail();
    this.applied.push({ id, label });
  }

  async removeLabel(id: string, label: string): Promise<void> {
    this.maybeFail();
    this.removed.push({ id, label });
  }
}

export class FakeAnalyzer implements AnalyzerPort {
  calls: string[] = [];
  result: AnalysisResult = {
    summary: 'one repo',
    complexity: 'simple',
    targets: [
      {
        repo_alias: 'api',
        repo_url: 'https://github.com/acme/api',
        local_path: '/repos/api',
        workflow: 'gaggle/gaggle-fix-issue',
      },
    ],
  };
  error: string | null = null;

  async analyze(ticket: TicketRow): Promise<AnalysisResult> {
    this.calls.push(ticket.identifier);
    if (this.error) throw new Error(this.error);
    return this.result;
  }
}

// ─── harness ────────────────────────────────────────────────────────────────

export interface Harness {
  store: MemoryControlStore;
  service: ControlService;
  executor: FakeExecutor;
  tracker: FakeTrackerStructure;
  analyzer: FakeAnalyzer;
  cfg: ControlServiceConfig;
}

export async function harness(cfgOver: Partial<ControlServiceConfig> = {}): Promise<Harness> {
  const store = new MemoryControlStore();
  await store.migrate();
  const executor = new FakeExecutor();
  const tracker = new FakeTrackerStructure();
  const analyzer = new FakeAnalyzer();
  const cfg = controlConfig(cfgOver);
  const service = new ControlService({ store, cfg, executor, tracker, analyzer });
  return { store, service, executor, tracker, analyzer, cfg };
}

/** Import a ticket, analyze it, and press Start. The common starting point. */
export async function startedTicket(
  h: Harness,
  specs: TargetSpec[] = [targetSpec()],
  input: Partial<UpsertTicketInput> = {},
): Promise<TicketRow> {
  const ticket = await h.store.upsertTicket(ticketInput(input));
  await h.service.requestAnalysis(ticket.id);
  await h.service.claimAnalysisWork(10);
  h.analyzer.result = {
    summary: 'analyzed',
    complexity: 'complex',
    targets: specs.map((s) => ({ ...s, rationale: s.rationale ?? null })),
  };
  const claimed = await h.store.getTicket(ticket.id);
  await h.service.runAnalysis(claimed!);
  await h.service.start(ticket.id);
  return (await h.store.getTicket(ticket.id))!;
}
