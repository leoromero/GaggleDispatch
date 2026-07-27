/**
 * Shared schema-migration runner.
 *
 * Migrations are versioned SQL strings compiled into the binary rather than
 * `.sql` files on disk, so `bun build --target=bun` yields a self-contained CLI
 * that never has to locate a migrations directory at runtime.
 *
 * One `schema_migrations` table serves the whole database. The control plane and
 * the workflow engine own disjoint version ranges (control plane 100–199, engine
 * 1–99, cross-cutting 300+), so each can apply its own set without knowing the
 * other exists and without either being able to renumber the other. Whichever
 * module opens the database first creates the bookkeeping table; both then
 * top-up only their own pending versions.
 */

import type { Sql, Row } from './sql.ts';
import { logger } from '../util/logger.ts';

export interface Migration {
  /** Globally unique and monotonic within an owning module's range. */
  version: number;
  name: string;
  sql: string;
}

const BOOTSTRAP = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INT PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

/**
 * A lock id for the migration runner, so two processes cannot apply the same
 * schema concurrently. Arbitrary but fixed — any other holder of this exact key
 * would have to have chosen it deliberately.
 */
const MIGRATION_LOCK_KEY = 0x6167_676c; // "aggl"

/**
 * Apply every pending migration in ascending version order.
 *
 * Safe to call repeatedly, and safe to call concurrently: the run happens inside
 * one transaction holding a **transaction-scoped** advisory lock. `gaggle nest
 * start` launches every daemon and then the hub, each of which migrates, so on a
 * virgin database that race is the normal case rather than an edge one — and
 * without the lock the loser does not fail politely on a duplicate key, it dies
 * inside `CREATE TABLE` with "duplicate key value violates unique constraint
 * pg_type_typname_nsp_index".
 *
 * Two details that are easy to get wrong:
 *
 *   - The lock must be `pg_advisory_xact_lock`, not the session-level
 *     `pg_advisory_lock`. Over a connection *pool* there is no guarantee the
 *     matching `pg_advisory_unlock` runs on the same connection, and unlocking
 *     from another session silently returns false — leaving the lock held for the
 *     life of the process and every later migration run hanging on it.
 *   - The applied set is read *inside* the lock. Reading it outside would let a
 *     process that waited act on a list that is already stale.
 *
 * All pending migrations share the transaction, which is strictly safer than one
 * transaction each: a failure part-way through rolls the whole schema back rather
 * than leaving it half-migrated.
 *
 * Returns the versions actually applied by this call — empty for the caller that
 * waited and found the work already done.
 */
export async function applyMigrations(sql: Sql, migrations: readonly Migration[]): Promise<number[]> {
  assertUniqueVersions(migrations);

  return (await sql.begin(async (tx: Sql) => {
    // The lock comes first, before *anything* touches the catalog. Advisory locks
    // need no table, so this is safe on a virgin database — and it has to be here
    // rather than around only the migrations, because `CREATE TABLE IF NOT EXISTS`
    // is not itself race-free: two sessions running it concurrently fail with
    // "duplicate key value violates unique constraint pg_type_typname_nsp_index",
    // which is the very error the lock exists to prevent.
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
    await tx.unsafe(BOOTSTRAP);

    const applied = (await tx`SELECT version FROM schema_migrations`) as Row[];
    const have = new Set(applied.map((r) => Number(r.version)));

    const pending = [...migrations]
      .filter((m) => !have.has(m.version))
      .sort((a, b) => a.version - b.version);

    const done: number[] = [];
    for (const m of pending) {
      logger.info('Applying migration', { version: m.version, name: m.name });
      await tx.unsafe(m.sql);
      await tx`INSERT INTO schema_migrations (version, name) VALUES (${m.version}, ${m.name})`;
      done.push(m.version);
    }
    return done;
  })) as number[];
}

/**
 * The highest version currently recorded, or 0 when nothing has been applied.
 *
 * Read-only, deliberately: an earlier version bootstrapped the table here, which
 * meant `gaggle doctor` — a diagnostic — created schema as a side effect, and
 * could race a real first boot while doing it.
 */
export async function currentVersion(sql: Sql): Promise<number> {
  const rows = await readApplied(sql);
  return rows.reduce((max, v) => Math.max(max, v), 0);
}

/** Versions in `migrations` the database has not applied yet. Read-only. */
export async function pendingVersions(sql: Sql, migrations: readonly Migration[]): Promise<number[]> {
  const have = new Set(await readApplied(sql));
  return migrations
    .filter((m) => !have.has(m.version))
    .map((m) => m.version)
    .sort((a, b) => a - b);
}

/**
 * Applied versions, treating a missing `schema_migrations` as "none".
 *
 * `42P01` is undefined_table. Catching it is what lets the read-only helpers stay
 * read-only on a database nothing has migrated yet.
 */
async function readApplied(sql: Sql): Promise<number[]> {
  try {
    const rows = (await sql`SELECT version FROM schema_migrations`) as Row[];
    return rows.map((r) => Number(r.version));
  } catch (err) {
    if ((err as { errno?: string }).errno === '42P01') return [];
    throw err;
  }
}

function assertUniqueVersions(migrations: readonly Migration[]): void {
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version ${m.version} (${m.name})`);
    }
    seen.add(m.version);
  }
}
