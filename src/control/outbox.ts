/**
 * Tracker outbox drainer.
 *
 * Every tracker write is enqueued inside the transaction that decided it, then
 * sent from here. That is a change in kind, not degree, from the current
 * behaviour: today each tracker call is fired inline and its failure is logged
 * and swallowed, so a Linear outage silently loses the "moved to Done" write.
 * Here the state change commits regardless and the write retries.
 *
 * A permanently-failing write must never block work, so a row that exhausts its
 * attempt budget is dropped with an error-level log rather than retried forever.
 */

import { logger } from '../util/logger.ts';
import type { TrackerWritePort } from './ports.ts';
import { DEFAULT_OUTBOX_LEASE_MS, type ControlStore, type OutboxLease } from './store/types.ts';
import type { OutboxRow } from './types.ts';

export interface OutboxDrainerConfig {
  /** Whose rows to drain. A drainer must never send another workspace's writes. */
  workspace: string;
  /** How many rows to attempt per pass. */
  batch_size: number;
  /** Attempts before a row is discarded. */
  max_attempts: number;
  /** Identifies this drainer on the rows it claims. Diagnostic only. */
  claimed_by?: string;
  /** Lease window. Must exceed `batch_size` × the HTTP deadline — see {@link OutboxLease}. */
  lease_ms?: number;
}

export interface OutboxDrainResult {
  sent: number;
  failed: number;
  discarded: number;
}

export class OutboxDrainer {
  constructor(
    private readonly store: ControlStore,
    private readonly tracker: TrackerWritePort,
    private readonly cfg: OutboxDrainerConfig,
  ) {}

  /** Send one batch. Safe to call on every tick, and safe to run concurrently. */
  async drain(): Promise<OutboxDrainResult> {
    const discarded = await this.store.discardExhaustedOutbox(
      this.cfg.workspace,
      this.cfg.max_attempts,
    );
    if (discarded > 0) {
      logger.error('Discarded tracker writes that exhausted their retries', {
        workspace: this.cfg.workspace,
        count: discarded,
        max_attempts: this.cfg.max_attempts,
      });
    }

    let sent = 0;
    let failed = 0;

    // Claim first, commit the claim, then send — deliberately *not* in one
    // transaction. Batching the sends inside the claim's transaction also stops
    // two drainers double-posting, and that is how this was first written, but it
    // holds a pooled connection and N row locks for as long as the tracker takes
    // to answer. Against a Linear that accepted connections and never replied,
    // that was forever. The lease gives the same exclusion with none of that: it
    // survives the commit, and it expires, so a drainer that dies mid-batch
    // releases its rows on its own.
    const rows = await this.store.claimOutbox(this.cfg.workspace, this.cfg.batch_size, {
      claimed_by: this.cfg.claimed_by ?? 'gaggle',
      lease_ms: this.cfg.lease_ms ?? DEFAULT_OUTBOX_LEASE_MS,
    });

    for (const row of rows) {
      try {
        await this.send(row);
        await this.store.markOutboxSent(row.id);
        sent++;
      } catch (err) {
        const message = (err as Error).message;
        await this.store.markOutboxFailed(row.id, message);
        failed++;
        logger.warn('Tracker write failed; will retry', {
          outbox_id: row.id,
          op: row.op,
          external_id: row.external_id,
          attempts: row.attempts + 1,
          error: message,
        });
      }
    }

    return { sent, failed, discarded };
  }

  private async send(row: OutboxRow): Promise<void> {
    switch (row.op) {
      case 'set_state': {
        const state = requireString(row, 'state');
        await this.tracker.setState(row.external_id, state);
        return;
      }
      case 'post_comment': {
        const body = requireString(row, 'body');
        await this.tracker.postComment(row.external_id, body);
        return;
      }
      case 'apply_label': {
        const label = requireString(row, 'label');
        await this.tracker.applyLabel(row.external_id, label);
        return;
      }
      case 'remove_label': {
        const label = requireString(row, 'label');
        await this.tracker.removeLabel(row.external_id, label);
        return;
      }
      default: {
        const exhaustive: never = row.op;
        throw new Error(`Unknown outbox op: ${String(exhaustive)}`);
      }
    }
  }
}

/**
 * A malformed payload is a bug, and retrying it forever would hide the bug while
 * blocking nothing else. Throwing routes it through the normal retry-then-discard
 * path, where the error text lands in `last_error` for diagnosis.
 */
function requireString(row: OutboxRow, key: string): string {
  const v = row.payload[key];
  if (typeof v !== 'string') {
    throw new Error(`outbox row ${row.id} (${row.op}) has no string '${key}' in its payload`);
  }
  return v;
}
