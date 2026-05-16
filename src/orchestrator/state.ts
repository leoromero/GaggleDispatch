import type { OrchestratorState, ServiceConfig } from '../domain/types.ts';

export function createInitialState(cfg: ServiceConfig): OrchestratorState {
  return {
    poll_interval_ms: cfg.polling.interval_ms,
    max_concurrent_agents: cfg.agent.max_concurrent_agents,
    running: new Map(),
    pending_targets: new Map(),
    pending_issues: new Map(),
    supervised_gates: new Map(),
    retry_attempts: new Map(),
    analysis_cache: new Map(),
    sibling_subissues: new Map(),
    sibling_subissue_urls: new Map(),
    subissue_snapshot: new Map(),
    detached_archon_runs: new Map(),
    target_machine_states: new Map(),
    parent_machine_states: new Map(),
    failed_targets: new Map(),
    claude_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
  };
}

export function workerKey(issue_id: string, repo_alias: string): string {
  return `${issue_id}__${repo_alias}`;
}

export function buildSessionId(identifier: string, repo_alias: string, attempt: number | null): string {
  return `${identifier}__${repo_alias}__${attempt ?? 0}`;
}

export function availableSlots(state: OrchestratorState): number {
  return Math.max(state.max_concurrent_agents - state.running.size, 0);
}

export function noRunningWorkersFor(state: OrchestratorState, issue_id: string): boolean {
  for (const key of state.running.keys()) {
    if (key.startsWith(issue_id + '__')) return false;
  }
  return true;
}

export function noRetryEntriesFor(state: OrchestratorState, issue_id: string): boolean {
  for (const key of state.retry_attempts.keys()) {
    if (key.startsWith(issue_id + '__')) return false;
  }
  return true;
}
