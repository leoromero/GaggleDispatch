/**
 * Persistent registry of issue analysis results, keyed by issue_id.
 *
 * Backed by <base_folder>/gaggle-analysis.json. Analysis is written
 * immediately after IssueAnalyzer produces a result and deleted when the
 * parent issue reaches a terminal state. This allows re-dispatch to reuse
 * the same analysis without re-running the expensive Claude call.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../util/logger.ts';
import type { IssueAnalysis } from '../domain/types.ts';

const FILENAME = 'gaggle-analysis.json';

interface AnalysisEntry {
  analysis: IssueAnalysis;
  saved_at: number; // unix ms
}

interface AnalysisFile {
  entries: Record<string, AnalysisEntry>;
}

function filePath(baseFolder: string): string {
  return join(baseFolder, FILENAME);
}

function load(baseFolder: string): AnalysisFile {
  const p = filePath(baseFolder);
  if (!existsSync(p)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<AnalysisFile>;
    return { entries: parsed.entries ?? {} };
  } catch {
    return { entries: {} };
  }
}

function save(baseFolder: string, data: AnalysisFile): void {
  try {
    writeFileSync(filePath(baseFolder), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logger.warn('gaggle-analysis.json write failed', { error: (err as Error).message });
  }
}

/** Persist an analysis result for an issue. Overwrites any existing entry. */
export function saveAnalysis(baseFolder: string, issue_id: string, analysis: IssueAnalysis): void {
  const data = load(baseFolder);
  data.entries[issue_id] = { analysis, saved_at: Date.now() };
  save(baseFolder, data);
}

/** Retrieve the analysis for an issue. Returns null if not found. */
export function getAnalysis(baseFolder: string, issue_id: string): IssueAnalysis | null {
  const data = load(baseFolder);
  return data.entries[issue_id]?.analysis ?? null;
}

/** Remove the analysis for an issue (call when parent reaches terminal state). */
export function deleteAnalysis(baseFolder: string, issue_id: string): void {
  const data = load(baseFolder);
  if (!(issue_id in data.entries)) return;
  delete data.entries[issue_id];
  save(baseFolder, data);
}
