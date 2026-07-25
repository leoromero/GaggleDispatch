/**
 * Per-run status poller.
 *
 * Under the Archon integration this was the *primary* way the orchestrator
 * learned anything — it polled an HTTP API because the executor was a separate
 * process. The engine emits events directly now, so a live run needs no poller
 * at all.
 *
 * What still needs one: runs adopted after a restart. The orchestrator comes
 * up, finds a run that some earlier process started, and has no in-process
 * event stream for it. Polling the store is how it follows that run to a
 * conclusion.
 *
 * Emits the same event shape as before, so the orchestrator's handlers are
 * unchanged.
 */

import { logger } from '../util/logger.ts';
import type { ExecutorClient } from './client.ts';
import type { RunRecord, RunStatus } from './types.ts';

export type RunPollEvent =
  /** The run is alive; carries the latest record. */
  | { type: 'poller_heartbeat'; record: RunRecord }
  /** Waiting on a human. */
  | { type: 'poller_gate_paused'; run_id: string; gate_message: string; record: RunRecord }
  | { type: 'poller_completed'; record: RunRecord }
  | { type: 'poller_failed'; status: RunStatus; record: RunRecord }
  /** No activity for longer than stallTimeoutMs. Informational. */
  | { type: 'poller_stalled'; last_activity_at: string | null }
  | { type: 'poller_run_not_found' };

const TERMINAL: RunStatus[] = ['completed', 'failed', 'cancelled'];

export interface RunPollerOptions {
  pollIntervalMs?: number;
  /** 0 disables stall detection. */
  stallTimeoutMs?: number;
  maxMissingPolls?: number;
  initialDelayMs?: number;
}

export class RunPoller {
  private readonly client: ExecutorClient;
  private readonly runId: string;
  private readonly onEvent: (e: RunPollEvent) => void;
  private readonly pollIntervalMs: number;
  private readonly stallTimeoutMs: number;
  private readonly maxMissingPolls: number;
  private readonly initialDelayMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastActivityAt: string | null = null;
  private lastActivitySeenAt: number | null = null;
  private lastStatus: RunStatus | null = null;
  private missingCount = 0;

  constructor(
    client: ExecutorClient,
    runId: string,
    onEvent: (e: RunPollEvent) => void,
    opts: RunPollerOptions = {},
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
    this.schedule(this.initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;

    const record = await this.client.getRun(this.runId);
    if (!record) {
      this.missingCount++;
      if (this.missingCount >= this.maxMissingPolls) {
        this.onEvent({ type: 'poller_run_not_found' });
        this.stop();
        return;
      }
      this.schedule(this.pollIntervalMs);
      return;
    }
    this.missingCount = 0;

    // A stall means the run believes it is executing but nothing has moved.
    // `paused` and `pending` are legitimately idle and must not count, which
    // was a real source of false positives in the previous implementation.
    const now = Date.now();
    if (record.last_activity_at !== this.lastActivityAt) {
      this.lastActivityAt = record.last_activity_at;
      this.lastActivitySeenAt = now;
    } else if (
      this.stallTimeoutMs > 0 &&
      this.lastActivitySeenAt !== null &&
      record.status === 'running' &&
      now - this.lastActivitySeenAt > this.stallTimeoutMs
    ) {
      logger.warn('Run appears stalled', {
        run_id: this.runId,
        last_activity_at: this.lastActivityAt,
        stall_ms: now - this.lastActivitySeenAt,
      });
      this.onEvent({ type: 'poller_stalled', last_activity_at: this.lastActivityAt });
      // Re-arm rather than firing every tick; keep polling for the real end.
      this.lastActivitySeenAt = now;
    }

    this.onEvent({ type: 'poller_heartbeat', record });

    if (record.status !== this.lastStatus) {
      this.lastStatus = record.status;

      if (record.status === 'paused') {
        this.onEvent({
          type: 'poller_gate_paused',
          run_id: this.runId,
          gate_message: record.metadata?.approval?.message ?? '(approval gate)',
          record,
        });
        // Keep polling: the human may decide through another surface.
        this.schedule(this.pollIntervalMs);
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
    } else if (TERMINAL.includes(record.status)) {
      this.stop();
      return;
    }

    this.schedule(this.pollIntervalMs);
  }
}
