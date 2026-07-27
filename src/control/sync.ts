/**
 * Ticket sync — the tracker's only path into the system.
 *
 * This is what replaces the poll loop's dispatch half. It imports and refreshes;
 * it never starts anything. That is the whole point of the redesign, and it is
 * enforced structurally rather than by discipline: sync's only write path is
 * `upsertTicket`, whose SQL cannot touch `status`.
 *
 * Two passes, because a tracker issue that goes terminal drops out of the
 * candidate query and would otherwise be invisible:
 *
 *   1. **Discover** — the candidate query, upserted. New issues appear on the
 *      board as `imported`; known ones get fresh titles, labels, and blockers.
 *   2. **Track** — for tickets we hold that the candidate query did not return,
 *      ask the tracker about them directly. This is how a ticket closed in the
 *      tracker is noticed, and how sub-issue state reaches the target rows that
 *      env-gated readiness reads.
 *
 * Terminal handling is deliberately asymmetric: a pre-run ticket is archived, but
 * a running one only gets `external_terminal_at` set and a badge on the board.
 * Killing an in-flight run because somebody closed a tracker issue is not a
 * decision software should make on its own.
 */

import { logger } from '../util/logger.ts';
import type { TrackerIssue, TrackerReadPort } from './ports.ts';
import type { ControlService } from './service.ts';
import type { ControlStore } from './store/types.ts';
import { TICKET_TERMINAL_STATUSES, type TargetRow, type TicketRow } from './types.ts';

export interface TicketSyncConfig {
  workspace: string;
  tracker_kind: string;
  /** Tracker states that mean "no longer being worked". */
  terminal_states: string[];
  /**
   * Tracker states eligible for import. Only used to decide whether an issue
   * returned by the tracking pass has left the active set; the candidate query
   * applies the filter itself.
   */
  active_states: string[];
}

export interface TicketSyncDeps {
  store: ControlStore;
  service: ControlService;
  tracker: TrackerReadPort;
  cfg: TicketSyncConfig;
}

export interface SyncResult {
  /** Tickets that did not exist before this pass. */
  imported: number;
  /** Existing tickets whose tracker columns were refreshed. */
  refreshed: number;
  /** Pre-run tickets archived because the tracker issue went terminal. */
  archived: number;
  /** Running tickets flagged as terminal-in-tracker, but left running. */
  flagged: number;
  /** Target rows whose sub-issue state was refreshed. */
  targets_refreshed: number;
  /** Tracker issues skipped because they are a known ticket's sub-issue. */
  skipped_subissues: number;
}

const EMPTY: SyncResult = {
  imported: 0,
  refreshed: 0,
  archived: 0,
  flagged: 0,
  targets_refreshed: 0,
  skipped_subissues: 0,
};

export class TicketSync {
  constructor(private readonly deps: TicketSyncDeps) {}

  /** One full pass. Safe to call on a timer and on demand from the dashboard. */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = { ...EMPTY };

    const candidates = await this.deps.tracker.fetchCandidateIssues();
    const known = await this.loadKnown();
    const seen = new Set<string>();

    // ── pass 1: discover ────────────────────────────────────────────────
    for (const issue of candidates) {
      if (!isImportable(issue)) continue;

      // A sub-issue of a ticket we already hold is not a ticket — it is the
      // tracker's view of one of that ticket's targets. This is what retires the
      // `[alias] title` string-parsing contract the old dispatch path relied on.
      if (issue.parent_id && known.byExternalId.has(issue.parent_id)) {
        if (await this.refreshTargetFromIssue(known, issue)) result.targets_refreshed++;
        result.skipped_subissues++;
        continue;
      }

      seen.add(issue.id);
      const existed = known.byExternalId.has(issue.id);
      const ticket = await this.upsert(issue);
      if (existed) result.refreshed++;
      else result.imported++;

      await this.applyExternalState(ticket, issue.state, result);
    }

    // ── pass 2: track what the candidate query no longer returns ────────
    const stale = [...known.byExternalId.values()].filter(
      (t) => !seen.has(t.external_id) && !TICKET_TERMINAL_STATUSES.includes(t.status),
    );
    const subIssueIds = known.targetsByExternalId.size > 0 ? [...known.targetsByExternalId.keys()] : [];
    const idsToCheck = [...new Set([...stale.map((t) => t.external_id), ...subIssueIds])];

