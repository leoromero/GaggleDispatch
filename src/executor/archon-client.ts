/**
 * HTTP client for Archon's REST API.
 *
 * This is the single place in GaggleDispatch that speaks directly to the
 * Archon HTTP API. No subprocess spawning here — just typed fetch calls.
 *
 * All methods return null / empty array on 404 / network error so callers
 * can always iterate safely without try/catch.
 */

import { logger } from '../util/logger.ts';

// ─── API shapes (mirrors Archon's workflow.schemas.ts) ──────────────────────

export type ArchonRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused';

export interface ArchonRunRecord {
  id: string;
  workflow_name: string;
  user_message: string;
  status: ArchonRunStatus;
  started_at: string;
  completed_at: string | null;
  last_activity_at: string | null;
  working_path: string | null;
  metadata: {
    approval?: {
      nodeId?: string;
      message?: string;
      sessionId?: string;
    };
    [key: string]: unknown;
  };
}

export interface ArchonRunEvent {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_index: number | null;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface ArchonRunDetail {
  run: ArchonRunRecord;
  events: ArchonRunEvent[];
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class ArchonClient {
  private readonly base: string;

  constructor(apiUrl: string) {
    // Strip trailing slash for consistent URL construction.
    this.base = apiUrl.replace(/\/$/, '');
  }

  /** GET /api/workflows/runs/:runId — returns null if not found or on error. */
  async getRunDetail(runId: string): Promise<ArchonRunDetail | null> {
    try {
      const res = await fetch(`${this.base}/api/workflows/runs/${encodeURIComponent(runId)}`);
      if (res.status === 404) return null;
      if (!res.ok) {
        logger.debug('Archon getRunDetail non-2xx', { runId, status: res.status });
        return null;
      }
      return (await res.json()) as ArchonRunDetail;
    } catch (err) {
      logger.debug('Archon getRunDetail error', { runId, error: (err as Error).message });
      return null;
    }
  }

  /** GET /api/workflows/runs — returns empty array on error. */
  async listRuns(): Promise<ArchonRunRecord[]> {
    try {
      const res = await fetch(`${this.base}/api/workflows/runs`);
      if (!res.ok) return [];
      const body = (await res.json()) as { runs?: unknown[] };
      return Array.isArray(body.runs) ? (body.runs as ArchonRunRecord[]) : [];
    } catch {
      return [];
    }
  }

  /** POST /api/workflows/runs/:runId/cancel */
  async cancelRun(runId: string): Promise<void> {
    await this._post(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`);
  }

  /** POST /api/workflows/runs/:runId/approve — comment is optional. Returns true on success. */
  async approveRun(runId: string, comment?: string): Promise<boolean> {
    return this._post(
      `/api/workflows/runs/${encodeURIComponent(runId)}/approve`,
      comment ? { comment } : undefined,
    );
  }

  /** POST /api/workflows/runs/:runId/reject — reason is optional. */
  async rejectRun(runId: string, reason?: string): Promise<void> {
    await this._post(
      `/api/workflows/runs/${encodeURIComponent(runId)}/reject`,
      reason ? { reason } : undefined,
    );
  }

  /** POST /api/workflows/runs/:runId/abandon */
  async abandonRun(runId: string): Promise<void> {
    await this._post(`/api/workflows/runs/${encodeURIComponent(runId)}/abandon`);
  }

  private async _post(path: string, body?: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        logger.warn('Archon API POST non-2xx', { path, status: res.status });
        return false;
      }
      return true;
    } catch (err) {
      logger.warn('Archon API POST error', { path, error: (err as Error).message });
      return false;
    }
  }
}

// ─── Pure helper (no HTTP) ──────────────────────────────────────────────────

/**
 * Find the most recent run whose working_path contains repoBasename and
 * whose status is in the allowed set. Returns null if no match.
 */
export function findArchonRunForRepo(
  runs: ArchonRunRecord[],
  repoBasename: string,
  statuses: ArchonRunStatus[],
): ArchonRunRecord | null {
  const lower = repoBasename.toLowerCase();
  const matches = runs.filter(
    (r) =>
      statuses.includes(r.status) &&
      r.working_path != null &&
      r.working_path.toLowerCase().includes(lower),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const ta = a.started_at ? Date.parse(a.started_at) : 0;
    const tb = b.started_at ? Date.parse(b.started_at) : 0;
    return tb - ta;
  });
  return matches[0] ?? null;
}
