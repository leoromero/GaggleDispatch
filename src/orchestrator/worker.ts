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
import { startArchon, type ArchonEvent } from '../executor/archon.ts';
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
  /** Called once when Archon logs the workflowRunId (DB run id). */
  onRunId?: (db_run_id: string) => void;
}

export interface WorkerStartArgs {
  cfg: ServiceConfig;
  workspace: WorkspaceManager;
  issue: Issue;
  repo_target: RepoTarget;
  analysis: IssueAnalysis;
  attempt: number | null;
  source_branch: string;
  sub_issue_url?: string | null;
  /** When set, used as the Archon message instead of building one from issue+target. */
  message_override?: string;
}

export interface RunningWorker {
  cancel: (reason?: string) => void;
  done: Promise<void>;
}

export async function spawnWorker(args: WorkerStartArgs, cb: WorkerCallbacks): Promise<RunningWorker> {
  const { cfg, workspace, issue, repo_target, analysis, attempt } = args;
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

  const message = args.message_override ?? buildIssueMessage({ issue, repo_target, analysis, attempt, sub_issue_url: args.sub_issue_url ?? null });
  const env = buildGaggleEnv({ issue, repo_target, analysis, attempt, sub_issue_url: args.sub_issue_url ?? null });

  log.info('Launching Archon workflow', {
    workflow: repo_target.workflow,
    cwd: repo_target.local_path,
  });

  const handle = startArchon(
    {
      archonCommand: cfg.executor.command,
      workflowName: repo_target.workflow,
      cwd: repo_target.local_path,
      message,
      env,
      turnTimeoutMs: cfg.executor.turn_timeout_ms,
      stallTimeoutMs: cfg.executor.stall_timeout_ms,
    },
    (e: ArchonEvent) => {
      switch (e.type) {
        case 'archon_started':
          cb.onStarted(e.pid);
          break;
        case 'archon_output':
          cb.onOutput(e.line);
          break;
        case 'run_id':
          cb.onRunId?.(e.db_run_id);
          break;
        case 'run_gate_paused':
          cb.onGatePaused(e.run_id, e.gate_message);
          break;
        case 'run_succeeded':
        case 'run_failed':
        case 'run_timed_out':
        case 'run_stalled':
        case 'run_cancelled':
          cb.onExit({ type: e.type, exit_code: 'exit_code' in e ? e.exit_code : undefined });
          break;
      }
    },
  );

  // Run the after_run hook upon completion (best-effort).
  void handle.done.then(async () => {
    try {
      await workspace.runHook('after_run', repo_target, issue, attempt);
    } catch {
      /* logged inside */
    }
  });

  return {
    cancel: handle.cancel,
    done: handle.done,
  };
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
