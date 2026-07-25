/**
 * Startup recovery for runs whose executor died.
 *
 * A run is "crashed" when it is still marked `running` but its lease has
 * lapsed — the heartbeat stopped, so nothing is driving it. This sweep reclaims
 * those runs.
 *
 * The interesting decision is what to do with a node that was mid-flight. An
 * idempotent node can simply be re-run. A node marked `at_most_once` cannot:
 * it may have opened a pull request, pushed a commit, or posted a comment
 * before the process died, and there is no way to tell from here. Re-running
 * it could duplicate the effect; skipping it could silently drop the work.
 * Neither is a decision this code should make, so the run parks at a synthetic
 * gate and a human decides. That is the whole point of the marker.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { logger } from '../../util/logger.ts';
import type { NodeRow, Store } from '../store/types.ts';
import type { RunEventHandler } from '../types.ts';
import type { GaggleExecutor } from './index.ts';

export type RecoveryAction =
  | 'resumed'
  | 'parked_for_review'
  | 'marked_interrupted'
  | 'skipped_leased'
  | 'resume_failed';

export interface RecoveryResult {
  run_id: string;
  workflow_name: string;
  action: RecoveryAction;
  interrupted_nodes: string[];
  detail?: string;
}

export interface RecoveryOptions {
  store: Store;
  executor: GaggleExecutor;
  /**
   * Restart recovered runs immediately. When false the run is left
   * `interrupted` for the caller to resume on its own schedule.
   */
  autoResume?: boolean;
  onEvent?: RunEventHandler;
  /** Lease TTL used when claiming a reclaimed run. */
  leaseTtlMs?: number;
}

const OWNER = `${hostname()}:${process.pid}`;

/** Message shown when an at_most_once node was interrupted mid-flight. */
export function buildAtMostOnceGateMessage(nodes: NodeRow[]): string {
  const names = nodes.map((n) => `'${n.node_id}'`).join(', ');
  return [
    `This run was interrupted while ${nodes.length > 1 ? 'nodes' : 'a node'} ${names} ${
      nodes.length > 1 ? 'were' : 'was'
    } running.`,
    '',
    `${nodes.length > 1 ? 'Those nodes are' : 'That node is'} marked \`at_most_once\`, so it may` +
      ' already have had an effect outside this run — opened a pull request, pushed a commit, or' +
      ' posted a comment — and re-running could duplicate it.',
    '',
    'Approve to re-run it anyway. Reject to abandon the run.',
  ].join('\n');
}

export async function recoverInterruptedRuns(opts: RecoveryOptions): Promise<RecoveryResult[]> {
  const { store, executor } = opts;
  const leaseTtl = opts.leaseTtlMs ?? 60_000;
  const expired = await store.findExpiredRuns();
  if (expired.length === 0) return [];

  logger.info('Found runs with a lapsed lease', { count: expired.length });
  const results: RecoveryResult[] = [];

  for (const run of expired) {
    // Claim it first. If another process got there, leave it alone — two
    // executors driving one run would interleave node writes.
    const claimed = await store.acquireLease(run.id, OWNER, leaseTtl);
    if (!claimed) {
      results.push({
        run_id: run.id,
        workflow_name: run.workflow_name,
        action: 'skipped_leased',
        interrupted_nodes: [],
      });
      continue;
    }

    const interrupted = await store.markRunningNodesInterrupted(run.id);
    const nodeIds = interrupted.map((n) => n.node_id);
    const unsafe = interrupted.filter((n) => n.side_effects === 'at_most_once');

    await store.appendEvent(run.id, 'run_interrupted', null, {
      interrupted_nodes: nodeIds,
      at_most_once: unsafe.map((n) => n.node_id),
    });

    if (unsafe.length > 0) {
      const message = buildAtMostOnceGateMessage(unsafe);
      // A gate may already exist if the crash happened while parked.
      const existing = await store.getPendingApproval(run.id);
      if (!existing) {
        await store.createApproval({
          id: randomUUID(),
          run_id: run.id,
          node_id: unsafe[0]!.node_id,
          message,
        });
      }
      await store.updateRun(run.id, {
        status: 'paused',
        metadata: {
          approval: { nodeId: unsafe[0]!.node_id, message },
          interrupted_reason: 'executor died while an at_most_once node was running',
        },
      });
      await store.releaseLease(run.id, OWNER);

      logger.warn('Recovered run parked for human review', {
        run_id: run.id,
        nodes: unsafe.map((n) => n.node_id),
      });
      results.push({
        run_id: run.id,
        workflow_name: run.workflow_name,
        action: 'parked_for_review',
        interrupted_nodes: nodeIds,
        detail: message,
      });
      continue;
    }

    await store.updateRun(run.id, {
      status: 'interrupted',
      metadata: { interrupted_reason: 'executor died; lease expired' },
    });
    await store.releaseLease(run.id, OWNER);

    if (!opts.autoResume) {
      results.push({
        run_id: run.id,
        workflow_name: run.workflow_name,
        action: 'marked_interrupted',
        interrupted_nodes: nodeIds,
      });
      continue;
    }

    try {
      const handle = await executor.resumeRun(run.id, opts.onEvent ?? (() => {}));
      logger.info('Recovered run resumed', { run_id: run.id, interrupted_nodes: nodeIds });
      // Deliberately not awaited: recovery should not block startup on a
      // workflow that may run for twenty minutes.
      void handle.done;
      results.push({
        run_id: run.id,
        workflow_name: run.workflow_name,
        action: 'resumed',
        interrupted_nodes: nodeIds,
      });
    } catch (err) {
      logger.warn('Could not resume a recovered run', {
        run_id: run.id,
        error: (err as Error).message,
      });
      results.push({
        run_id: run.id,
        workflow_name: run.workflow_name,
        action: 'resume_failed',
        interrupted_nodes: nodeIds,
        detail: (err as Error).message,
      });
    }
  }

  return results;
}
