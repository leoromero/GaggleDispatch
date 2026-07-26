/**
 * Hub history on Postgres.
 *
 * Skipped without TEST_DATABASE_URL — there is no in-memory implementation here
 * because, unlike the control store, nothing depends on this contract closely
 * enough to be worth a second implementation. The log panel degrades to empty
 * when it is unavailable, which is the whole risk profile.
 */

import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { HistoryStore, openHistoryStore } from '../hub/history.ts';

const PG_URL = process.env.TEST_DATABASE_URL ?? '';

if (!PG_URL) {
  describe('HistoryStore', () => {
    test.skip('set TEST_DATABASE_URL to run against real Postgres', () => {});
  });
} else {
  describe('HistoryStore', () => {
    let store: HistoryStore;
    let wsId: number;

    beforeEach(async () => {
      store = new HistoryStore(PG_URL);
      await store.migrate();
      // TRUNCATE via a fresh workspace name per run would leak rows; clear instead.
      await (store as unknown as { sql: (s: TemplateStringsArray) => Promise<unknown> })
        .sql`TRUNCATE hub_log_events, hub_token_daily, hub_workspaces RESTART IDENTITY CASCADE`;
      wsId = (await store.upsertWorkspace('acme', '/repos/acme', '#4f9cf9')).id;
    });

    afterAll(async () => {
      await store.close();
    });

    test('upsertWorkspace is idempotent on name and refreshes the rest', async () => {
      const again = await store.upsertWorkspace('acme', '/moved', '#ff0000');
      expect(again.id).toBe(wsId);
      expect(again.path).toBe('/moved');
      expect(again.color).toBe('#ff0000');
    });

    test('log events round-trip, newest first', async () => {
      await store.appendLog({
        workspace_id: wsId,
        ts: '2026-07-01T00:00:00.000Z',
        level: 'info',
        message: 'first',
      });
      await store.appendLog({
        workspace_id: wsId,
        ts: '2026-07-02T00:00:00.000Z',
        level: 'warn',
        message: 'second',
        issue_id: 'lin-1',
        repo_alias: 'api',
        session_id: 's1',
        fields: { attempt: 2 },
      });

      const logs = await store.queryLogs({});
      expect(logs.map((l) => l.message)).toEqual(['second', 'first']);
      expect(logs[0]!.fields).toEqual({ attempt: 2 });
      expect(logs[0]!.repo_alias).toBe('api');
      expect(logs[1]!.fields).toBeNull();
    });

    test('each filter narrows independently, and an absent filter means no filter', async () => {
      await store.appendLog({ workspace_id: wsId, ts: '2026-07-01T00:00:00.000Z', level: 'info', message: 'a', issue_id: 'i1', repo_alias: 'api' });
      await store.appendLog({ workspace_id: wsId, ts: '2026-07-02T00:00:00.000Z', level: 'error', message: 'b', issue_id: 'i2', repo_alias: 'web' });

      expect(await store.queryLogs({})).toHaveLength(2);
      expect((await store.queryLogs({ level: 'error' })).map((l) => l.message)).toEqual(['b']);
      expect((await store.queryLogs({ issue_id: 'i1' })).map((l) => l.message)).toEqual(['a']);
      expect((await store.queryLogs({ repo_alias: 'web' })).map((l) => l.message)).toEqual(['b']);
      expect((await store.queryLogs({ since: '2026-07-01T12:00:00.000Z' })).map((l) => l.message)).toEqual(['b']);
      expect(await store.queryLogs({ workspace_id: wsId })).toHaveLength(2);
      expect(await store.queryLogs({ workspace_id: 99999 })).toHaveLength(0);
      expect(await store.queryLogs({ limit: 1 })).toHaveLength(1);
    });

    test('filters combine', async () => {
      await store.appendLog({ workspace_id: wsId, ts: '2026-07-01T00:00:00.000Z', level: 'error', message: 'a', repo_alias: 'api' });
      await store.appendLog({ workspace_id: wsId, ts: '2026-07-01T00:00:00.000Z', level: 'error', message: 'b', repo_alias: 'web' });
      expect((await store.queryLogs({ level: 'error', repo_alias: 'api' })).map((l) => l.message)).toEqual(['a']);
    });

    test('retention drops old events and keeps recent ones', async () => {
      const shortLived = new HistoryStore(PG_URL, 1);
      await store.appendLog({ workspace_id: wsId, ts: '2020-01-01T00:00:00.000Z', level: 'info', message: 'ancient' });
      await store.appendLog({ workspace_id: wsId, ts: new Date().toISOString(), level: 'info', message: 'fresh' });

      expect(await shortLived.pruneOldLogs()).toBe(1);
      expect((await store.queryLogs({})).map((l) => l.message)).toEqual(['fresh']);
      await shortLived.close();
    });

    test('token totals accumulate per day rather than overwriting', async () => {
      await store.addTokens(wsId, 100, 20);
      await store.addTokens(wsId, 50, 5);
      const history = await store.tokenHistory(wsId, 30);
      expect(history).toHaveLength(1);
      expect(history[0]!.tokens_in).toBe(150);
      expect(history[0]!.tokens_out).toBe(25);
    });

    test('token history can span all workspaces', async () => {
      const other = await store.upsertWorkspace('other', '/o', null);
      await store.addTokens(wsId, 10, 1);
      await store.addTokens(other.id, 20, 2);
      expect(await store.tokenHistory(null, 30)).toHaveLength(2);
      expect(await store.tokenHistory(wsId, 30)).toHaveLength(1);
    });

    test('deleting a workspace takes its logs and tokens with it', async () => {
      await store.appendLog({ workspace_id: wsId, ts: new Date().toISOString(), level: 'info', message: 'x' });
      await store.addTokens(wsId, 1, 1);
      await (store as unknown as { sql: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> })
        .sql`DELETE FROM hub_workspaces WHERE id = ${wsId}`;
      expect(await store.queryLogs({})).toHaveLength(0);
      expect(await store.tokenHistory(null, 30)).toHaveLength(0);
    });

    test('openHistoryStore returns null rather than throwing on a bad url', async () => {
      // The nest must still start without history — losing the log panel should
      // not cost an operator the process controls they need to fix it.
      expect(await openHistoryStore('')).toBeNull();
      expect(await openHistoryStore('postgres://nobody:nobody@127.0.0.1:1/none')).toBeNull();
    });
  });
}