    if (idsToCheck.length > 0) {
      let tracked: TrackerIssue[] = [];
      try {
        tracked = await this.deps.tracker.fetchIssueStatesByIds(idsToCheck);
      } catch (err) {
        // A failed tracking pass must not lose the discovery pass's work.
        logger.warn('Ticket sync: tracking pass failed', { error: (err as Error).message });
        return result;
      }

      for (const issue of tracked) {
        if (known.targetsByExternalId.has(issue.id)) {
          if (await this.refreshTargetFromIssue(known, issue)) result.targets_refreshed++;
          continue;
        }
        const ticket = known.byExternalId.get(issue.id);
        if (!ticket) continue;
        // Refresh the tracker columns, but do NOT touch last_seen_at semantics by
        // pretending it was a candidate: staleness is what tells an operator the
        // issue left the tracker's active set.
        await this.upsert(issue);
        result.refreshed++;
        await this.applyExternalState(ticket, issue.state, result);
      }
    }

    logger.debug('Ticket sync complete', { ...result });
    return result;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async upsert(issue: TrackerIssue): Promise<TicketRow> {
    return this.deps.store.upsertTicket({
      workspace: this.deps.cfg.workspace,
      tracker_kind: this.deps.cfg.tracker_kind,
      external_id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      url: issue.url,
      branch_name: issue.branch_name,
      parent_external_id: issue.parent_id ?? null,
      external_state: issue.state,
      external_labels: issue.labels,
      blocked_by: issue.blocked_by,
      external_created_at: issue.created_at,
      external_updated_at: issue.updated_at,
    });
  }

  /**
   * React to the tracker state we just imported.
   *
   * `ticket` is the row as it was *before* this pass, which is what we need: the
   * decision depends on our control status, and upsert cannot have changed it.
   */
  private async applyExternalState(
    ticket: TicketRow,
    externalState: string,
    result: SyncResult,
  ): Promise<void> {
    if (!this.deps.cfg.terminal_states.includes(externalState)) return;
    if (TICKET_TERMINAL_STATUSES.includes(ticket.status)) return;

    const before = ticket.status;
    try {
      const t = await this.deps.service.externalTerminal(ticket.id);
      if (t.to === 'archived') {
        result.archived++;
        logger.info('Ticket archived — terminal in the tracker before it started', {
          identifier: ticket.identifier,
          from: before,
        });
      } else if (t.patch.external_terminal_at) {
        result.flagged++;
        logger.warn('Ticket went terminal in the tracker while running — left running for review', {
          identifier: ticket.identifier,
          status: t.to,
        });
      }
    } catch (err) {
      logger.warn('Ticket sync: could not apply the terminal transition', {
        identifier: ticket.identifier,
        error: (err as Error).message,
      });
    }
  }

  /** Copy a sub-issue's tracker state onto the target row it represents. */
  private async refreshTargetFromIssue(known: Known, issue: TrackerIssue): Promise<boolean> {
    const target = known.targetsByExternalId.get(issue.id);
    if (!target) return false;
    if (target.external_target_state === issue.state && sameLabels(target.external_target_labels, issue.labels)) {
      return false;
    }
    await this.deps.store.updateTarget(target.id, {
      external_target_state: issue.state,
      external_target_labels: issue.labels,
    });
    return true;
  }

  private async loadKnown(): Promise<Known> {
    const tickets = await this.deps.store.listTickets({ workspace: this.deps.cfg.workspace });
    const byExternalId = new Map<string, TicketRow>();
    for (const t of tickets) byExternalId.set(t.external_id, t);

    const targetsByExternalId = new Map<string, TargetRow>();
    for (const t of tickets) {
      if (TICKET_TERMINAL_STATUSES.includes(t.status)) continue;
      for (const target of await this.deps.store.listTargets(t.id)) {
        if (target.external_target_id) targetsByExternalId.set(target.external_target_id, target);
      }
    }
    return { byExternalId, targetsByExternalId };
  }
}

interface Known {
  byExternalId: Map<string, TicketRow>;
  targetsByExternalId: Map<string, TargetRow>;
}

/** A tracker row we can key on. Anything missing an id or identifier is noise. */
function isImportable(issue: TrackerIssue): boolean {
  return Boolean(issue.id && issue.identifier && issue.title && issue.state);
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((x, i) => x === sortedB[i]);
}
