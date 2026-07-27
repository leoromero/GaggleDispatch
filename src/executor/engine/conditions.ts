/**
 * `when:` expression parsing and evaluation.
 *
 * The grammar is small on purpose — comparisons against string literals,
 * joined by `&&` and `||`, with `&&` binding tighter and no parentheses. It is
 * exactly what Archon accepted, so existing workflows keep routing the same
 * way, and it is small enough to be fully testable.
 *
 * Everything fails closed. An expression that does not parse, a numeric
 * comparison against a non-number, or a reference to a node that never ran all
 * evaluate to false and skip the node. Skipping is recoverable; running a node
 * whose precondition was not actually met is not.
 */

export type ComparisonOperator = '==' | '!=' | '<' | '>' | '<=' | '>=';

export interface NodeOutputRef {
  node_id: string;
  /** JSON field selector, for structured output. */
  field?: string;
}

export interface Comparison {
  kind: 'comparison';
  left: NodeOutputRef;
  operator: ComparisonOperator;
  right: string;
}

export interface AndExpr {
  kind: 'and';
  terms: Comparison[];
}

export interface OrExpr {
  kind: 'or';
  terms: AndExpr[];
}

export type ConditionAst = OrExpr;

export interface ParsedCondition {
  ast: ConditionAst | null;
  error: string | null;
}

/**
 * Matches `$node-id.output` / `$node-id.output.field` followed by an operator
 * and a single-quoted literal. Operator order matters: the two-character forms
 * must be tried before `<` and `>`.
 */
const COMPARISON_RE =
  /^\s*\$([A-Za-z0-9_-]+)\.output(?:\.([A-Za-z0-9_]+))?\s*(==|!=|<=|>=|<|>)\s*'([^']*)'\s*$/;

/** Finds every `$nodeId.output[.field]` reference in arbitrary text. */
export const NODE_REF_RE = /\$([A-Za-z0-9_-]+)\.output(?:\.([A-Za-z0-9_]+))?/g;

export function extractNodeRefs(text: string): NodeOutputRef[] {
  const out: NodeOutputRef[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(NODE_REF_RE)) {
    const key = `${m[1]}.${m[2] ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ node_id: m[1]!, field: m[2] });
  }
  return out;
}

export function parseCondition(expr: string): ParsedCondition {
  const trimmed = expr.trim();
  if (!trimmed) return { ast: null, error: 'condition is empty' };

  const orTerms: AndExpr[] = [];
  // `&&` binds tighter than `||`, so split on `||` first and each piece is a
  // conjunction. No parentheses to worry about.
  for (const orPart of trimmed.split('||')) {
    const andTerms: Comparison[] = [];
    for (const andPart of orPart.split('&&')) {
      const m = andPart.match(COMPARISON_RE);
      if (!m) {
        return {
          ast: null,
          error: `cannot parse comparison: '${andPart.trim()}' (expected $node.output OP 'value')`,
        };
      }
      andTerms.push({
        kind: 'comparison',
        left: { node_id: m[1]!, field: m[2] },
        operator: m[3] as ComparisonOperator,
        right: m[4]!,
      });
    }
    orTerms.push({ kind: 'and', terms: andTerms });
  }
  return { ast: { kind: 'or', terms: orTerms }, error: null };
}

/**
 * Resolves a reference to its string value. Returning an empty string for an
 * unknown node or absent field is what makes the comparison fail closed.
 */
export type RefResolver = (ref: NodeOutputRef) => string;

const NUMERIC_OPS: ComparisonOperator[] = ['<', '>', '<=', '>='];

function compare(op: ComparisonOperator, left: string, right: string): boolean {
  if (op === '==') return left === right;
  if (op === '!=') return left !== right;

  const l = Number(left);
  const r = Number(right);
  // A non-numeric side is not "less than" anything — refuse rather than
  // coerce, so `$score.output > '80'` on empty output skips the node.
  if (!Number.isFinite(l) || !Number.isFinite(r)) return false;
  switch (op) {
    case '<':
      return l < r;
    case '>':
      return l > r;
    case '<=':
      return l <= r;
    case '>=':
      return l >= r;
    default:
      return false;
  }
}

export interface EvaluationResult {
  value: boolean;
  /** Populated when the expression could not be parsed — surfaced as a warning. */
  error: string | null;
}

export function evaluateCondition(expr: string, resolve: RefResolver): EvaluationResult {
  const { ast, error } = parseCondition(expr);
  if (!ast) return { value: false, error };

  // Short-circuit both levels, matching the documented behaviour.
  for (const conjunction of ast.terms) {
    let all = true;
    for (const term of conjunction.terms) {
      if (!compare(term.operator, resolve(term.left), term.right)) {
        all = false;
        break;
      }
    }
    if (all) return { value: true, error: null };
  }
  return { value: false, error: null };
}

/** All node ids a condition depends on. Used by the validator. */
export function conditionRefs(expr: string): NodeOutputRef[] {
  const { ast } = parseCondition(expr);
  if (!ast) return extractNodeRefs(expr);
  return ast.terms.flatMap((and) => and.terms.map((c) => c.left));
}

export { NUMERIC_OPS };
