/**
 * Workflow YAML → WorkflowDef.
 *
 * Parsing is separated from validation: this file's job is to turn loosely
 * typed YAML into a normalized document with every default filled in, and to
 * report shape problems it cannot recover from. Graph-level rules (cycles,
 * dangling references) live in validate.ts and run over the normalized form.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import * as YAML from 'yaml';
import type { SideEffects } from '../types.ts';
import {
  AI_ONLY_FIELDS,
  NODE_TYPE_FIELDS,
  TRIGGER_RULES,
  type Diagnostic,
  type LoopConfig,
  type NodeType,
  type RetryConfig,
  type ScriptRuntime,
  type TriggerRule,
  type WorkflowDef,
  type WorkflowNode,
} from './schema.ts';

export class WorkflowLoadError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'WorkflowLoadError';
    this.diagnostics = diagnostics;
  }
}

export interface LoadResult {
  workflow: WorkflowDef;
  /** Non-fatal findings — ignored fields, suspicious combinations. */
  warnings: Diagnostic[];
}

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

/**
 * A `script:` value is inline code when it contains a newline or any shell
 * metacharacter; otherwise it names a file under `.gaggle/scripts/`. Same rule
 * Archon used, so existing workflows keep resolving the same way.
 */
export function isInlineScript(value: string): boolean {
  return /[\n\s;(){}&|<>$`"']/.test(value);
}

function parseRetry(v: unknown, nodeId: string, errors: Diagnostic[]): RetryConfig | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isRecord(v)) {
    errors.push({ level: 'error', node_id: nodeId, message: 'retry must be a map' });
    return undefined;
  }
  const max = num(v.max_attempts);
  if (max === undefined || max < 1 || max > 5) {
    errors.push({
      level: 'error',
      node_id: nodeId,
      message: 'retry.max_attempts is required and must be between 1 and 5',
    });
    return undefined;
  }
  const delay = num(v.delay_ms) ?? 3000;
  if (delay < 1000 || delay > 60_000) {
    errors.push({
      level: 'error',
      node_id: nodeId,
      message: 'retry.delay_ms must be between 1000 and 60000',
    });
    return undefined;
  }
  const onError = str(v.on_error) ?? 'transient';
  if (onError !== 'transient' && onError !== 'all') {
    errors.push({
      level: 'error',
      node_id: nodeId,
      message: `retry.on_error must be 'transient' or 'all', got '${onError}'`,
    });
    return undefined;
  }
  return { max_attempts: Math.trunc(max), delay_ms: Math.trunc(delay), on_error: onError };
}

function parseLoop(v: unknown, nodeId: string, errors: Diagnostic[]): LoopConfig | undefined {
  if (!isRecord(v)) {
    errors.push({ level: 'error', node_id: nodeId, message: 'loop must be a map' });
    return undefined;
  }
  const prompt = str(v.prompt);
  const until = str(v.until);
  const maxIterations = num(v.max_iterations);
  if (!prompt?.trim()) {
    errors.push({ level: 'error', node_id: nodeId, message: 'loop.prompt is required' });
  }
  if (!until?.trim()) {
    errors.push({ level: 'error', node_id: nodeId, message: 'loop.until is required' });
  }
  if (maxIterations === undefined || maxIterations < 1) {
    errors.push({
      level: 'error',
      node_id: nodeId,
      message: 'loop.max_iterations is required and must be >= 1',
    });
  }
  const interactive = bool(v.interactive, false);
  const gateMessage = str(v.gate_message);
  if (interactive && !gateMessage?.trim()) {
    // Archon validated this at parse time too: an interactive loop with no
    // gate message pauses with nothing to show the human.
    errors.push({
      level: 'error',
      node_id: nodeId,
      message: 'loop.gate_message is required when loop.interactive is true',
    });
  }
  return {
    prompt: prompt ?? '',
    until: until ?? '',
    max_iterations: maxIterations === undefined ? 1 : Math.trunc(maxIterations),
    fresh_context: bool(v.fresh_context, false),
    until_bash: str(v.until_bash),
    interactive,
    gate_message: gateMessage,
  };
}

function parseApproval(v: unknown, nodeId: string, errors: Diagnostic[]) {
  if (!isRecord(v)) {
    errors.push({ level: 'error', node_id: nodeId, message: 'approval must be a map' });
    return undefined;
  }
  const message = str(v.message);
  if (!message?.trim()) {
    errors.push({ level: 'error', node_id: nodeId, message: 'approval.message is required and must be non-empty' });
  }
  let onReject;
  if (v.on_reject !== undefined && v.on_reject !== null) {
    if (!isRecord(v.on_reject)) {
      errors.push({ level: 'error', node_id: nodeId, message: 'approval.on_reject must be a map' });
    } else {
      const prompt = str(v.on_reject.prompt);
      if (!prompt?.trim()) {
        errors.push({ level: 'error', node_id: nodeId, message: 'approval.on_reject.prompt is required' });
      }
      const attempts = num(v.on_reject.max_attempts) ?? 3;
      if (attempts < 1 || attempts > 10) {
        errors.push({
          level: 'error',
          node_id: nodeId,
          message: 'approval.on_reject.max_attempts must be between 1 and 10',
        });
      }
      onReject = { prompt: prompt ?? '', max_attempts: Math.trunc(attempts) };
    }
  }
  return {
    message: message ?? '',
    capture_response: bool(v.capture_response, false),
    on_reject: onReject,
  };
}

/** Which of the mutually exclusive node-type fields are present. */
function detectNodeTypes(raw: Raw): NodeType[] {
  return NODE_TYPE_FIELDS.filter((f) => raw[f] !== undefined && raw[f] !== null);
}

function parseNode(raw: Raw, index: number, errors: Diagnostic[], warnings: Diagnostic[]): WorkflowNode | null {
  const id = str(raw.id)?.trim();
  if (!id) {
    errors.push({ level: 'error', message: `nodes[${index}] is missing an 'id'` });
    return null;
  }

  const present = detectNodeTypes(raw);
  if (present.length === 0) {
    errors.push({
      level: 'error',
      node_id: id,
      message: `node has no body — exactly one of ${NODE_TYPE_FIELDS.join(', ')} is required`,
    });
    return null;
  }
  if (present.length > 1) {
    errors.push({
      level: 'error',
      node_id: id,
      message: `node declares ${present.join(' and ')} — these are mutually exclusive`,
    });
    return null;
  }
  const type = present[0]!;

  const triggerRaw = str(raw.trigger_rule) ?? 'all_success';
  if (!TRIGGER_RULES.includes(triggerRaw as TriggerRule)) {
    errors.push({
      level: 'error',
      node_id: id,
      message: `trigger_rule '${triggerRaw}' is not one of ${TRIGGER_RULES.join(', ')}`,
    });
  }

  const sideEffectsRaw = str(raw.side_effects) ?? 'idempotent';
  if (sideEffectsRaw !== 'idempotent' && sideEffectsRaw !== 'at_most_once') {
    errors.push({
      level: 'error',
      node_id: id,
      message: `side_effects must be 'idempotent' or 'at_most_once', got '${sideEffectsRaw}'`,
    });
  }

  const node: WorkflowNode = {
    id,
    type,
    depends_on: strArray(raw.depends_on) ?? [],
    when: str(raw.when),
    trigger_rule: (TRIGGER_RULES.includes(triggerRaw as TriggerRule)
      ? triggerRaw
      : 'all_success') as TriggerRule,
    idle_timeout: num(raw.idle_timeout),
    timeout: num(raw.timeout),
    side_effects: (sideEffectsRaw === 'at_most_once' ? 'at_most_once' : 'idempotent') as SideEffects,
  };

  const isAiNode = type === 'prompt' || type === 'command' || type === 'loop';

  if (isAiNode) {
    node.model = str(raw.model);
    node.provider = str(raw.provider);
    const ctx = str(raw.context);
    if (ctx !== undefined && ctx !== 'fresh' && ctx !== 'shared') {
      errors.push({
        level: 'error',
        node_id: id,
        message: `context must be 'fresh' or 'shared', got '${ctx}'`,
      });
    } else {
      node.context = ctx as 'fresh' | 'shared' | undefined;
    }
    node.allowed_tools = strArray(raw.allowed_tools);
    node.denied_tools = strArray(raw.denied_tools);
    if (isRecord(raw.output_format)) node.output_format = raw.output_format;
  } else {
    // Report rather than silently drop: a workflow author who set `model:` on a
    // bash node has a wrong mental model, and silence lets it persist.
    const ignored = AI_ONLY_FIELDS.filter((f) => raw[f] !== undefined && raw[f] !== null);
    if (ignored.length > 0) {
      warnings.push({
        level: 'warning',
        node_id: id,
        message: `${type} nodes do not invoke AI; ignoring ${ignored.join(', ')}`,
      });
    }
  }

  if (type === 'loop') {
    if (raw.retry !== undefined && raw.retry !== null) {
      // Hard error, matching Archon: retrying a loop would silently restart
      // iteration accounting and could re-run committed work.
      errors.push({ level: 'error', node_id: id, message: 'retry is not supported on loop nodes' });
    }
    node.loop = parseLoop(raw.loop, id, errors);
  } else {
    node.retry = parseRetry(raw.retry, id, errors);
  }

  switch (type) {
    case 'prompt':
      node.prompt = str(raw.prompt) ?? '';
      if (!node.prompt.trim()) {
        errors.push({ level: 'error', node_id: id, message: 'prompt must be non-empty' });
      }
      break;
    case 'command':
      node.command = str(raw.command)?.trim() ?? '';
      if (!node.command) {
        errors.push({ level: 'error', node_id: id, message: 'command must name a command file' });
      }
      break;
    case 'bash':
      node.bash = str(raw.bash) ?? '';
      if (!node.bash.trim()) {
        errors.push({ level: 'error', node_id: id, message: 'bash must be non-empty' });
      }
      break;
    case 'script': {
      node.script = str(raw.script) ?? '';
      if (!node.script.trim()) {
        errors.push({ level: 'error', node_id: id, message: 'script must be non-empty' });
      }
      const runtime = str(raw.runtime);
      if (runtime !== 'bun' && runtime !== 'uv') {
        errors.push({
          level: 'error',
          node_id: id,
          message: "script nodes require runtime: 'bun' or 'uv'",
        });
      } else {
        node.runtime = runtime as ScriptRuntime;
      }
      node.deps = strArray(raw.deps);
      if (node.deps?.length && runtime === 'bun') {
        warnings.push({
          level: 'warning',
          node_id: id,
          message: 'deps is uv-only; bun installs on import. Ignoring deps.',
        });
      }
      break;
    }
    case 'approval':
      node.approval = parseApproval(raw.approval, id, errors);
      break;
    case 'cancel':
      node.cancel = str(raw.cancel)?.trim() ?? '';
      if (!node.cancel) {
        errors.push({ level: 'error', node_id: id, message: 'cancel requires a non-empty reason' });
      }
      break;
    case 'loop':
      break;
  }

  return node;
}

/**
 * Deterministic JSON with object keys sorted at every depth.
 *
 * Note this is NOT `JSON.stringify(v, keys.sort())` — that form treats the
 * second argument as an allowlist applied at every level, which silently drops
 * every nested key not present in the top-level key list. Using it here would
 * have excluded node bodies from the fingerprint, so an edited prompt would
 * have resumed against stale cached output.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/**
 * Stable fingerprint of the normalized document.
 *
 * Hashing the normalized form rather than the file text means reformatting,
 * comment edits and key reordering do not invalidate an in-flight run's
 * resume, while a genuine change to any node does.
 */
export function hashWorkflow(def: Omit<WorkflowDef, 'hash' | 'source_path'>): string {
  return createHash('sha256').update(canonicalize(def)).digest('hex');
}

export function parseWorkflow(text: string, sourcePath: string): LoadResult {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new WorkflowLoadError(`${sourcePath}: invalid YAML — ${(err as Error).message}`);
  }
  if (!isRecord(doc)) {
    throw new WorkflowLoadError(`${sourcePath}: workflow must be a YAML map`);
  }

  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

  if (doc.steps !== undefined) {
    throw new WorkflowLoadError(
      `${sourcePath}: the 'steps:' format was removed — use 'nodes:' instead`,
    );
  }

  const name = str(doc.name)?.trim();
  if (!name) errors.push({ level: 'error', message: "workflow 'name' is required" });

  const rawNodes = doc.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new WorkflowLoadError(`${sourcePath}: workflow must declare a non-empty 'nodes' list`, errors);
  }

  const nodes: WorkflowNode[] = [];
  rawNodes.forEach((rawNode, i) => {
    if (!isRecord(rawNode)) {
      errors.push({ level: 'error', message: `nodes[${i}] must be a map` });
      return;
    }
    const parsed = parseNode(rawNode, i, errors, warnings);
    if (parsed) nodes.push(parsed);
  });

  // `interactive` is accepted for document compatibility but carries no
  // behaviour. Archon needed it because a workflow dispatched to a background
  // worker had no channel to deliver a gate message on. Here a gate always
  // pauses the run and persists the prompt, and whoever is driving — the
  // orchestrator via Linear, or a human via `gaggle workflow approve` — reads
  // it from there. So there is nothing to warn about.
  const interactive = bool(doc.interactive, false);

  let worktree;
  if (isRecord(doc.worktree)) {
    worktree = { enabled: typeof doc.worktree.enabled === 'boolean' ? doc.worktree.enabled : undefined };
  }

  const base = {
    name: name ?? '',
    description: str(doc.description) ?? '',
    provider: str(doc.provider),
    model: str(doc.model),
    interactive,
    worktree,
    nodes,
  };

  const workflow: WorkflowDef = {
    ...base,
    source_path: sourcePath,
    hash: hashWorkflow(base),
  };

  if (errors.length > 0) {
    throw new WorkflowLoadError(
      `${sourcePath}: ${errors.length} error(s) loading workflow '${name ?? '(unnamed)'}'`,
      [...errors, ...warnings],
    );
  }

  return { workflow, warnings };
}

export function loadWorkflowFile(path: string): LoadResult {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new WorkflowLoadError(`workflow file not found: ${abs}`);
  return parseWorkflow(readFileSync(abs, 'utf8'), abs);
}

export interface DiscoveredWorkflow {
  name: string;
  path: string;
  description: string;
}

const YAML_EXTS = new Set(['.yaml', '.yml']);

/**
 * Enumerate workflows under a directory tree, one level of subfolder deep.
 *
 * Nested folders are how templates namespace themselves — `gaggle/gaggle-fix-issue.yaml`
 * declares `name: gaggle/gaggle-fix-issue`. The `name:` field is authoritative;
 * the path is only a discovery mechanism.
 */
export function discoverWorkflowFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      for (const sub of readdirSync(full)) {
        const subFull = join(full, sub);
        if (statSync(subFull).isFile() && YAML_EXTS.has(extname(sub))) out.push(subFull);
      }
    } else if (st.isFile() && YAML_EXTS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out.sort();
}
