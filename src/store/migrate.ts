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
  await sql.unsafe(BOOTSTRAP);

  return (await sql.begin(async (tx: Sql) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;

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

/** The highest version currently recorded, or 0 on a virgin database. */
export async function currentVersion(sql: Sql): Promise<number> {
  await sql.unsafe(BOOTSTRAP);
  const rows = (await sql`SELECT COALESCE(MAX(version), 0)::int AS v FROM schema_migrations`) as Row[];
  return Number(rows[0]?.v ?? 0);
}

/** Versions in `migrations` that the database has not applied yet. */
export async function pendingVersions(sql: Sql, migrations: readonly Migration[]): Promise<number[]> {
  await sql.unsafe(BOOTSTRAP);
  const applied = (await sql`SELECT version FROM schema_migrations`) as Row[];
  const have = new Set(applied.map((r) => Number(r.version)));
  return migrations
    .filter((m) => !have.has(m.version))
    .map((m) => m.version)
    .sort((a, b) => a - b);
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
