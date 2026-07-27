/**
 * Is a target dispatchable?
 *
 * Two independent gates, both of which must pass:
 *
 *   1. **Ticket-level blockers** — tracker "blocks" relations, imported into
 *      `tickets.blocked_by` by sync.
 *   2. **Sibling dependencies** — `depends_on` aliases within the same fan-out,
 *      each satisfied to the target's `ready_when` level.
 *
 * The predicate itself is the orchestrator's, unchanged and imported rather than
 * reimplemented: the deploy-label and terminal-state rules are subtle and there
 * must be exactly one copy of them. What changes is where the inputs come from —
 * a database row instead of a live tracker response and an in-memory map.
 */

import {
  blockersSatisfiedWith,
  isBlockerSatisfiedWith,
  type BlockerReadinessConfig,
} from '../orchestrator/readiness.ts';
import type { TargetRow, TicketRow } from './types.ts';

export interface ReadinessResult {
  ready: boolean;
  /** Why not, for the board. Empty when ready. */
  reason: string;
}

const READY: ReadinessResult = { ready: false, reason: '' };

export function evaluateReadiness(
  ticket: TicketRow,
  target: TargetRow,
  siblings: readonly TargetRow[],
  cfg: BlockerReadinessConfig,
): ReadinessResult {
  if (!blockersSatisfiedWith(ticket.blocked_by, cfg)) {
    const names = ticket.blocked_by
      .map((b) => b.identifier ?? b.id ?? 'unknown')
      .join(', ');
    return { ready: false, reason: `blocked by ${names}` };
  }

  const upstream = target.depends_on;
  if (upstream.length === 0) return { ...READY, ready: true };

  const readyWhen = target.ready_when ?? 'merged';

  for (const alias of upstream) {
    const sibling = siblings.find((s) => s.repo_alias === alias);
    if (!sibling) {
      return { ready: false, reason: `depends on ${alias}, which is not in the fan-out` };
    }
    if (sibling.status === 'excluded') {
      // An excluded upstream can never succeed, so this target can never run.
      // Surfacing it is better than leaving the operator staring at `blocked`.
      return { ready: false, reason: `depends on ${alias}, which is excluded` };
    }
    if (sibling.status !== 'succeeded') {
      return { ready: false, reason: `waiting on ${alias} (${sibling.status})` };
    }
    if (readyWhen === 'merged') continue;

    // Env-gated readiness needs the upstream's tracker state. For a target with
    // its own sub-issue that is the synced sub-issue row; for a mono-repo target
    // the ticket itself is the tracker issue.
    const state = sibling.external_target_state ?? ticket.external_state;
    const labels = sibling.external_target_id
      ? sibling.external_target_labels
      : ticket.external_labels;
    if (!isBlockerSatisfiedWith({ state, labels: labels.map((l) => l.toLowerCase()) }, readyWhen, cfg)) {
      return { ready: false, reason: `waiting on ${alias} to reach '${readyWhen}'` };
    }
  }

  return { ...READY, ready: true };
}
