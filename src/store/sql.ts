/**
 * Shared low-level Postgres helpers.
 *
 * Bun ships a Postgres client in the runtime, so persistence costs no
 * dependency and parameterization comes free from tagged templates.
 *
 * Everything here is deliberately dumb: connection construction and row-value
 * coercion. No schema knowledge, no queries. Both the control plane
 * (`src/control/store/`) and the workflow engine (`src/executor/store/`) build
 * on it, which is the only reason it is not simply inlined into one of them.
 *
 * Driver quirks these helpers exist to absorb:
 *
 *   - Timestamps come back as `Date` from some paths and `string` from others.
 *     A mix of the two is a bug factory, so everything is normalized to ISO-8601
 *     text on the way out — see {@link iso}.
 *   - `jsonb` round-trips natively when a JS object or array is passed straight
 *     through (`${obj}`), but `JSON.stringify` + `::jsonb` double-encodes into a
 *     jsonb *string*. Pass values directly; never pre-stringify.
 *   - A JS array in an array context (`= ANY($1::text[])`) serializes to `a,b`,
 *     which Postgres rejects. Use `IN ${sql(values)}` instead — Bun expands that
 *     to a value list. {@link inList} guards the empty case, which would
 *     otherwise produce `IN ()` and a syntax error.
 */

import { SQL } from 'bun';

/**
 * A handle that can run queries. Satisfied by both the pool and the
 * transaction handle Bun passes to `sql.begin`, which is what lets a repository
 * method be written once and used inside or outside a transaction.
 */
export type Sql = SQL;

export interface OpenSqlOptions {
  /** Pool ceiling. Defaults to Bun's own default when omitted. */
  maxConnections?: number;
}

export function openSql(url: string, opts: OpenSqlOptions = {}): Sql {
  if (!url) {
    throw new Error(
      'No database URL configured. Set DATABASE_URL (or executor.database_url) ' +
        'and start Postgres with `docker compose up -d`.',
    );
  }
  return opts.maxConnections === undefined
    ? new SQL(url)
    : new SQL({ url, max: opts.maxConnections });
}

/** A row as the driver hands it back, before mapping. */
export type Row = Record<string, unknown>;

// ─── value coercion ─────────────────────────────────────────────────────────

/** Normalize a timestamp column to ISO-8601 text, preserving null. */
export function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** {@link iso} for `NOT NULL` columns. Falls back to the epoch rather than
 *  throwing: a malformed timestamp should not take down a board render. */
export function isoRequired(v: unknown): string {
  return iso(v) ?? new Date(0).toISOString();
}

export function text(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function textRequired(v: unknown, fallback = ''): string {
  return v === null || v === undefined ? fallback : String(v);
}

export function int(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function nullableInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function bool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true' || v === 1;
}

/** Parse a jsonb column. Tolerates an already-parsed value, since whether the
 *  driver parses depends on how the value was bound. */
export function parseJson(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/** A jsonb column expected to hold an array of T. Returns `[]` for anything else. */
export function jsonArray<T>(v: unknown): T[] {
  const parsed = parseJson(v);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

/** A jsonb column expected to hold an object. Returns `{}` for anything else. */
export function jsonObject(v: unknown): Record<string, unknown> {
  const parsed = parseJson(v);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Narrow a column to one of a known set, falling back when the value is
 *  unrecognized. Keeps a hand-edited row from crashing a read path. */
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = v === null || v === undefined ? '' : String(v);
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

/** As {@link oneOf} but null-preserving, for nullable enum-ish columns. */
export function oneOfOrNull<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return (allowed as readonly string[]).includes(s) ? (s as T) : null;
}

// ─── query fragments ────────────────────────────────────────────────────────

/**
 * Bind a set of values for an `= ANY(...)` test.
 *
 * Bun serializes a JS array in an array context to `a,b`, which Postgres's
 * array parser rejects outright. Passing a delimiter-joined string and
 * rebuilding the array server-side sidesteps that while staying fully
 * parameterized:
 *
 *   WHERE (${csvParam(statuses)}::text IS NULL
 *          OR status = ANY(string_to_array(${csvParam(statuses)}, ',')))
 *
 * Returning null for an empty input is what lets the `IS NULL` half of that
 * expression mean "no filter" — distinct from "filter matching nothing", which
 * callers handle by short-circuiting before they build the query.
 *
 * Only safe for values that cannot contain a comma. Every current caller passes
 * status literals or UUIDs, both of which qualify; anything else needs a
 * different encoding.
 */
/**
 * Reduce a patch to the columns actually being written, for Bun's
 * `UPDATE … SET ${sql(obj)}` helper.
 *
 * The distinction that matters: a key absent from the patch means "leave the
 * column alone", while a key present and null means "clear it". Spelling this
 * out as an object and letting the driver build the SET list is what avoids the
 * `CASE WHEN … THEN $n ELSE col END` construction, which needs an explicit cast
 * on every parameter because Postgres cannot infer the type of a bare NULL.
 *
 * Returns null when nothing is being written — `UPDATE` with an empty SET list
 * is a driver error, so callers short-circuit to a plain read.
 */
export function patchObject<T extends object>(
  patch: T,
  keys: readonly (keyof T)[],
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let any = false;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    const v = patch[k];
    if (v === undefined) continue;
    out[String(k)] = v;
    any = true;
  }
  return any ? out : null;
}

export function csvParam(values?: readonly string[]): string | null {
  if (!values || values.length === 0) return null;
  for (const v of values) {
    if (v.includes(',')) throw new Error(`csvParam cannot encode a value containing a comma: ${v}`);
  }
  return values.join(',');
}
