/**
 * The migration runner's concurrency behaviour.
 *
 * `gaggle nest start` launches every daemon and then the hub, each of which
 * migrates, so on a virgin database a concurrent migration is the normal case.
 * These need a real Postgres — the whole point is the lock — so they skip without
 * TEST_DATABASE_URL.
 *
 * The lock bug this guards against was self-inflicted and instructive: a
 * *session*-level `pg_advisory_lock` looks correct, but over a connection pool the
 * matching unlock can run on a different connection, where it silently returns
 * false. The lock is then held by an idle backend for the life of the process and
 * every later migration blocks on it forever.
 */

import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import {
  applyMigrations,
  assertInRange,
  currentVersion,
  pendingVersions,
  MIGRATION_RANGES,
  type Migration,
  type MigrationOwner,
} from '../store/migrate.ts';
import { CONTROL_MIGRATIONS } from '../control/store/migrations.ts';
import { MIGRATIONS as ENGINE_MIGRATIONS } from '../executor/store/migrations.ts';
import { HUB_MIGRATIONS } from '../hub/history-migrations.ts';
import { openSql, type Sql } from '../store/sql.ts';
import { ALL_MIGRATIONS, migrateAll } from '../store/schema.ts';

const PG_URL = process.env.TEST_DATABASE_URL ?? '';

if (!PG_URL) {
  describe('applyMigrations', () => {
    test.skip('set TEST_DATABASE_URL to run against real Postgres', () => {});
  });
} else {
  // A private version range so these never collide with the real migrations.
  const MIGRATIONS: Migration[] = [
    { version: 9001, name: 'probe_one', sql: 'CREATE TABLE mig_probe_one (id int primary key)' },
    { version: 9002, name: 'probe_two', sql: 'CREATE TABLE mig_probe_two (id int primary key)' },
  ];

  // Connection budgets are deliberately tiny. `bun test` runs files in parallel
  // and the other Postgres suites hold pools of their own, so a pool-per-call
  // helper exhausts the server's connection limit long before any assertion
  // matters — which is how this file first failed, only under the full suite.
  // `applyMigrations` issues its queries sequentially, so one connection is enough.
  let shared: Sql | null = null;
  const pool = (): Sql => (shared ??= openSql(PG_URL, { maxConnections: 2 }));

  /** A short-lived single-connection pool per racer, closed by the caller. */
  const burst = (): Sql => openSql(PG_URL, { maxConnections: 1 });

  async function reset(): Promise<void> {
    await pool().unsafe('DROP TABLE IF EXISTS mig_probe_one, mig_probe_two CASCADE');
    await pool().unsafe('DELETE FROM schema_migrations WHERE version BETWEEN 9000 AND 9999');
  }

  describe('applyMigrations', () => {
    beforeEach(reset);
    afterAll(async () => {
      await reset();
      await shared?.close().catch(() => {});
      shared = null;
    });

    test('applies pending versions in ascending order and records them', async () => {
      const applied = await applyMigrations(pool(), MIGRATIONS);
      expect(applied).toEqual([9001, 9002]);
      expect(await currentVersion(pool())).toBeGreaterThanOrEqual(9002);
      expect(await pendingVersions(pool(), MIGRATIONS)).toEqual([]);
    });

    test('a second call is a no-op', async () => {
      await applyMigrations(pool(), MIGRATIONS);
      expect(await applyMigrations(pool(), MIGRATIONS)).toEqual([]);
    });

    test('concurrent runs serialize: one applies, the others find nothing left', async () => {
      // Without the lock the losers do not fail politely on a duplicate key — they
      // die inside CREATE TABLE with "duplicate key value violates unique
      // constraint pg_type_typname_nsp_index".
      // Separate pools, so these are genuinely separate sessions racing.
      const racers = [burst(), burst(), burst()];
      const results = await Promise.allSettled(
        racers.map((p) => applyMigrations(p, MIGRATIONS)),
      );
      for (const p of racers) await p.close().catch(() => {});

      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);

      const appliedSets = results
        .filter((r): r is PromiseFulfilledResult<number[]> => r.status === 'fulfilled')
        .map((r) => r.value);
      // Exactly one run did the work; the rest waited and found it done.
      expect(appliedSets.filter((v) => v.length > 0)).toEqual([[9001, 9002]]);
      expect(appliedSets.filter((v) => v.length === 0)).toHaveLength(2);
    });

    test('the lock is released when the run finishes, not held by an idle backend', async () => {
      // The exact failure of the session-lock version: it left the lock held by an
      // idle connection, and every later migration blocked forever.
      await applyMigrations(pool(), MIGRATIONS);

      const checker = pool();
      const held = (await checker`
        SELECT count(*)::int AS n
          FROM pg_locks l JOIN pg_stat_activity a USING (pid)
         WHERE l.locktype = 'advisory' AND l.granted AND a.state = 'idle'`) as Array<{ n: number }>;
      expect(held[0]!.n).toBe(0);

      // And a fresh run still completes promptly rather than hanging.
      const started = Date.now();
      await applyMigrations(pool(), MIGRATIONS);
      expect(Date.now() - started).toBeLessThan(5000);
    });

    test('a duplicate version in the input is rejected before anything is applied', async () => {
      const dupes: Migration[] = [
        { version: 9001, name: 'a', sql: 'SELECT 1' },
        { version: 9001, name: 'b', sql: 'SELECT 1' },
      ];
      await expect(applyMigrations(pool(), dupes)).rejects.toThrow(/Duplicate migration version 9001/);
    });

    test('a failing migration rolls back, leaving nothing recorded', async () => {
      const broken: Migration[] = [
        { version: 9001, name: 'ok', sql: 'CREATE TABLE mig_probe_one (id int primary key)' },
        { version: 9002, name: 'broken', sql: 'CREATE TABLE mig_probe_two (this is not sql)' },
      ];
      await expect(applyMigrations(pool(), broken)).rejects.toThrow();

      // All-or-nothing: the good migration went back too, so a retry starts clean
      // rather than tripping over a half-applied schema.
      expect(await pendingVersions(pool(), MIGRATIONS)).toEqual([9001, 9002]);
      const tables = (await pool()`
        SELECT tablename FROM pg_tables WHERE tablename LIKE 'mig_probe%'`) as Array<{
        tablename: string;
      }>;
      expect(tables).toEqual([]);
    });
  });
}

