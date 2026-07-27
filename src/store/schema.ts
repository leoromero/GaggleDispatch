/**
 * The whole schema, in one place.
 *
 * Three modules own disjoint version ranges of one `schema_migrations` table in
 * one database — the engine (1–99), the control plane (100–199), and hub
 * history (200–299). Ownership is about who *authors* a migration; it was never
 * meant to mean that a process applies only its own slice.
 *
 * It came to mean that by accident, and the result was a database migrated into
 * a shape nothing can run on. `withStore` applied the engine set, but the engine
 * store reads and writes `scaffold_jobs`, which the control plane creates — so
 * on a fresh database `gaggle sync` (step 4 of the documented setup) died with a
 * raw `relation "scaffold_jobs" does not exist`. Hub history had the mirror
 * problem from the other side: migration 200 was applied only by `nest start`,
 * so a plain `gaggle start` deployment had `doctor` reporting it pending
 * forever, with fix text pointing at the command that does not apply it.
 *
 * So: every entry point that opens the database applies everything. It is one
 * advisory-locked transaction and a no-op once the schema is current, and the
 * alternative is a matrix of "which command needs which owner's tables" that
 * nobody can hold in their head.
 */

import { CONTROL_MIGRATIONS } from '../control/store/migrations.ts';
import { MIGRATIONS as ENGINE_MIGRATIONS } from '../executor/store/migrations.ts';
import { HUB_MIGRATIONS } from '../hub/history-migrations.ts';
import { applyMigrations, type Migration } from './migrate.ts';
import type { Sql } from './sql.ts';

/**
 * Every migration this build knows about, in version order.
 *
 * Ordered across owners rather than grouped by them, because the ranges are
 * disjoint and a single ascending list is what the runner wants. A
 * cross-cutting migration in the 300 range would slot in here naturally.
 */
export const ALL_MIGRATIONS: readonly Migration[] = [
  ...ENGINE_MIGRATIONS,
  ...CONTROL_MIGRATIONS,
  ...HUB_MIGRATIONS,
].sort((a, b) => a.version - b.version);

/**
 * Engine migration 3 only ever existed on the unmerged workflow-engine branch.
 *
 * That build's engine set created `scaffold_jobs` and the `hub_*` tables, which
 * the control plane and hub own now — and its `scaffold_jobs` has no
 * `workspace` column, so it is not merely duplicated but the wrong shape. A
 * database in that state cannot be migrated forward; migration 100 fails on
 * `relation "scaffold_jobs" already exists`.
 *
 * Nobody outside this repository can be in that state: the schema never
 * shipped. So this is a clear error rather than a repair migration, and it can
 * be deleted once the branch has been merged for a release or two.
 */
const PRE_MERGE_ENGINE_VERSION = 3;

async function assertNotPreMergeEngineSchema(sql: Sql): Promise<void> {
  let rows: Array<{ version: number }>;
  try {
    rows = (await sql`
      SELECT version FROM schema_migrations WHERE version = ${PRE_MERGE_ENGINE_VERSION}
    `) as Array<{ version: number }>;
  } catch (err) {
    // 42P01 undefined_table — a virgin database, which is the happy path.
    if ((err as { errno?: string }).errno === '42P01') return;
    throw err;
  }
  if (rows.length === 0) return;

  throw new Error(
    'This database was migrated by a pre-merge build of the workflow-engine branch ' +
      `(engine migration ${PRE_MERGE_ENGINE_VERSION}). That build created scaffold_jobs and the hub_* ` +
      'tables, which the control plane and hub own now, in an incompatible shape — there is no ' +
      'upgrade path, because the schema never shipped.\n\n' +
      'Recreate the database:\n' +
      '  docker compose down -v && docker compose up -d\n\n' +
      'Or, to keep the workflow_runs history:\n' +
      '  DROP TABLE scaffold_jobs, hub_workspaces, hub_runs, hub_logs, hub_gate_events, hub_token_daily CASCADE;\n' +
      '  DELETE FROM schema_migrations WHERE version IN (2, 3);\n' +
      '  -- then re-run; migration 2 recreates the registry tables without scaffold_jobs.',
  );
}

/** Bring the database fully up to date. Safe to call repeatedly and concurrently. */
export async function migrateAll(sql: Sql): Promise<number[]> {
  await assertNotPreMergeEngineSchema(sql);
  return applyMigrations(sql, ALL_MIGRATIONS);
}
