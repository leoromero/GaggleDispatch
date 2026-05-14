/**
 * Readiness predicate (Section 7.3, 9.2, 17.4.1).
 * Used both for cross-issue blockers and for sibling fan-out dependencies.
 */

import type { BlockerRef, OrchestratorState, RepoTarget, ServiceConfig } from '../domain/types.ts';
import { workerKey } from './state.ts';

interface BlockerLike {
  state: string | null;
  labels: string[];
}

function envFromReadyWhen(rw: string | undefined, cfg: ServiceConfig): string {
  if (!rw || rw === 'merged') return '';
  if (rw === 'deployed') return cfg.tracker.default_ready_env;
  const m = rw.match(/^deployed:(.+)$/i);
  return m ? m[1]!.trim() : '';
}

function hasEnvTracking(cfg: ServiceConfig): boolean {
  return Object.keys(cfg.tracker.deploy_env_labels).length > 0;
}

export function isBlockerSatisfied(blocker: BlockerLike, ready_when: string, cfg: ServiceConfig): boolean {
  if (ready_when === 'merged') {
    return blocker.state !== null && cfg.tracker.terminal_states.includes(blocker.state);
  }

  const env = envFromReadyWhen(ready_when, cfg);
  const requiredLabel = cfg.tracker.deploy_env_labels[env];
  if (requiredLabel && blocker.labels.includes(requiredLabel.toLowerCase())) return true;
  if (blocker.state !== null && cfg.tracker.blocker_satisfied_states.includes(blocker.state)) return true;
  if (!hasEnvTracking(cfg)) {
    return blocker.state !== null && cfg.tracker.terminal_states.includes(blocker.state);
  }
  return false;
}

export function blockersSatisfied(blocked_by: BlockerRef[], cfg: ServiceConfig): boolean {
  if (blocked_by.length === 0) return true;
  for (const b of blocked_by) {
    const blockerLike: BlockerLike = {
      state: b.state ?? null,
      labels: (b.labels ?? []).map((l) => l.toLowerCase()),
    };
    if (!isBlockerSatisfied(blockerLike, cfg.tracker.blocker_default_readiness, cfg)) {
      return false;
    }
  }
  return true;
}

/** Section 7.3: target ready when every upstream sibling has reached its ready_when. */
export function repoTargetReady(
  target: RepoTarget,
  parent_issue_id: string,
  state: OrchestratorState,
  cfg: ServiceConfig,
): boolean {
  const upstream = target.depends_on ?? [];
  if (upstream.length === 0) return true;
  const readyWhen = target.ready_when ?? 'merged';

  for (const upstreamAlias of upstream) {
    const subMap = state.sibling_subissues.get(parent_issue_id);
    const subId = subMap?.get(upstreamAlias) ?? null;

    if (subId === null) {
      // Upstream not dispatched yet — but its SM state may already be succeeded.
      if (readyWhen === 'merged' && state.target_machine_states.get(workerKey(parent_issue_id, upstreamAlias)) === 'succeeded') {
        continue;
      }
      return false;
    }

    const snap = state.subissue_snapshot.get(subId);
    if (!snap) return false;
    const blockerLike: BlockerLike = { state: snap.state, labels: snap.labels.map((l) => l.toLowerCase()) };
    if (!isBlockerSatisfied(blockerLike, readyWhen, cfg)) return false;
  }
  return true;
}
