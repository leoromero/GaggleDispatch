/**
 * Orchestrator in-memory state.
 *
 * Telemetry only — see the note on {@link OrchestratorState}. Durable state lives
 * in the control plane, so there is nothing here to recover or reconcile, and no
 * slot arithmetic either: the concurrency ceiling is enforced against what the
 * store says is live, not against this process's memory.
 */

import type { OrchestratorState, ServiceConfig } from '../domain/types.ts';

export function createInitialState(cfg: ServiceConfig): OrchestratorState {
  return {
    poll_interval_ms: cfg.polling.interval_ms,
    max_concurrent_agents: cfg.agent.max_concurrent_agents,
    running: new Map(),
    claude_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
  };
}

/**
 * A human-readable label for a live worker, shown on the dashboard.
 *
 * Not an identity — the target id is that. Keeping the two separate is what let
 * the `parentId__repoAlias` composite key disappear along with the in-memory maps
 * it addressed.
 */
export function buildSessionId(identifier: string, repo_alias: string, attempt: number | null): string {
  return `${identifier}__${repo_alias}__${attempt ?? 0}`;
}