// ─── range ownership ────────────────────────────────────────────────────────
//
// No database needed: this is a static claim about who may number what. It is a
// check rather than a comment because a design doc already said the same thing
// and two branches still collided — one creating `scaffold_jobs`,
// `hub_workspaces`, and `hub_token_daily` at versions 2–3 while the other created
// them at 100 and 200. Neither used IF NOT EXISTS, so the merged schema could not
// migrate a fresh database, and nothing failed until someone tried.

describe('migration range ownership', () => {
  test('the shipped sets sit inside their own ranges', () => {
    // These call assertInRange at import time; calling again documents which
    // owner each set belongs to and fails here rather than at import if it moves.
    expect(() => assertInRange('control', CONTROL_MIGRATIONS)).not.toThrow();
    expect(() => assertInRange('hub', HUB_MIGRATIONS)).not.toThrow();
  });

  test('a version outside the range is rejected, naming the range', () => {
    const stray: Migration[] = [{ version: 3, name: 'hub_history', sql: 'SELECT 1' }];
    expect(() => assertInRange('hub', stray)).toThrow(/outside the 'hub' range 200–299/);
  });

  test('the ranges do not overlap', () => {
    const bands = Object.entries(MIGRATION_RANGES).sort((a, b) => a[1][0] - b[1][0]);
    for (let i = 1; i < bands.length; i++) {
      const [prevName, [, prevHi]] = bands[i - 1]!;
      const [name, [lo]] = bands[i]!;
      expect({ pair: `${prevName}→${name}`, ok: prevHi < lo }).toEqual({
        pair: `${prevName}→${name}`,
        ok: true,
      });
    }
  });

  test('every owner in MIGRATION_RANGES is a well-formed band', () => {
    for (const [owner, [lo, hi]] of Object.entries(MIGRATION_RANGES)) {
      expect({ owner, ok: lo > 0 && hi >= lo }).toEqual({ owner, ok: true });
    }
  });
});

