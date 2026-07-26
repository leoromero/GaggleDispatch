/**
 * Variable substitution.
 *
 * Two rules do most of the work here, and both matter for safety:
 *
 *  - Only *known* names are replaced. A `bash:` body is full of shell
 *    variables (`$spent`, `${PIPESTATUS[0]}`, `$1`) that must survive
 *    untouched, so substitution is an allowlist, never a general `$WORD` sweep.
 *  - `$nodeId.output` is shell-quoted when injected into a shell body. Node
 *    output is model-generated text; interpolating it raw into a command line
 *    is a command-injection hole.
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
   * Shell-quote `$nodeId.output` values. True for `bash:` bodies and
   * `until_bash`; false for prompts and for `script:` bodies, where the value
   * is assigned directly as a JS/Python expression.
   */
  shellQuote?: boolean;
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
}

/** Single-quote for POSIX sh, closing and reopening around embedded quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
      out += opts.shellQuote ? shellQuote(value) : value;
      i = k;
      continue;
    }

    const scalar = scalars.find(([name]) => name === word);
    if (scalar) {
      const value = scalar[1]();
      out += opts.shellQuote && UNTRUSTED_VARIABLES.has(word) ? shellQuote(value) : value;
      i = j;
      continue;
    }

    // Unknown — a shell variable, a price in dollars, whatever. Pass through.
    out += ch;
    i += 1;
  }

  return { text: out, unresolved };
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
