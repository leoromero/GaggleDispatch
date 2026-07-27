/**
 * Variable substitution.
 *
 * Two rules do most of the work here, and both matter for safety:
 *
 *  - Only *known* names are replaced. A `bash:` body is full of shell
 *    variables (`$spent`, `${PIPESTATUS[0]}`, `$1`) that must survive
 *    untouched, so substitution is an allowlist, never a general `$WORD` sweep.
 *  - Untrusted values are never pasted into a shell body. Model output, issue
 *    text and human replies are passed through the environment and referenced
 *    as `${GAGGLE_…}`.
 *
 * That second rule replaced shell-quoting, which could not be made correct.
 * Quoting produces `'value'`, which is only safe in an *unquoted* context —
 * and the substituter cannot see whether the reference sits inside double
 * quotes. A template writing the entirely natural `"$node.output"` would get
 * literal quote characters inside the string and the value re-exposed to
 * `$(…)` and backticks. Parameter expansion has no such problem: the shell
 * does not re-parse an expanded value for command substitution, so
 * `${GAGGLE_…}` is inert quoted *and* unquoted, and the author's own quoting
 * keeps meaning what it says.
 */

import type { NodeOutputRef } from './conditions.ts';

export interface NodeOutputValue {
  text: string;
  /** Parsed structured output, when the producing node declared output_format. */
  json?: unknown;
}

export interface SubstitutionContext {
  /** `$ARGUMENTS` and `$USER_MESSAGE`. */
  arguments: string;
  /** `$WORKFLOW_ID`. */
  workflowId: string;
  /** `$ARTIFACTS_DIR`. */
  artifactsDir: string;
  /** `$BASE_BRANCH`. Null when it could not be resolved. */
  baseBranch: string | null;
  /** `$CONTEXT`, `$EXTERNAL_CONTEXT`, `$ISSUE_CONTEXT`. */
  context?: string;
  /** `$LOOP_USER_INPUT` — set only on the first iteration after a loop gate. */
  loopUserInput?: string;
  /** `$REJECTION_REASON` — set only inside an `on_reject` prompt. */
  rejectionReason?: string;
  nodeOutputs: Map<string, NodeOutputValue>;
}

export interface SubstituteOptions {
  /**
   * This text is a shell body (`bash:` or `until_bash`).
   *
   * Untrusted values are then emitted as `${GAGGLE_…}` parameter references
   * and returned in `bindings` for the caller to put in the subprocess
   * environment, rather than being pasted into the script.
   */
  shell?: boolean;
  /**
   * Consume `\$` down to a literal `$`. Enabled for prompt and command text.
   * Off for shell bodies, where the backslash is preserved so the shell's own
   * escaping still works — either way `\$NAME` is never substituted.
   */
  allowEscapes?: boolean;
}

export interface SubstituteResult {
  text: string;
  /** References that resolved to nothing — surfaced as run warnings. */
  unresolved: string[];
  /**
   * Environment the expanded shell body needs. Empty unless `shell` was set.
   * The caller must merge this into the subprocess env.
   */
  bindings: Record<string, string>;
}

/**
 * Allocates a unique, shell-legal environment variable name per value.
 *
 * Node ids allow hyphens and env names do not, so `a-b` and `a_b` would
 * collide after sanitising; a numeric suffix keeps them distinct.
 */
class EnvBinder {
  readonly bindings: Record<string, string> = {};
  private readonly assigned = new Map<string, string>();

