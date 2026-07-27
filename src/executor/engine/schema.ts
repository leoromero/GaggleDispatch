/**
 * The workflow document model.
 *
 * Deliberately the same YAML surface Archon used, so the ~1,100 lines of
 * shipped templates load unchanged and the existing authoring documentation
 * stays accurate. Fields Archon supported but our workflows never used
 * (hooks, mcp, skills, agents, sandbox, codex) are not modelled — the loader
 * reports them as ignored rather than pretending to honour them.
 */

import type { SideEffects } from '../types.ts';

export type NodeType = 'prompt' | 'command' | 'bash' | 'script' | 'loop' | 'approval' | 'cancel';

/** Join semantics when a node has several dependencies. */
export type TriggerRule =
  | 'all_success'
  | 'one_success'
  | 'none_failed_min_one_success'
  | 'all_done';

export const TRIGGER_RULES: readonly TriggerRule[] = [
  'all_success',
  'one_success',
  'none_failed_min_one_success',
  'all_done',
] as const;

export type ScriptRuntime = 'bun' | 'uv';

export interface RetryConfig {
  max_attempts: number;
  delay_ms: number;
  /** `transient` retries only recognised transient errors; `all` also retries unknown ones. */
  on_error: 'transient' | 'all';
}

export interface LoopConfig {
  prompt: string;
  /** Completion signal to look for in the model's output. */
  until: string;
  max_iterations: number;
  /** Start each iteration from a clean session instead of threading the conversation. */
  fresh_context: boolean;
  /** Optional shell check run after each iteration; exit 0 means complete. */
  until_bash?: string;
  /** Pause between iterations for human feedback, delivered as `$LOOP_USER_INPUT`. */
  interactive: boolean;
  gate_message?: string;
}

export interface OnRejectConfig {
  prompt: string;
  max_attempts: number;
}

export interface ApprovalConfig {
  message: string;
  /** When true the approver's comment becomes `$<node-id>.output`. */
  capture_response: boolean;
  on_reject?: OnRejectConfig;
}

export interface WorkflowNode {
  id: string;
  type: NodeType;
  depends_on: string[];
  /** Condition expression; a false result skips the node. */
  when?: string;
  trigger_rule: TriggerRule;

  /** Idle timeout for AI streaming (ms). Ignored by bash/script nodes. */
  idle_timeout?: number;
  /** Total execution limit for bash/script nodes (ms). */
  timeout?: number;

  model?: string;
  provider?: string;
  context?: 'fresh' | 'shared';
  allowed_tools?: string[];
  denied_tools?: string[];
  output_format?: Record<string, unknown>;
  retry?: RetryConfig;

  /**
   * Our addition, not present in Archon. `at_most_once` nodes are never
   * silently re-run after an interruption — resume parks at a synthetic gate
   * so a human decides whether the side effect already landed.
   */
  side_effects: SideEffects;

  // Exactly one of these is set, matching `type`.
  prompt?: string;
  command?: string;
  bash?: string;
  script?: string;
  runtime?: ScriptRuntime;
  deps?: string[];
  loop?: LoopConfig;
  approval?: ApprovalConfig;
  cancel?: string;
}

export interface WorktreeSpec {
  /**
   * Pins isolation regardless of caller: `false` always uses the live
   * checkout, `true` always creates a worktree. Undefined means the caller
   * decides.
   */
  enabled?: boolean;
}

export interface WorkflowDef {
  name: string;
  description: string;
  provider?: string;
  model?: string;
  /** Required for gates to reach a human on non-CLI surfaces. */
  interactive: boolean;
  worktree?: WorktreeSpec;
  nodes: WorkflowNode[];

  /** Absolute path the document was loaded from. */
  source_path: string;
  /** sha256 over the normalized document. Guards resume against edits. */
  hash: string;
}

export interface Diagnostic {
  level: 'error' | 'warning';
  /** Node the diagnostic belongs to, when it is node-scoped. */
  node_id?: string;
  message: string;
}

export const NODE_TYPE_FIELDS: readonly NodeType[] = [
  'command',
  'prompt',
  'bash',
  'script',
  'loop',
  'approval',
  'cancel',
] as const;

/** Fields that only mean something on an AI node; noise elsewhere. */
export const AI_ONLY_FIELDS = [
  'model',
  'provider',
  'context',
  'output_format',
  'allowed_tools',
  'denied_tools',
  'hooks',
  'mcp',
  'skills',
  'agents',
  'effort',
  'thinking',
  'fallbackModel',
  'betas',
  'sandbox',
  'maxBudgetUsd',
  'systemPrompt',
] as const;
