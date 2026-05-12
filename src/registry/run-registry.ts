/**
 * Persistent mapping of workerKey → Archon DB run id.
 *
 * Written to <base_folder>/gaggle-runs.json so the orchestrator can recover the
 * exact Archon run id after a crash — no heuristic matching needed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../util/logger.ts';

const FILENAME = 'gaggle-runs.json';

interface RunEntry {
  archon_run_id: string;
  parent_issue_id: string;
  sub_issue_id: string | null;
  repo_alias: string;
  started_at: string;
}

interface RunsFile {
  entries: Record<string, RunEntry>;
}

function filePath(baseFolder: string): string {
  return join(baseFolder, FILENAME);
}

function load(baseFolder: string): RunsFile {
  const p = filePath(baseFolder);
  if (!existsSync(p)) return { entries: {} };
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as RunsFile;
  } catch {
    return { entries: {} };
  }
}

function save(baseFolder: string, data: RunsFile): void {
  try {
    writeFileSync(filePath(baseFolder), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logger.warn('gaggle-runs.json write failed', { error: (err as Error).message });
  }
}

/** Record that a worker started and its Archon DB run id is now known. */
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

/** Return all current entries (used during crash recovery). */
export function allRunEntries(baseFolder: string): Record<string, RunEntry> {
  return load(baseFolder).entries;
}