// ─── every set together, on one fresh database ───────────────────────────────
//
// The check that was actually missing. `assertInRange` constrains *numbers*; the
// collision was over *tables* — two owners each running `CREATE TABLE
// scaffold_jobs`, at 100 and at 2, neither with IF NOT EXISTS. Numbering was
// never the problem, and a comment saying "a range is a claim on tables" is not a
// check.
//
// Applying every set the repo knows about to a virgin database is. This is the
// check that was missing when both branches independently created
// `scaffold_jobs`, `hub_workspaces` and `hub_token_daily`: the ranges were
// documented and respected, and the merged schema still could not migrate a
// fresh database, because a range is a claim on *tables* and nothing enforced
// that half. An overlap now fails here rather than on someone's first boot.

if (PG_URL) {
  describe('all migration sets on one database', () => {
    const OWNED: Array<{ owner: MigrationOwner; set: readonly Migration[] }> = [
      { owner: 'engine', set: ENGINE_MIGRATIONS },
      { owner: 'control', set: CONTROL_MIGRATIONS },
      { owner: 'hub', set: HUB_MIGRATIONS },
    ];

    test('no two owners create the same table', async () => {
      const created = new Map<string, MigrationOwner>();
      const clashes: string[] = [];
      for (const { owner, set } of OWNED) {
        for (const m of set) {
          for (const [, table] of m.sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)) {
            const prior = created.get(table!);
            if (prior && prior !== owner) clashes.push(`${table} (${prior} and ${owner})`);
            created.set(table!, owner);
          }
        }
      }
      expect(clashes).toEqual([]);
      // A sanity floor: if the regex ever stops matching, the test above passes
      // vacuously and this is what notices.
      expect(created.size).toBeGreaterThan(5);
    });

    test('a store opened the way the CLI opens it can use every table', async () => {
      // The regression: `withStore` applied only the engine set, but the engine
      // store reads `scaffold_jobs`, which the control plane creates. A fresh
      // database therefore migrated "successfully" and then died on step 4 of
      // the documented setup with a raw `relation does not exist`.
      //
      // Asserted through a real store against real DDL, because the shape of
      // the bug was exactly that every string-level check passed.
      const sql = openSql(PG_URL, { maxConnections: 1 });
      const schema = `cliopen_${process.pid}`;
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        await sql.unsafe(`SET search_path TO ${schema}`);

        await migrateAll(sql);

        // One table from each owner, so a future split fails here.
        for (const table of ['workflow_runs', 'scaffold_jobs', 'tickets', 'hub_workspaces']) {
          const rows = (await sql.unsafe(
            `SELECT to_regclass('${schema}.${table}') AS t`,
          )) as Array<{ t: string | null }>;
          expect(rows[0]?.t, `${table} was not created`).not.toBeNull();
        }
      } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.close();
      }
    });

    test('applying every set to a virgin schema succeeds', async () => {
      // Real DDL against a real server, because the failure mode is a Postgres
      // error on the second CREATE TABLE — no string comparison reaches that.
      //
      // A schema rather than a database: `CREATE DATABASE` copies a template and
      // takes server-wide locks, so under `bun test`'s parallelism it contended
      // with the other Postgres suites and timed out. A schema is cheap, and one
      // connection with `search_path` pointed at it gives the same isolation.
      const sql = openSql(PG_URL, { maxConnections: 1 });
      const schema = `allsets_${process.pid}`;
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        await sql.unsafe(`SET search_path TO ${schema}`);

        for (const { set } of OWNED) {
          const applied = await applyMigrations(sql, set);
          expect(applied).toEqual(set.map((m) => m.version).sort((a, b) => a - b));
        }
        // Again, to prove each set stays idempotent over the others' schema.
        for (const { set } of OWNED) {
          expect(await applyMigrations(sql, set)).toEqual([]);
        }
      } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.close();
      }
    });
  });
}
