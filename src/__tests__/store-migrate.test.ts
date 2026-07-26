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
import { applyMigrations, currentVersion, pendingVersions, type Migration } from '../store/migrate.ts';
import { openSql, type Sql } from '../store/sql.ts';

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
