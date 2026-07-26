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
 * Apply every pending migration in ascending version order, each in its own
 * transaction — a partially-applied migration is worse than an unapplied one.
 * Safe to call repeatedly and safe to call concurrently from two processes:
 * the `INSERT` into `schema_migrations` is what serializes them, and the loser
 * of a race fails on the primary key and retries the read.
 *
 * Returns the versions actually applied by this call.
 */
export async function applyMigrations(sql: Sql, migrations: readonly Migration[]): Promise<number[]> {
  assertUniqueVersions(migrations);
  await sql.unsafe(BOOTSTRAP);

  const applied = (await sql`SELECT version FROM schema_migrations`) as Row[];
  const have = new Set(applied.map((r) => Number(r.version)));

  const pending = [...migrations].filter((m) => !have.has(m.version)).sort((a, b) => a.version - b.version);
  const done: number[] = [];

  for (const m of pending) {
    logger.info('Applying migration', { version: m.version, name: m.name });
    await sql.begin(async (tx: Sql) => {
      await tx.unsafe(m.sql);
      await tx`INSERT INTO schema_migrations (version, name) VALUES (${m.version}, ${m.name})`;
    });
    done.push(m.version);
  }

  return done;
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
