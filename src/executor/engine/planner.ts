/**
 * Deciding what runs next.
 *
 * The planner is pure: given the graph and the current status of every node,
 * it says which nodes are ready, which should be skipped, and whether the run
 * is finished. Keeping the scheduling decision free of I/O is what makes the
 * interesting cases — diamond joins, skip propagation, trigger rules — cheap
 * to test exhaustively.
 */

import type { NodeStatus } from '../types.ts';
import type { TriggerRule, WorkflowNode } from './schema.ts';

/** A node that will not change state again. */
export type SettledStatus = 'completed' | 'failed' | 'skipped' | 'cancelled';

const SETTLED: readonly NodeStatus[] = ['completed', 'failed', 'skipped', 'cancelled'] as const;

export function isSettled(status: NodeStatus): boolean {
  return SETTLED.includes(status);
}

/** Node states as the planner sees them, keyed by node id. */
export type NodeStateMap = Map<string, NodeStatus>;

/**
 * Group nodes into dependency layers. Everything in a layer can run
 * concurrently.
 *
 * Used for display and for the dry-run explainer; the actual scheduler is
 * driven by `readyNodes`, which is finer-grained — it starts a node the moment
 * its own dependencies settle rather than waiting for a whole layer.
 */
export function topologicalLayers(nodes: WorkflowNode[]): string[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const remaining = new Set(nodes.map((n) => n.id));
  const placed = new Set<string>();
  const layers: string[][] = [];

  while (remaining.size > 0) {
    const layer = [...remaining].filter((id) =>
      (byId.get(id)?.depends_on ?? []).every((d) => !byId.has(d) || placed.has(d)),
    );
    // A cycle would leave every remaining node blocked. The validator rejects
    // cycles, so this is a guard against being called on an invalid graph.
    if (layer.length === 0) break;
    layers.push(layer);
    for (const id of layer) {
      remaining.delete(id);
      placed.add(id);
    }
  }
  return layers;
}

/**
 * Whether a node's join condition is met, given the statuses of its
 * dependencies. Only called once every dependency has settled.
 */
export function triggerSatisfied(rule: TriggerRule, depStatuses: NodeStatus[]): boolean {
  if (depStatuses.length === 0) return true;
  const succeeded = depStatuses.filter((s) => s === 'completed').length;
  const failed = depStatuses.filter((s) => s === 'failed' || s === 'cancelled').length;

  switch (rule) {
    case 'all_success':
      return succeeded === depStatuses.length;
    case 'one_success':
      return succeeded >= 1;
    case 'none_failed_min_one_success':
      return failed === 0 && succeeded >= 1;
    case 'all_done':
      // Every dependency settled, which the caller already established.
      return true;
    default:
      return false;
  }
}

export interface SkipDecision {
  node_id: string;
  reason: string;
}

export interface PlanStep {
  /** Nodes whose dependencies are satisfied and which should start now. */
  ready: string[];
  /** Nodes that can never run and should be marked skipped. */
  skip: SkipDecision[];
  /** True when no node is running and none can become ready. */
  finished: boolean;
}

export interface PlanInput {
  nodes: WorkflowNode[];
  states: NodeStateMap;
  /**
   * Evaluates a node's `when:` expression. Separate from the planner so
   * condition evaluation can read node outputs, which the planner does not
   * carry. Returns null when the node has no condition.
   */
  evaluateWhen: (node: WorkflowNode) => { value: boolean; error: string | null } | null;
}

/**
 * One scheduling decision over the whole graph.
 *
 * Called after every node transition. Idempotent — asking twice with the same
 * states gives the same answer, so the caller can re-plan freely.
 */
export function plan(input: PlanInput): PlanStep {
  const { nodes, states, evaluateWhen } = input;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const statusOf = (id: string): NodeStatus => states.get(id) ?? 'pending';

  const ready: string[] = [];
  const skip: SkipDecision[] = [];
  let anyRunning = false;
  let anyPending = false;

  for (const node of nodes) {
    const status = statusOf(node.id);
    if (status === 'running') {
      anyRunning = true;
      continue;
    }
    if (isSettled(status)) continue;
    anyPending = true;

    const deps = node.depends_on.filter((d) => byId.has(d));
    const depStatuses = deps.map(statusOf);

    // Wait until every dependency has settled. `all_done` is no exception:
    // it means "all terminal", not "don't wait".
    if (!depStatuses.every(isSettled)) continue;

    if (!triggerSatisfied(node.trigger_rule, depStatuses)) {
      const summary = deps.map((d, i) => `${d}=${depStatuses[i]}`).join(', ');
      skip.push({
        node_id: node.id,
        reason: `trigger_rule '${node.trigger_rule}' not satisfied (${summary})`,
      });
      continue;
    }

    if (node.when) {
      const verdict = evaluateWhen(node);
      if (verdict && !verdict.value) {
        skip.push({
          node_id: node.id,
          reason: verdict.error
            ? `when expression could not be evaluated (${verdict.error}) — skipping, fail-closed`
            : `when expression is false: ${node.when}`,
        });
        continue;
      }
    }

    ready.push(node.id);
  }

  return {
    ready,
    skip,
    // Finished only when nothing is in flight and nothing new can start. A
    // graph with pending nodes but no ready ones and nothing running would
    // deadlock, which the cycle check upstream rules out.
    finished: !anyRunning && ready.length === 0 && skip.length === 0 && !anyPending,
  };
}

/**
 * Overall run outcome once every node has settled.
 *
 * A run fails if any node failed. Skipped nodes are not failures — a branch
 * not taken is the normal result of a `when:` condition.
 */
export function runOutcome(states: NodeStateMap): 'succeeded' | 'failed' | 'cancelled' {
  const values = [...states.values()];
  if (values.some((s) => s === 'cancelled')) return 'cancelled';
  if (values.some((s) => s === 'failed')) return 'failed';
  return 'succeeded';
}
