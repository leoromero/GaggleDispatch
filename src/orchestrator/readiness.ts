/**
 * Readiness predicate: is a blocker satisfied?
 *
 * Two callers, one definition. Tracker "blocks" relations use it directly;
 * `src/control/readiness.ts` uses it for sibling fan-out dependencies, reading
 * the same rules against control-plane rows instead of an in-memory map.
 *
 * The `*With` variants take only the config slice they read, which is what lets
 * the control plane depend on this without depending on `ServiceConfig`. The
 * originals delegate, so existing callers are unaffected.
 */

import type { BlockerRef, ServiceConfig } from '../domain/types.ts';

export interface BlockerLike {
  state: string | null;
  labels: string[];
}

/**
 * The slice of tracker config the readiness predicate actually reads.
 *
 * `ServiceConfig['tracker']` satisfies this structurally. It exists so callers
 * outside the orchestrator — the control plane in particular — can evaluate
 * readiness without depending on the whole `ServiceConfig`, while the predicate
 * itself stays defined in exactly one place.
 */
export interface BlockerReadinessConfig {
  terminal_states: string[];
  blocker_satisfied_states: string[];
  deploy_env_labels: Record<string, string>;
  default_ready_env: string;
  blocker_default_readiness: string;
}

function envFromReadyWhen(rw: string | undefined, cfg: BlockerReadinessConfig): string {
  if (!rw || rw === 'merged') return '';
  if (rw === 'deployed') return cfg.default_ready_env;
  const m = rw.match(/^deployed:(.+)$/i);
  return m ? m[1]!.trim() : '';
}

function hasEnvTracking(cfg: BlockerReadinessConfig): boolean {
  return Object.keys(cfg.deploy_env_labels).length > 0;
}

export function isBlockerSatisfiedWith(
  blocker: BlockerLike,
  ready_when: string,
  cfg: BlockerReadinessConfig,
): boolean {
  if (ready_when === 'merged') {
    return blocker.state !== null && cfg.terminal_states.includes(blocker.state);
  }

  const env = envFromReadyWhen(ready_when, cfg);
  const requiredLabel = cfg.deploy_env_labels[env];
  if (requiredLabel && blocker.labels.includes(requiredLabel.toLowerCase())) return true;
  if (blocker.state !== null && cfg.blocker_satisfied_states.includes(blocker.state)) return true;
  if (!hasEnvTracking(cfg)) {
    return blocker.state !== null && cfg.terminal_states.includes(blocker.state);
  }
  return false;
}

export function blockersSatisfiedWith(
  blocked_by: BlockerRef[],
  cfg: BlockerReadinessConfig,
): boolean {
  if (blocked_by.length === 0) return true;
  for (const b of blocked_by) {
    const blockerLike: BlockerLike = {
      state: b.state ?? null,
      labels: (b.labels ?? []).map((l) => l.toLowerCase()),
    };
    if (!isBlockerSatisfiedWith(blockerLike, cfg.blocker_default_readiness, cfg)) {
      return false;
    }
  }
  return true;
}

export function isBlockerSatisfied(blocker: BlockerLike, ready_when: string, cfg: ServiceConfig): boolean {
  return isBlockerSatisfiedWith(blocker, ready_when, cfg.tracker);
}

export function blockersSatisfied(blocked_by: BlockerRef[], cfg: ServiceConfig): boolean {
  return blockersSatisfiedWith(blocked_by, cfg.tracker);
}

// `repoTargetReady` lived here, resolving sibling dependencies against the
// orchestrator's in-memory `sibling_subissues` / `subissue_snapshot` maps. Those
// maps are gone: sibling status is a column now, so the equivalent is
// `evaluateReadiness` in src/control/readiness.ts, which reuses the predicates
// above rather than restating the rules.
