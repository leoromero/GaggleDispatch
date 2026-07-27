/**
 * `when:` expressions. These decide whether a node runs at all, so the
 * fail-closed cases matter as much as the happy path.
 */

import { describe, expect, test } from 'bun:test';
import {
  conditionRefs,
  evaluateCondition,
  extractNodeRefs,
  parseCondition,
} from '../executor/engine/conditions.ts';

/** Resolver over a plain map; anything absent resolves to '' like the engine. */
const from = (m: Record<string, string>) => (ref: { node_id: string; field?: string }) =>
  m[ref.field ? `${ref.node_id}.${ref.field}` : ref.node_id] ?? '';

const evalWith = (expr: string, m: Record<string, string>) => evaluateCondition(expr, from(m)).value;

describe('parseCondition', () => {
  test('parses a simple string comparison', () => {
    const { ast, error } = parseCondition("$classify.output == 'bug'");
    expect(error).toBeNull();
    expect(ast!.terms).toHaveLength(1);
    const cmp = ast!.terms[0]!.terms[0]!;
    expect(cmp.left).toEqual({ node_id: 'classify', field: undefined });
    expect(cmp.operator).toBe('==');
    expect(cmp.right).toBe('bug');
  });

  test('parses dot-notation field access', () => {
    const { ast } = parseCondition("$classify.output.issue_type == 'bug'");
    expect(ast!.terms[0]!.terms[0]!.left).toEqual({ node_id: 'classify', field: 'issue_type' });
  });

  test('accepts hyphenated node ids', () => {
    const { ast, error } = parseCondition("$check-blocker.output == 'BLOCKER'");
    expect(error).toBeNull();
    expect(ast!.terms[0]!.terms[0]!.left.node_id).toBe('check-blocker');
  });

  test('parses all six operators', () => {
    for (const op of ['==', '!=', '<', '>', '<=', '>=']) {
      const { ast, error } = parseCondition(`$score.output ${op} '80'`);
      expect(error).toBeNull();
      expect(ast!.terms[0]!.terms[0]!.operator).toBe(op as never);
    }
  });

  test('&& binds tighter than || — A && B || C is (A && B) || C', () => {
    const { ast } = parseCondition("$a.output == 'x' && $b.output == 'y' || $c.output == 'z'");
    expect(ast!.terms).toHaveLength(2);
    expect(ast!.terms[0]!.terms).toHaveLength(2);
    expect(ast!.terms[1]!.terms).toHaveLength(1);
  });

  test('reports an unparseable comparison rather than guessing', () => {
    expect(parseCondition('$a.output ~= 1').error).toContain('cannot parse');
    expect(parseCondition('nonsense').error).toContain('cannot parse');
    // Unquoted right-hand side is not valid — literals must be single-quoted.
    expect(parseCondition('$a.output == bug').error).toContain('cannot parse');
  });

  test('rejects an empty expression', () => {
    expect(parseCondition('   ').error).toBe('condition is empty');
  });
});

describe('evaluateCondition', () => {
  test('string equality and inequality', () => {
    expect(evalWith("$a.output == 'bug'", { a: 'bug' })).toBe(true);
    expect(evalWith("$a.output == 'bug'", { a: 'feature' })).toBe(false);
    expect(evalWith("$a.output != 'bug'", { a: 'feature' })).toBe(true);
  });

  test('numeric comparisons coerce both sides', () => {
    expect(evalWith("$score.output > '80'", { score: '95' })).toBe(true);
    expect(evalWith("$score.output > '80'", { score: '75' })).toBe(false);
    expect(evalWith("$score.output >= '0.9'", { score: '0.9' })).toBe(true);
    expect(evalWith("$score.output <= '5'", { score: '5' })).toBe(true);
    expect(evalWith("$score.output < '100'", { score: '99' })).toBe(true);
  });

  test('a non-numeric side fails closed instead of coercing', () => {
    // '' > '80' must not be true via string comparison or NaN weirdness.
    expect(evalWith("$score.output > '80'", {})).toBe(false);
    expect(evalWith("$score.output > '80'", { score: 'high' })).toBe(false);
    expect(evalWith("$score.output < '80'", { score: 'high' })).toBe(false);
  });

  test('a missing node resolves empty, so equality against a literal is false', () => {
    expect(evalWith("$never-ran.output == 'ok'", {})).toBe(false);
    // ...but comparing against empty does match, which is the documented behaviour.
    expect(evalWith("$never-ran.output == ''", {})).toBe(true);
  });

  test('conjunction requires every term', () => {
    expect(evalWith("$a.output == 'x' && $b.output == 'y'", { a: 'x', b: 'y' })).toBe(true);
    expect(evalWith("$a.output == 'x' && $b.output == 'y'", { a: 'x', b: 'z' })).toBe(false);
  });

  test('disjunction needs only one branch', () => {
    expect(evalWith("$a.output == 'x' || $b.output == 'y'", { a: 'no', b: 'y' })).toBe(true);
    expect(evalWith("$a.output == 'x' || $b.output == 'y'", { a: 'no', b: 'no' })).toBe(false);
  });

  test('precedence in practice: (A && B) || C', () => {
    const expr = "$a.output == 'x' && $b.output == 'y' || $c.output == 'z'";
    expect(evalWith(expr, { a: 'x', b: 'y', c: 'no' })).toBe(true);
    expect(evalWith(expr, { a: 'no', b: 'no', c: 'z' })).toBe(true);
    expect(evalWith(expr, { a: 'x', b: 'no', c: 'no' })).toBe(false);
  });

  test('field access reads the parsed field', () => {
    expect(evalWith("$c.output.issue_type == 'bug'", { 'c.issue_type': 'bug' })).toBe(true);
    expect(evalWith("$c.output.issue_type == 'bug'", { c: 'bug' })).toBe(false);
  });

  test('an invalid expression evaluates false and reports the error', () => {
    const res = evaluateCondition('total nonsense', from({}));
    expect(res.value).toBe(false);
    expect(res.error).toContain('cannot parse');
  });
});

describe('extractNodeRefs', () => {
  test('finds bare and field references, de-duplicated', () => {
    const refs = extractNodeRefs('a $one.output b $two.output.field c $one.output');
    expect(refs).toEqual([
      { node_id: 'one', field: undefined },
      { node_id: 'two', field: 'field' },
    ]);
  });

  test('ignores plain workflow variables', () => {
    expect(extractNodeRefs('$ARTIFACTS_DIR/x and $USER_MESSAGE')).toEqual([]);
  });

  test('finds references inside prose and shell', () => {
    const refs = extractNodeRefs('echo "$snapshot-root.output" > f');
    expect(refs).toEqual([{ node_id: 'snapshot-root', field: undefined }]);
  });
});

describe('conditionRefs', () => {
  test('returns the left-hand reference of each comparison', () => {
    expect(conditionRefs("$a.output == 'x' && $b.output.f != 'y'")).toEqual([
      { node_id: 'a', field: undefined },
      { node_id: 'b', field: 'f' },
    ]);
  });

  test('falls back to a raw scan when the expression does not parse', () => {
    expect(conditionRefs('$a.output totally broken')).toEqual([
      { node_id: 'a', field: undefined },
    ]);
  });
});
