/**
 * The read/act surface the orchestrator uses.
 *
 * Everything here used to be an HTTP call to Archon's API. It is now a direct
 * call into the engine, but the shape is unchanged on purpose: the state
 * machine, the effect applier and startup recovery all pattern-match on these
 * records, and rewriting them was not the point of the migration.
 *
 * One behavioural change worth knowing about: `approveRun` now stores the
 * decision **and** resumes. The old split — HTTP stored without resuming, so a
 * separate CLI call was needed to actually continue and preserve the human's
 * comment — is gone.
 */

import { logger } from '../util/logger.ts';
import type { GaggleExecutor } from './engine/index.ts';
import type { Store } from './store/types.ts';
import type { RunEventHandler, RunRecord, RunStatus } from './types.ts';

// Re-exported so consumers import the run vocabulary from one place.
export type { RunRecord, RunStatus, NodeRecord } from './types.ts';

export interface RunEventRecord {
  id: number;
  run_id: string;
  event_type: string;
  node_id: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface RunDetail {
  run: RunRecord;
  events: RunEventRecord[];
}

export class ExecutorClient {
  constructor(
    private readonly executor: GaggleExecutor,
    private readonly store: Store,
  ) {}

  /** Null when the run is unknown, so callers can iterate without try/catch. */
  async getRunDetail(runId: string): Promise<RunDetail | null> {
    const run = await this.executor.getRun(runId);
    if (!run) return null;
    const events = await this.store.listEvents(runId);
    return { run, events };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.executor.getRun(runId);
  }

  /**
   * Runs, newest first. `limit` is worth passing on any path that only needs
   * recent history — the table grows for the life of the deployment.
   */
  async listRuns(statuses?: RunStatus[], limit?: number): Promise<RunRecord[]> {
    return this.executor.listRuns({
      ...(statuses ? { status: statuses } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  /** Store the decision and resume. Returns false when there was no gate. */
  async approveRun(runId: string, comment?: string): Promise<boolean> {
    const pending = await this.store.getPendingApproval(runId);
    if (!pending) {
      logger.warn('approveRun called with no pending gate', { run_id: runId });
      return false;
    }
    await this.executor.approve(runId, comment);
    return true;
  }

  /**
   * Store the decision and resume. The gate's `on_reject` decides what
   * happens next: rework and re-park, or cancel the run.
   */
  async rejectRun(runId: string, reason?: string): Promise<void> {
    await this.executor.reject(runId, reason);
  }

  /** Approve and stream the resumed run's events back to the caller. */
  async approveAndWatch(
    runId: string,
    comment: string | undefined,
    onEvent: RunEventHandler,
  ): Promise<{ run_id: string; done: Promise<void> } | null> {
    const handle = await this.executor.approveAndWatch(runId, comment, onEvent);
    return handle ? { run_id: handle.run_id, done: handle.done } : null;
  }

  async cancelRun(runId: string, reason?: string): Promise<void> {
    await this.executor.cancel(runId, reason);
  }

  async abandonRun(runId: string): Promise<void> {
    await this.executor.abandon(runId);
  }
}

/**
 * Most recent run whose working path names this repo and whose status is in
 * the allowed set. Used at startup to rebind a target to its run when the
 * run-registry entry is missing.
 */
export function findRunForRepo(
  runs: RunRecord[],
  repoBasename: string,
  statuses: RunStatus[],
): RunRecord | null {
  const needle = repoBasename.toLowerCase();
  const matches = runs.filter(
    (r) =>
      statuses.includes(r.status) &&
      r.working_path != null &&
      r.working_path.toLowerCase().includes(needle),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => Date.parse(b.started_at || '') - Date.parse(a.started_at || ''));
  return matches[0] ?? null;
}
