/**
 * Worker → run links and the retry schedule.
 *
 * This used to be `<base_folder>/gaggle-runs.json`, holding two maps. Only one
 * of them survived the move to Postgres.
 *
 * **Run links no longer exist as stored records.** The file existed so the
 * orchestrator could rebind a worker key to its run after a restart, because
 * the executor's run state lived in another process's database and could not
 * be queried by anything the orchestrator knew. Now the run carries the worker
 * key itself (`workflow_runs.external_key`), so the link *is* the run — there
 * is nothing separate to write, and nothing to go stale when the two disagree.
 *
 * **Retries do survive**, as a table. They are orchestrator state with no
 * corresponding run: a target waiting to be retried has, by definition, no run
 * in flight.
 */

import type { Store } from '../executor/store/types.ts';
import type { RunStatus } from '../executor/types.ts';

/** What the old `RunEntry` carried, reconstructed from the run row. */
export interface RunLink {
  run_id: string;
  parent_issue_id: string;
  sub_issue_id: string | null;
  repo_alias: string;
  started_at: string;
}

/**
 * Worker context stashed in run metadata at launch.
 *
 * `external_key` alone identifies the run, but recovery also needs the
 * sub-issue id, which is not derivable from anything else on the row.
 */
export interface WorkerMetadata {
  parent_issue_id: string;
  sub_issue_id: string | null;
  repo_alias: string;
}

/** A run is still "live" for linking purposes until it reaches a terminal state. */
const LIVE_STATUSES: RunStatus[] = ['pending', 'running', 'paused', 'interrupted'];

function toLink(row: {
  id: string;
  external_key: string | null;
  started_at: string;
  metadata: Record<string, unknown>;
  repo_slug?: string | null;
}): RunLink | null {
  const worker = row.metadata.worker as WorkerMetadata | undefined;
  if (!worker?.parent_issue_id) return null;
  return {
    run_id: row.id,
    parent_issue_id: worker.parent_issue_id,
    sub_issue_id: worker.sub_issue_id ?? null,
    repo_alias: worker.repo_alias ?? row.repo_slug ?? '',
    started_at: row.started_at,
  };
}

/** The run currently linked to this worker key, if it has not finished. */
export async function readRunLink(store: Store, workerKey: string): Promise<RunLink | null> {
  const row = await store.findRunByExternalKey(workerKey);
  if (!row || !LIVE_STATUSES.includes(row.status)) return null;
  return toLink(row);
}

/**
 * Every live worker → run link, keyed by worker key. Used by startup recovery
 * to reconstruct what was in flight.
 */
export async function allRunLinks(store: Store): Promise<Record<string, RunLink>> {
  const rows = await store.listRuns({ status: LIVE_STATUSES });
  const out: Record<string, RunLink> = {};
  for (const row of rows) {
    if (!row.external_key) continue;
    const link = toLink(row);
    // Newest first from listRuns, so the first key wins — a retried worker
    // links to its most recent run.
    if (link && !(row.external_key in out)) out[row.external_key] = link;
  }
  return out;
}

// ─── retry schedule ─────────────────────────────────────────────────────────

export interface RetryLink {
  parent_issue_id: string;
  sub_issue_id: string | null;
  repo_alias: string;
  attempt: number;
  due_at_ms: number;
  reason: string | null;
}

export async function writeRetryEntry(
  store: Store,
  workerKey: string,
  entry: RetryLink,
): Promise<void> {
  await store.upsertRetry({
    worker_key: workerKey,
    parent_issue_id: entry.parent_issue_id,
    sub_issue_id: entry.sub_issue_id,
    repo_alias: entry.repo_alias,
    attempt: entry.attempt,
    due_at: new Date(entry.due_at_ms).toISOString(),
    reason: entry.reason,
  });
}

export async function readRetryEntry(store: Store, workerKey: string): Promise<RetryLink | null> {
  const row = await store.getRetry(workerKey);
  if (!row) return null;
  return {
    parent_issue_id: row.parent_issue_id,
    sub_issue_id: row.sub_issue_id,
    repo_alias: row.repo_alias,
    attempt: row.attempt,
    due_at_ms: Date.parse(row.due_at),
    reason: row.reason,
  };
}

export async function deleteRetryEntry(store: Store, workerKey: string): Promise<void> {
  await store.deleteRetry(workerKey);
}

export async function allRetryEntries(store: Store): Promise<Record<string, RetryLink>> {
  const rows = await store.listRetries();
  const out: Record<string, RetryLink> = {};
  for (const r of rows) {
    out[r.worker_key] = {
      parent_issue_id: r.parent_issue_id,
      sub_issue_id: r.sub_issue_id,
      repo_alias: r.repo_alias,
      attempt: r.attempt,
      due_at_ms: Date.parse(r.due_at),
      reason: r.reason,
    };
  }
  return out;
}
