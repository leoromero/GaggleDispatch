/**
 * Worker that executes one Run Attempt for one (issue, repo_target) pair (Section 17.5).
 * The orchestrator owns lifecycle; this file owns the execution flow.
 */

import type {
  Issue,
  IssueAnalysis,
  LiveSession,
  RepoTarget,
  ServiceConfig,
} from '../domain/types.ts';
import { logger } from '../util/logger.ts';
import type { GaggleExecutor } from '../executor/engine/index.ts';
import type { RunEvent } from '../executor/types.ts';
import { WorkspaceManager } from '../workspace/workspace-manager.ts';
import { buildIssueMessage, buildGaggleEnv } from '../workspace/message.ts';

export interface WorkerExitEvent {
  type: 'run_succeeded' | 'run_failed' | 'run_timed_out' | 'run_stalled' | 'run_cancelled';
  exit_code?: number;
}

export interface WorkerCallbacks {
  onStarted: (pid: number) => void;
  onOutput: (line: string) => void;
  onGatePaused: (run_id: string, gate_message: string) => void;
  onExit: (event: WorkerExitEvent) => void;
  /** Called once the run row exists and its id is known. */
  onRunId?: (run_id: string) => void;
}

export interface WorkerStartArgs {
  cfg: ServiceConfig;
  executor: GaggleExecutor;
  workspace: WorkspaceManager;
  issue: Issue;
  repo_target: RepoTarget;
  analysis: IssueAnalysis;
  attempt: number | null;
  source_branch: string;
  sub_issue_url?: string | null;
  /** Sub-issue this run is tracked by, if the target has one. */
  sub_issue_id?: string | null;
  /**
   * Orchestrator's key for this (issue, repo) pair. Stamped on the run so
   * startup recovery can find it again without a separate sidecar.
   */
  worker_key: string;
  /** When set, used as the run message instead of building one from issue+target. */
  message_override?: string;
}

export interface RunningWorker {
  cancel: (reason?: string) => void;
  done: Promise<void>;
}

/**
 * Translate engine events into the callbacks the orchestrator expects.
 *
 * The gate case is the notable one: the engine reports a pause exactly, with
 * the node id and the resolved message. The previous integration inferred it
 * by regex-matching a keyword and a UUID out of a log line.
 */
export function toWorkerCallbacks(cb: WorkerCallbacks): (e: RunEvent) => void {
  return (e) => {
    switch (e.type) {
      case 'run_started':
        cb.onRunId?.(e.run_id);
        break;
      case 'node_started':
        cb.onOutput(`▸ ${e.node_id} (${e.node_type})`);
        break;
      case 'node_output':
        cb.onOutput(e.line);
        break;
      case 'node_completed':
        cb.onOutput(`✓ ${e.node_id}`);
        break;
      case 'node_skipped':
        cb.onOutput(`· ${e.node_id} skipped — ${e.reason}`);
        break;
      case 'node_failed':
        cb.onOutput(`✗ ${e.node_id}: ${e.error}`);
        break;
      case 'run_gate_paused':
        cb.onGatePaused(e.run_id, e.gate_message);
        break;
      case 'run_succeeded':
        cb.onExit({ type: 'run_succeeded' });
        break;
      case 'run_failed':
        cb.onExit({ type: 'run_failed', exit_code: 1 });
        break;
      case 'run_cancelled':
        cb.onExit({ type: 'run_cancelled' });
        break;
      case 'run_timed_out':
        cb.onExit({ type: 'run_timed_out' });
        break;
    }
  };
}

export async function spawnWorker(args: WorkerStartArgs, cb: WorkerCallbacks): Promise<RunningWorker> {
  const { executor, workspace, issue, repo_target, analysis, attempt } = args;
  const log = logger.child({
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    repo_alias: repo_target.repo_alias,
  });

  workspace.validateRepoTarget(repo_target);
  await workspace.refreshBaseCheckout(repo_target, args.source_branch);
  await workspace.syncTemplatesIfEnabled(repo_target);

  try {
    await workspace.runHook('before_run', repo_target, issue, attempt);
  } catch (err) {
    log.error('before_run hook failed', { error: (err as Error).message });
    cb.onExit({ type: 'run_failed', exit_code: 99 });
    return { cancel: () => {}, done: Promise.resolve() };
  }

  const message =
    args.message_override ??
    buildIssueMessage({ issue, repo_target, analysis, attempt, sub_issue_url: args.sub_issue_url ?? null });
  const env = buildGaggleEnv({
    issue, repo_target, analysis, attempt, sub_issue_url: args.sub_issue_url ?? null,
  });

  log.info('Launching workflow', {
    workflow: repo_target.workflow,
    cwd: repo_target.local_path,
  });

  let handle;
  try {
    handle = await executor.startRun(
      {
        workflow: repo_target.workflow,
        cwd: repo_target.local_path,
        message,
        repo_slug: repo_target.repo_alias,
        env,
        base_branch: args.source_branch,
        external_key: args.worker_key,
        metadata: {
          worker: {
            parent_issue_id: issue.id,
            sub_issue_id: args.sub_issue_id ?? null,
            repo_alias: repo_target.repo_alias,
          },
        },
      },
      toWorkerCallbacks(cb),
    );
  } catch (err) {
    // An unknown workflow or an unloadable one fails here, before any node
    // runs — report it as a worker failure rather than letting it escape.
    log.error('Could not start the workflow', { error: (err as Error).message });
    cb.onOutput(`✗ ${(err as Error).message}`);
    cb.onExit({ type: 'run_failed', exit_code: 98 });
    return { cancel: () => {}, done: Promise.resolve() };
  }

  cb.onRunId?.(handle.run_id);

  // Run the after_run hook upon completion (best-effort).
  void handle.done.then(async () => {
    try {
      await workspace.runHook('after_run', repo_target, issue, attempt);
    } catch {
      /* logged inside */
    }
  });

  return { cancel: handle.cancel, done: handle.done };
}

export function buildLiveSession(args: {
  issue: Issue;
  repo_target: RepoTarget;
  attempt: number | null;
  sub_issue_id: string | null;
  cancel: () => void;
}): LiveSession {
  const { issue, repo_target, attempt, sub_issue_id, cancel } = args;
  return {
    session_id: `${issue.identifier}__${repo_target.repo_alias}__${attempt ?? 0}`,
    issue,
    identifier: issue.identifier,
    repo_alias: repo_target.repo_alias,
    repo_target,
    sub_issue_id,
    run_pid: null,
    run_id: null,
    workflow: repo_target.workflow,
    last_event: null,
    last_event_at: null,
    last_message: null,
    recent_output: [],
    claude_input_tokens: 0,
    claude_output_tokens: 0,
    claude_total_tokens: 0,
    turn_count: 0,
    started_at: new Date().toISOString(),
    attempt,
    cancel,
  };
}
