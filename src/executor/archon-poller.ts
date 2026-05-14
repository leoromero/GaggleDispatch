/**
 * Per-run HTTP poller for Archon workflow status (Section 11.2).
 *
 * After a run is launched and its DB run-id is captured, an ArchonRunPoller
 * is attached to that session. It polls GET /api/workflows/runs/:id on a
 * fixed interval and emits typed events. The orchestrator reacts to those
 * events instead of relying on subprocess output to infer state.
 *
 * Responsibilities:
 *   - Status change detection (running → paused / completed / failed)
 *   - Gate pause detection (status === 'paused')
 *   - Stall detection (last_activity_at unchanged for > stallTimeoutMs)
 *   - Activity heartbeat (updates session timestamp on each poll)
 *
 * NOT responsible for: approve/reject actions, label management, retries.
 * Those belong to the orchestrator.
 */

import { logger } from '../util/logger.ts';
import type { ArchonClient, ArchonRunRecord, ArchonRunStatus } from './archon-client.ts';

// ─── Event types ─────────────────────────────────────────────────────────────

export type ArchonPollEvent =
  /** Emitted on each poll when the run is still alive; carries the latest API record. */
  | { type: 'poller_heartbeat'; record: ArchonRunRecord }
  /** Run reached status 'paused' — gate requires human input. */
  | { type: 'poller_gate_paused'; run_id: string; gate_message: string; record: ArchonRunRecord }
  /** Run reached status 'completed'. */
  | { type: 'poller_completed'; record: ArchonRunRecord }
  /** Run reached a non-recoverable terminal status (failed / cancelled). */
  | { type: 'poller_failed'; status: ArchonRunStatus; record: ArchonRunRecord }
  /** No activity seen from the API for longer than stallTimeoutMs. */
  | { type: 'poller_stalled'; last_activity_at: string | null }
  /** Run ID could not be resolved after maxMissingPolls attempts. */
  | { type: 'poller_run_not_found' };

const TERMINAL_STATUSES: ArchonRunStatus[] = ['completed', 'failed', 'cancelled'];

export interface ArchonRunPollerOptions {
  /** How often to poll. Default 5 s. */
  pollIntervalMs?: number;
  /** If last_activity_at is unchanged for this long, emit poller_stalled. 0 = disabled. */
  stallTimeoutMs?: number;
  /** How many consecutive 404s before emitting poller_run_not_found. Default 3. */
  maxMissingPolls?: number;
  /**
   * Delay before the first poll fires. Default 0 (poll immediately on start).
   * Used by the post-approve flow: when we re-attach after `archon workflow
   * approve`, Archon's run record briefly shows a terminal status mid-handoff
   * (the paused-run gets marked failed before the resumed-run takes over).
   * A short initial delay skips that transient state.
   */
  initialDelayMs?: number;
}

export class ArchonRunPoller {
  private readonly client: ArchonClient;
  private readonly runId: string;
  private readonly pollIntervalMs: number;
  private readonly stallTimeoutMs: number;
  private readonly maxMissingPolls: number;
  private readonly initialDelayMs: number;
  private readonly onEvent: (e: ArchonPollEvent) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastActivityAt: string | null = null;
  private lastActivitySeenAt: number | null = null; // wall-clock when we last saw a change
  private lastStatus: ArchonRunStatus | null = null;
  private missingCount = 0;

  constructor(
    client: ArchonClient,
    runId: string,
    onEvent: (e: ArchonPollEvent) => void,
    opts: ArchonRunPollerOptions = {},
  ) {
    this.client = client;
    this.runId = runId;
    this.onEvent = onEvent;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? 0;
    this.maxMissingPolls = opts.maxMissingPolls ?? 3;
    this.initialDelayMs = opts.initialDelayMs ?? 0;
  }

  start(): void {
    if (this.stopped) return;
    this.scheduleNext(this.initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;

    const detail = await this.client.getRunDetail(this.runId);

    if (!detail) {
      this.missingCount++;
      logger.debug('Archon run not found during poll', {
        run_id: this.runId,
        missing_count: this.missingCount,
      });
      if (this.missingCount >= this.maxMissingPolls) {
        this.onEvent({ type: 'poller_run_not_found' });
        this.stop();
        return;
      }
      this.scheduleNext(this.pollIntervalMs);
      return;
    }

    this.missingCount = 0;
    const record = detail.run;

    // Track activity for stall detection.
    //
    // Stall = `last_activity_at` is frozen AND the daemon thinks the run is
    // actively executing (status === 'running'). Other statuses are legitimate
    // idle states:
    //   - 'paused'  → at an approval gate, waiting for human input
    //   - 'pending' → run queued in the daemon but not yet started
    // Counting those as stalls produced false positives that killed our local
    // watcher subprocess while real Archon work was either parked at a gate
    // or doing a long Claude tool call.
    const newActivity = record.last_activity_at;
    const now = Date.now();
    if (newActivity !== this.lastActivityAt) {
      this.lastActivityAt = newActivity;
      this.lastActivitySeenAt = now;
    } else if (
      this.stallTimeoutMs > 0 &&
      this.lastActivitySeenAt !== null &&
      record.status === 'running' &&
      now - this.lastActivitySeenAt > this.stallTimeoutMs
    ) {
      logger.warn('Archon run stalled (no API activity)', {
        run_id: this.runId,
        last_activity_at: this.lastActivityAt,
        stall_ms: now - this.lastActivitySeenAt,
      });
      this.onEvent({ type: 'poller_stalled', last_activity_at: this.lastActivityAt });
      // Re-arm the stall timer so we don't spam the event every poll tick — the
      // orchestrator now treats stall as informational and we still want to
      // continue polling to catch the real terminal status when it lands.
      this.lastActivitySeenAt = now;
    }

    // Emit heartbeat so the orchestrator can update its session timestamp.
    this.onEvent({ type: 'poller_heartbeat', record });

    // Status change handling.
    if (record.status !== this.lastStatus) {
      this.lastStatus = record.status;

      if (record.status === 'paused') {
        const gateMsg =
          (record.metadata?.approval as { message?: string } | undefined)?.message ??
          '(approval gate — see Archon UI)';
        this.onEvent({
          type: 'poller_gate_paused',
          run_id: this.runId,
          gate_message: gateMsg,
          record,
        });
        // Keep polling while paused — the human might approve/reject via Archon UI directly.
        this.scheduleNext(this.pollIntervalMs);
        return;
      }

      if (record.status === 'completed') {
        this.onEvent({ type: 'poller_completed', record });
        this.stop();
        return;
      }

      if (record.status === 'failed' || record.status === 'cancelled') {
        this.onEvent({ type: 'poller_failed', status: record.status, record });
        this.stop();
        return;
      }
    } else if (TERMINAL_STATUSES.includes(record.status)) {
      // Already emitted for this terminal status; just stop.
      this.stop();
      return;
    }

    this.scheduleNext(this.pollIntervalMs);
  }
}
