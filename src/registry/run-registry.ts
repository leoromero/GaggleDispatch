/**
 * Persistent registry of worker state, keyed by workerKey.
 *
 * Two parallel maps live in <base_folder>/gaggle-runs.json:
 *
 *   entries  — workerKey → run id, written while a worker is live
 *              so the orchestrator can rebind to the right run on
 *              restart instead of guessing by repo basename.
 *
 *   retries  — workerKey → retry meta (attempt count, due-at timestamp,
 *              last error). Written when a target enters `retrying`, deleted
 *              when the retry fires. Lets retry attempt counts and back-off
 *              schedules survive an orchestrator crash.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../util/logger.ts';

const FILENAME = 'gaggle-runs.json';

interface RunEntry {
  run_id: string;
  parent_issue_id: string;
  sub_issue_id: string | null;
  repo_alias: string;
  started_at: string;
}

interface RetryEntry {
  parent_issue_id: string;
  sub_issue_id: string | null;
  repo_alias: string;
  attempt: number;
  due_at_ms: number;
  reason: string | null;
  updated_at: string;
}

interface RunsFile {
  entries: Record<string, RunEntry>;
  retries: Record<string, RetryEntry>;
}

function filePath(baseFolder: string): string {
  return join(baseFolder, FILENAME);
}

function load(baseFolder: string): RunsFile {
  const p = filePath(baseFolder);
  if (!existsSync(p)) return { entries: {}, retries: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<RunsFile>;
    return {
      entries: parsed.entries ?? {},
      retries: parsed.retries ?? {},
    };
  } catch {
    return { entries: {}, retries: {} };
  }
}

function save(baseFolder: string, data: RunsFile): void {
  try {
    writeFileSync(filePath(baseFolder), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logger.warn('gaggle-runs.json write failed', { error: (err as Error).message });
  }
}

// ─── run entries ───────────────────────────────────────────────────────────

/** Record that a worker started and its run id is now known. */
export function writeRunEntry(
  baseFolder: string,
  workerKey: string,
  entry: Omit<RunEntry, 'started_at'>,
): void {
  const data = load(baseFolder);
  data.entries[workerKey] = { ...entry, started_at: new Date().toISOString() };
  save(baseFolder, data);
}

/** Retrieve the run entry for a worker key. Returns null if not found. */
export function readRunEntry(baseFolder: string, workerKey: string): RunEntry | null {
  const data = load(baseFolder);
  return data.entries[workerKey] ?? null;
}

/** Remove a run entry (call on worker success, failure, or cancellation). */
export function deleteRunEntry(baseFolder: string, workerKey: string): void {
  const data = load(baseFolder);
  if (!(workerKey in data.entries)) return;
  delete data.entries[workerKey];
  save(baseFolder, data);
}

/** Return all current run entries (used during crash recovery). */
export function allRunEntries(baseFolder: string): Record<string, RunEntry> {
  return load(baseFolder).entries;
}

// ─── retry entries ─────────────────────────────────────────────────────────

/** Record that a target has entered the retrying state. */
export function writeRetryEntry(
  baseFolder: string,
  workerKey: string,
  entry: Omit<RetryEntry, 'updated_at'>,
): void {
  const data = load(baseFolder);
  data.retries[workerKey] = { ...entry, updated_at: new Date().toISOString() };
  save(baseFolder, data);
}

/** Retrieve the retry entry for a worker key. Returns null if not found. */
export function readRetryEntry(baseFolder: string, workerKey: string): RetryEntry | null {
  const data = load(baseFolder);
  return data.retries[workerKey] ?? null;
}

/** Remove a retry entry (call on retry-due fire, success, or cancellation). */
export function deleteRetryEntry(baseFolder: string, workerKey: string): void {
  const data = load(baseFolder);
  if (!(workerKey in data.retries)) return;
  delete data.retries[workerKey];
  save(baseFolder, data);
}

/** Return all current retry entries (used during crash recovery). */
export function allRetryEntries(baseFolder: string): Record<string, RetryEntry> {
  return load(baseFolder).retries;
}