  bind(kind: 'OUT' | 'VAR', key: string, value: string): string {
    const existing = this.assigned.get(`${kind}:${key}`);
    if (existing) return existing;

    const base = `GAGGLE_${kind}_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    let name = base;
    for (let i = 2; name in this.bindings; i += 1) name = `${base}_${i}`;

    this.bindings[name] = value;
    this.assigned.set(`${kind}:${key}`, name);
    return name;
  }
}

export class MissingBaseBranchError extends Error {
  constructor() {
    super(
      '$BASE_BRANCH was referenced but could not be resolved. Set worktree.baseBranch in ' +
        '.gaggle/config.yaml, or run against a checkout with a detectable default branch.',
    );
    this.name = 'MissingBaseBranchError';
  }
}

/**
 * Variables carrying text from outside the system — a Linear issue's title and
 * body, a human's gate reply. These are shell-quoted when injected into a
 * shell body, exactly like node output.
 *
 * The engine-controlled variables are deliberately *not* in this set.
 * `$ARTIFACTS_DIR` and `$BASE_BRANCH` are a path and a branch name the engine
 * computed, and every shipped template writes them inside double quotes
 * (`"$ARTIFACTS_DIR/notes.md"`) — quoting those would embed literal quote
 * characters into the middle of a path and break the script. Untrusted text is
 * the part that has to be neutralised.
 */
const UNTRUSTED_VARIABLES = new Set([
  'ARGUMENTS',
  'USER_MESSAGE',
  'CONTEXT',
  'EXTERNAL_CONTEXT',
  'ISSUE_CONTEXT',
  'LOOP_USER_INPUT',
  'REJECTION_REASON',
]);

/** Names replaced with a plain scalar, longest-first so prefixes cannot shadow. */
function scalarVariables(ctx: SubstitutionContext): Array<[string, () => string]> {
  return [
    ['EXTERNAL_CONTEXT', () => ctx.context ?? ''],
    ['ISSUE_CONTEXT', () => ctx.context ?? ''],
    ['REJECTION_REASON', () => ctx.rejectionReason ?? ''],
    ['LOOP_USER_INPUT', () => ctx.loopUserInput ?? ''],
    ['ARTIFACTS_DIR', () => ctx.artifactsDir],
    ['USER_MESSAGE', () => ctx.arguments],
    ['BASE_BRANCH', () => {
      // Throwing beats substituting an empty string: a workflow that branches
      // from '' would silently do the wrong thing on a real repository.
      if (ctx.baseBranch === null) throw new MissingBaseBranchError();
      return ctx.baseBranch;
    }],
    ['WORKFLOW_ID', () => ctx.workflowId],
    ['ARGUMENTS', () => ctx.arguments],
    ['CONTEXT', () => ctx.context ?? ''],
  ].sort((a, b) => (b[0] as string).length - (a[0] as string).length) as Array<[string, () => string]>;
}

function resolveNodeRef(
  ctx: SubstitutionContext,
  ref: NodeOutputRef,
): { value: string; found: boolean } {
  const entry = ctx.nodeOutputs.get(ref.node_id);
  if (!entry) return { value: '', found: false };
  if (!ref.field) return { value: entry.text, found: true };

  // Field access needs parsed JSON. Fall back to parsing the text so a bash
  // node that printed JSON works the same as an AI node with output_format.
  let json = entry.json;
  if (json === undefined || json === null) {
    try {
      json = JSON.parse(entry.text);
    } catch {
      return { value: '', found: false };
    }
  }
  if (typeof json !== 'object' || json === null) return { value: '', found: false };
  const raw = (json as Record<string, unknown>)[ref.field];
  if (raw === undefined || raw === null) return { value: '', found: false };
  return { value: typeof raw === 'string' ? raw : String(raw), found: true };
}

const IDENT = /[A-Za-z0-9_-]/;

/**
 * Replace variables in a single left-to-right pass.
 *
 * One pass matters: substituting sequentially would let a value that happens
 * to contain `$ARGUMENTS` be expanded again on a later iteration.
 */
export function substitute(
  text: string,
  ctx: SubstitutionContext,
  opts: SubstituteOptions = {},
): SubstituteResult {
  const scalars = scalarVariables(ctx);
  const unresolved: string[] = [];
  const binder = new EnvBinder();
  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '\\' && text[i + 1] === '$') {
      // Either way the following `$` is not ours to expand. In prompt text we
      // consume the backslash, which is what the escape is for. In a shell
      // body we keep it verbatim — `"\$HOME"` means a literal `$HOME` to the
      // shell, and rewriting it to `"$HOME"` would change what the script does.
      out += opts.allowEscapes ? '$' : '\\$';
      i += 2;
      continue;
    }

    if (ch !== '$') {
      out += ch;
      i += 1;
      continue;
    }

    // `${...}` is shell syntax, never one of ours. Leave it alone.
    if (text[i + 1] === '{') {
      out += ch;
      i += 1;
      continue;
    }

    // Longest identifier run after the '$'.
    let j = i + 1;
    while (j < text.length && IDENT.test(text[j]!)) j += 1;
    const word = text.slice(i + 1, j);
    if (!word) {
      out += ch;
      i += 1;
      continue;
    }

    // A node output reference: `$id.output` optionally followed by `.field`.
    if (text.startsWith('.output', j)) {
      let k = j + '.output'.length;
      let field: string | undefined;
      if (text[k] === '.') {
        let f = k + 1;
        while (f < text.length && /[A-Za-z0-9_]/.test(text[f]!)) f += 1;
        if (f > k + 1) {
          field = text.slice(k + 1, f);
          k = f;
        }
      }
      const { value, found } = resolveNodeRef(ctx, { node_id: word, field });
      if (!found) unresolved.push(field ? `$${word}.output.${field}` : `$${word}.output`);
      out += opts.shell
        ? `\${${binder.bind('OUT', field ? `${word}_${field}` : word, value)}}`
        : value;
      i = k;
      continue;
    }

    const scalar = scalars.find(([name]) => name === word);
    if (scalar) {
      const value = scalar[1]();
      out +=
        opts.shell && UNTRUSTED_VARIABLES.has(word)
          ? `\${${binder.bind('VAR', word, value)}}`
          : value;
      i = j;
      continue;
    }

    // Unknown — a shell variable, a price in dollars, whatever. Pass through.
    out += ch;
    i += 1;
  }

  return { text: out, unresolved, bindings: binder.bindings };
}

/**
 * Append issue context when the template never mentioned it.
 *
 * Matches Archon's behaviour: a workflow author who does not place `$CONTEXT`
 * explicitly still gets the context, rather than silently losing it.
 */
export function appendContextIfAbsent(text: string, context: string | undefined): string {
  if (!context?.trim()) return text;
  if (/\$(CONTEXT|EXTERNAL_CONTEXT|ISSUE_CONTEXT)\b/.test(text)) return text;
  return `${text}\n\n---\n\n${context}`;
}
