/**
 * LinearClient → control-plane tracker ports.
 *
 * Three adapters over one client, split the way the ports are split: sync gets
 * reads, the outbox drainer gets writes, and the service gets structure. That is
 * not ceremony — it is how "the tracker is a sink" stops being a convention and
 * becomes something the type system enforces. The outbox drainer is handed an
 * object with no read method, so it cannot reintroduce tracker state as an input
 * to a decision even by accident.
 */

import { logger } from '../../util/logger.ts';
import type { LinearClient } from '../../tracker/linear.ts';
import type { ServiceConfig } from '../../domain/types.ts';
import type {
  TrackerIssue,
  TrackerReadPort,
  TrackerStructurePort,
  TrackerWritePort,
} from '../ports.ts';
import type { BlockerSpec } from '../transitions.ts';
import type { TargetRow, TicketRow } from '../types.ts';

export class LinearReadAdapter implements TrackerReadPort {
  constructor(private readonly client: LinearClient) {}

  fetchCandidateIssues(): Promise<TrackerIssue[]> {
    return this.client.fetchCandidateIssues();
  }

  fetchIssueStatesByIds(ids: string[]): Promise<TrackerIssue[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.client.fetchIssueStatesByIds(ids);
  }
}

export class LinearWriteAdapter implements TrackerWritePort {
  constructor(private readonly client: LinearClient) {}

  async setState(externalId: string, state: string): Promise<void> {
    await this.client.updateIssueState(externalId, state);
  }

  async postComment(externalId: string, body: string): Promise<void> {
    await this.client.postComment(externalId, body);
  }

  async applyLabel(externalId: string, label: string): Promise<void> {
    await this.client.applyLabel(externalId, label);
  }

  async removeLabel(externalId: string, label: string): Promise<void> {
    await this.client.removeLabel(externalId, label);
  }
}

export class LinearStructureAdapter implements TrackerStructurePort {
  constructor(
    private readonly client: LinearClient,
    private readonly cfg: ServiceConfig,
  ) {}

  async createBlockerIssue(
    spec: BlockerSpec,
    blocksExternalId: string,
  ): Promise<{ external_id: string; identifier: string } | null> {
    const created = await this.client.createIssue({
      title: spec.title,
      description: spec.description || undefined,
      assignee_id: await this.viewerId(),
      state_name: this.cfg.tracker.active_states[0] ?? 'Todo',
    });
    try {
      await this.client.createBlockerRelation(created.id, blocksExternalId);
    } catch (err) {
      // The issue exists, which is the part that matters. A missing relation is
      // visible and fixable; failing here would lose the issue we just made.
      logger.warn('Blocker issue created but the relation could not be set', {
        blocker: created.identifier,
        blocks: blocksExternalId,
        error: (err as Error).message,
      });
    }
    logger.info('Blocker issue created', {
      blocker: created.identifier,
      blocks: blocksExternalId,
    });
    return { external_id: created.id, identifier: created.identifier };
  }

  async createSubIssue(args: {
    ticket: TicketRow;
    target: TargetRow;
  }): Promise<{ external_id: string; url: string | null }> {
    const created = await this.client.createSubIssue({
      parent_id: args.ticket.external_id,
      // The `[alias]` prefix is now purely cosmetic — it tells a human which repo
      // this sub-issue is for. Nothing parses it any more; the fan-out lives in
      // `ticket_targets`.
      title: `[${args.target.repo_alias}] ${args.ticket.title}`,
      description: args.target.rationale ?? undefined,
      assignee_id: await this.viewerId(),
      state_name: this.cfg.tracker.active_states[0] ?? 'Todo',
    });
    return { external_id: created.id, url: created.url };
  }

  private async viewerId(): Promise<string | null> {
    try {
      return await this.client.resolveViewerId();
    } catch {
      // Unassigned is better than not created.
      return null;
    }
  }
}
