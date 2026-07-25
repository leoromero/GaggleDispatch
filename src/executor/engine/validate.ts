/**
 * Graph-level validation, run over an already-normalized WorkflowDef.
 *
 * The loader catches shape problems in a single node; this catches the ones
 * that only exist between nodes — cycles, dangling dependencies, and output
 * references that can never resolve. All of them are cheap to detect here and
 * expensive to discover twenty minutes into a run.
 */

import type { Diagnostic, WorkflowDef, WorkflowNode } from './schema.ts';
import { conditionRefs, extractNodeRefs, parseCondition } from './conditions.ts';

export interface ValidationResult {
  errors: Diagnostic[];
  warnings: Diagnostic[];
  ok: boolean;
}

/** Every text field on a node that undergoes `$nodeId.output` substitution. */
function substitutableText(node: WorkflowNode): string[] {
  const parts: string[] = [];
  if (node.prompt) parts.push(node.prompt);
  if (node.bash) parts.push(node.bash);
  if (node.script) parts.push(node.script);
  if (node.cancel) parts.push(node.cancel);
  if (node.loop) {
    parts.push(node.loop.prompt);
    if (node.loop.until_bash) parts.push(node.loop.until_bash);
    if (node.loop.gate_message) parts.push(node.loop.gate_message);
  }
  if (node.approval) {
    parts.push(node.approval.message);
    if (node.approval.on_reject) parts.push(node.approval.on_reject.prompt);
  }
  return parts;
}

/**
 * Node ids reachable by walking `depends_on` backwards.
 *
 * A reference to a node outside this set resolves to empty at runtime, because
 * nothing guarantees it ran first — worth a warning even though Archon
 * tolerated it silently.
 */
function ancestorsOf(nodeId: string, byId: Map<string, WorkflowNode>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(byId.get(nodeId)?.depends_on ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const dep of byId.get(cur)?.depends_on ?? []) stack.push(dep);
  }
  return seen;
}

/**
 * Depth-first cycle detection. Returns the first cycle found as the path that
 * closes it, so the message can name the actual loop rather than just
 * asserting one exists.
 */
export function findCycle(nodes: WorkflowNode[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === 'done') return null;
    if (s === 'visiting') {
      const start = path.indexOf(id);
      return [...path.slice(start), id];
    }
    state.set(id, 'visiting');
    path.push(id);
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(dep)) continue; // reported separately
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };

  for (const n of nodes) {
    const cycle = visit(n.id);
    if (cycle) return cycle;
  }
  return null;
}

export interface ValidateOptions {
  /**
   * Resolves a `command:` name to a file, or returns null when it does not
   * exist. Omit to skip the check — the engine resolves commands at run time
   * against the checkout, which the validator may not have.
   */
  resolveCommand?: (name: string) => string | null;
}

export function validateWorkflow(def: WorkflowDef, opts: ValidateOptions = {}): ValidationResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

  // ── unique ids ────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  for (const n of def.nodes) {
    if (seen.has(n.id)) {
      errors.push({ level: 'error', node_id: n.id, message: `duplicate node id '${n.id}'` });
    }
    seen.add(n.id);
  }
  const byId = new Map(def.nodes.map((n) => [n.id, n]));

  // ── dependencies resolve ──────────────────────────────────────────────────
  for (const n of def.nodes) {
    for (const dep of n.depends_on) {
      if (dep === n.id) {
        errors.push({ level: 'error', node_id: n.id, message: `node depends on itself` });
      } else if (!byId.has(dep)) {
        errors.push({
          level: 'error',
          node_id: n.id,
          message: `depends_on references unknown node '${dep}'${suggest(dep, [...byId.keys()])}`,
        });
      }
    }
  }

  // ── acyclic ───────────────────────────────────────────────────────────────
  const cycle = findCycle(def.nodes);
  if (cycle) {
    errors.push({ level: 'error', message: `dependency cycle: ${cycle.join(' -> ')}` });
  }

  // ── output references ─────────────────────────────────────────────────────
  for (const n of def.nodes) {
    // A cyclic graph makes ancestry meaningless; skip to avoid noise.
    const ancestors = cycle ? null : ancestorsOf(n.id, byId);

    const check = (refs: ReturnType<typeof extractNodeRefs>, where: string) => {
      for (const ref of refs) {
        if (ref.node_id === n.id) {
          errors.push({
            level: 'error',
            node_id: n.id,
            message: `${where} references its own output ($${ref.node_id}.output)`,
          });
          continue;
        }
        if (!byId.has(ref.node_id)) {
          errors.push({
            level: 'error',
            node_id: n.id,
            message: `${where} references unknown node '$${ref.node_id}.output'${suggest(
              ref.node_id,
              [...byId.keys()],
            )}`,
          });
          continue;
        }
        if (ancestors && !ancestors.has(ref.node_id)) {
          warnings.push({
            level: 'warning',
            node_id: n.id,
            message:
              `${where} references '$${ref.node_id}.output' but '${ref.node_id}' is not an ` +
              `upstream dependency — it will substitute as empty. Add it to depends_on.`,
          });
        }
        const upstream = byId.get(ref.node_id);
        if (ref.field && upstream && !upstream.output_format) {
          warnings.push({
            level: 'warning',
            node_id: n.id,
            message:
              `${where} reads field '.${ref.field}' from '${ref.node_id}', which declares no ` +
              `output_format — the field resolves as empty unless that node prints JSON.`,
          });
        }
      }
    };

    if (n.when) {
      const parsed = parseCondition(n.when);
      if (parsed.error) {
        errors.push({
          level: 'error',
          node_id: n.id,
          message: `invalid when expression: ${parsed.error}`,
        });
      }
      check(conditionRefs(n.when), 'when');
    }
    for (const text of substitutableText(n)) check(extractNodeRefs(text), 'body');
  }

  // ── command files exist ───────────────────────────────────────────────────
  if (opts.resolveCommand) {
    for (const n of def.nodes) {
      if (n.type !== 'command' || !n.command) continue;
      if (opts.resolveCommand(n.command) === null) {
        errors.push({
          level: 'error',
          node_id: n.id,
          message: `command '${n.command}' was not found in .gaggle/commands/ or the bundled library`,
        });
      }
    }
  }

  return { errors, warnings, ok: errors.length === 0 };
}

/** "did you mean" hint using a cheap edit-distance cutoff. */
function suggest(needle: string, candidates: string[]): string {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = editDistance(needle, c);
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  // Only offer a suggestion when it is plausibly a typo rather than a
  // different word entirely.
  if (best && bestScore <= Math.max(2, Math.floor(needle.length / 3))) {
    return ` — did you mean '${best}'?`;
  }
  return '';
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}
