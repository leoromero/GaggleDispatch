/**
 * One suite, run against every Store implementation.
 *
 * MemoryStore always runs. PostgresStore runs only when TEST_DATABASE_URL is
 * set — CI without a database still gets full coverage of the semantics the
 * engine depends on, and a developer with `docker compose up -d` gets
 * confirmation that the real driver agrees.
 *
 *   docker compose up -d
 *   TEST_DATABASE_URL=postgres://gaggle:gaggle@localhost:5433/gaggle_test bun test store-conformance
 */

import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../executor/store/memory.ts';
import { PostgresStore } from '../executor/store/postgres.ts';
import type { CreateRunInput, Store } from '../executor/store/types.ts';

const PG_URL = process.env.TEST_DATABASE_URL ?? '';

function runInput(over: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    id: randomUUID(),
    workflow_name: 'gaggle/test',
    workflow_source: '/tmp/test.yaml',
    workflow_hash: 'hash-1',
    user_message: 'do the thing',
    repo_slug: 'acme-api',
    working_path: '/repos/acme-api',
    ...over,
  };
}

/** Postgres truncates to microseconds and clocks can tie; nudge ordering apart. */
const tick = () => Bun.sleep(2);

/** Asserts a promise rejects. Hand-rolled because Bun's `.rejects` matcher
 *  hangs on driver-thrown errors rather than failing. */
async function expectRejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

function suite(name: string, getStore: () => Promise<Store>) {
  describe(`Store conformance — ${name}`, () => {
    let store: Store;

    beforeEach(async () => {
      store = await getStore();
    });

    // ── runs ────────────────────────────────────────────────────────────────

    test('createRun starts pending with activity stamped', async () => {
      const row = await store.createRun(runInput());
      expect(row.status).toBe('pending');
      expect(row.last_activity_at).not.toBeNull();
      expect(row.completed_at).toBeNull();
      expect(row.dry_run).toBe(false);
      expect(row.metadata).toEqual({});
    });

    test('getRun round-trips env and metadata as objects', async () => {
      const input = runInput({
        env: { GAGGLE_ISSUE_ID: 'ISS-1' },
        metadata: { approval: { nodeId: 'gate', message: 'ok?' } },
      });
      await store.createRun(input);
      const got = await store.getRun(input.id);
      expect(got?.env).toEqual({ GAGGLE_ISSUE_ID: 'ISS-1' });
      expect(got?.metadata.approval?.message).toBe('ok?');
    });

    test('getRun returns null for an unknown id', async () => {
      expect(await store.getRun(randomUUID())).toBeNull();
    });

    test('updateRun shallow-merges metadata instead of replacing it', async () => {
      const input = runInput({ metadata: { cancel_reason: 'none', approval: { nodeId: 'a' } } });
      await store.createRun(input);
      await store.updateRun(input.id, { metadata: { approval: { nodeId: 'b' } } });
      const got = await store.getRun(input.id);
      // approval replaced wholesale, cancel_reason untouched — that is the
      // `||` jsonb operator's shallow-merge behaviour.
      expect(got?.metadata.approval).toEqual({ nodeId: 'b' });
      expect(got?.metadata.cancel_reason).toBe('none');
    });

    test('updateRun with an empty patch is a no-op read', async () => {
      const input = runInput();
      await store.createRun(input);
      const got = await store.updateRun(input.id, {});
      expect(got?.id).toBe(input.id);
    });

    test('listRuns filters by status, repo and working path', async () => {
      const a = runInput({ repo_slug: 'api', working_path: '/repos/api' });
      const b = runInput({ repo_slug: 'web', working_path: '/repos/web' });
      await store.createRun(a);
      await store.createRun(b);
      await store.updateRun(b.id, { status: 'running' });

      expect((await store.listRuns({ status: ['running'] })).map((r) => r.id)).toEqual([b.id]);
      expect((await store.listRuns({ repo_slug: 'api' })).map((r) => r.id)).toEqual([a.id]);
      expect(
        (await store.listRuns({ working_path_contains: 'web' })).map((r) => r.id),
      ).toEqual([b.id]);
    });

    test('listRuns returns newest first and honours limit', async () => {
      const first = runInput();
      await store.createRun(first);
      await tick();
      const second = runInput();
      await store.createRun(second);

      const all = await store.listRuns();
      expect(all[0]!.id).toBe(second.id);
      expect(await store.listRuns({ limit: 1 })).toHaveLength(1);
    });

    // ── leases ──────────────────────────────────────────────────────────────

    test('a lease is exclusive while it is live', async () => {
      const input = runInput();
      await store.createRun(input);
      expect(await store.acquireLease(input.id, 'host:1', 60_000)).toBe(true);
      expect(await store.acquireLease(input.id, 'host:2', 60_000)).toBe(false);
      // Re-acquiring your own lease is a renewal, not a conflict.
      expect(await store.acquireLease(input.id, 'host:1', 60_000)).toBe(true);
    });

    test('an expired lease can be stolen', async () => {
      const input = runInput();
      await store.createRun(input);
      await store.acquireLease(input.id, 'host:1', 1);
      await Bun.sleep(1100);
      expect(await store.acquireLease(input.id, 'host:2', 60_000)).toBe(true);
    });

    test('releaseLease only honours the current owner', async () => {
      const input = runInput();
      await store.createRun(input);
      await store.acquireLease(input.id, 'host:1', 60_000);
      await store.releaseLease(input.id, 'host:2');
      expect((await store.getRun(input.id))?.lease_owner).toBe('host:1');
      await store.releaseLease(input.id, 'host:1');
      expect((await store.getRun(input.id))?.lease_owner).toBeNull();
    });

    test('findExpiredRuns sees only running rows with a lapsed lease', async () => {
      const live = runInput();
      const dead = runInput();
      const donePg = runInput();
      for (const r of [live, dead, donePg]) await store.createRun(r);

      await store.updateRun(live.id, { status: 'running' });
      await store.acquireLease(live.id, 'host:1', 60_000);

      await store.updateRun(dead.id, { status: 'running' }); // never leased

      await store.updateRun(donePg.id, { status: 'completed' });

      const expired = (await store.findExpiredRuns()).map((r) => r.id);
      expect(expired).toContain(dead.id);
      expect(expired).not.toContain(live.id);
      expect(expired).not.toContain(donePg.id);
    });

    // ── nodes ───────────────────────────────────────────────────────────────

    test('upsertNode preserves captured output across later status writes', async () => {
      const input = runInput();
      await store.createRun(input);
      await store.upsertNode({
        run_id: input.id,
        node_id: 'classify',
        node_type: 'prompt',
        status: 'completed',
        output: 'bug',
        output_json: { issue_type: 'bug' },
        claude_session_id: 'sess-1',
      });
      // A bare status write must not blank the stored result.
      await store.upsertNode({
        run_id: input.id,
        node_id: 'classify',
        node_type: 'prompt',
        status: 'completed',
      });
      const n = await store.getNode(input.id, 'classify');
      expect(n?.output).toBe('bug');
      expect(n?.output_json).toEqual({ issue_type: 'bug' });
      expect(n?.claude_session_id).toBe('sess-1');
    });

    test('upsertNode keeps the original started_at', async () => {
      const input = runInput();
      await store.createRun(input);
      const first = new Date(Date.now() - 60_000).toISOString();
      await store.upsertNode({
        run_id: input.id,
        node_id: 'n',
        node_type: 'bash',
        status: 'running',
        started_at: first,
      });
      await store.upsertNode({
        run_id: input.id,
        node_id: 'n',
        node_type: 'bash',
        status: 'completed',
        started_at: new Date().toISOString(),
      });
      const n = await store.getNode(input.id, 'n');
      expect(Date.parse(n!.started_at!)).toBe(Date.parse(first));
    });

    test('markRunningNodesInterrupted touches only running nodes', async () => {
      const input = runInput();
      await store.createRun(input);
      await store.upsertNode({ run_id: input.id, node_id: 'a', node_type: 'bash', status: 'completed' });
      await store.upsertNode({ run_id: input.id, node_id: 'b', node_type: 'bash', status: 'running' });

      const hit = await store.markRunningNodesInterrupted(input.id);
      expect(hit.map((n) => n.node_id)).toEqual(['b']);
      expect((await store.getNode(input.id, 'a'))?.status).toBe('completed');
      expect((await store.getNode(input.id, 'b'))?.status).toBe('interrupted');
    });

    test('getNodes is scoped to the run', async () => {
      const a = runInput();
      const b = runInput();
      await store.createRun(a);
      await store.createRun(b);
      await store.upsertNode({ run_id: a.id, node_id: 'x', node_type: 'bash', status: 'pending' });
      await store.upsertNode({ run_id: b.id, node_id: 'y', node_type: 'bash', status: 'pending' });
      expect((await store.getNodes(a.id)).map((n) => n.node_id)).toEqual(['x']);
    });

    // ── loop iterations ─────────────────────────────────────────────────────

    test('loop iterations are ordered and upsertable', async () => {
      const input = runInput();
      await store.createRun(input);
      await store.appendLoopIteration({
        run_id: input.id, node_id: 'impl', iteration: 2, output: 'two', user_input: null, completed: false,
      });
      await store.appendLoopIteration({
        run_id: input.id, node_id: 'impl', iteration: 1, output: 'one', user_input: 'go', completed: false,
      });
      await store.appendLoopIteration({
        run_id: input.id, node_id: 'impl', iteration: 2, output: 'two-final', user_input: null, completed: true,
      });

      const its = await store.getLoopIterations(input.id, 'impl');
      expect(its.map((i) => i.iteration)).toEqual([1, 2]);
      expect(its[0]!.user_input).toBe('go');
      expect(its[1]!.output).toBe('two-final');
      expect(its[1]!.completed).toBe(true);
    });

    // ── events ──────────────────────────────────────────────────────────────

    test('events are monotonic and filterable by sinceId', async () => {
      const input = runInput();
      await store.createRun(input);
      await store.appendEvent(input.id, 'run_started', null);
      await store.appendEvent(input.id, 'node_started', 'a', { node_type: 'bash' });
      await store.appendEvent(input.id, 'node_completed', 'a');

      const all = await store.listEvents(input.id);
      expect(all.map((e) => e.event_type)).toEqual(['run_started', 'node_started', 'node_completed']);
      expect(all[0]!.id).toBeLessThan(all[1]!.id);
      expect(all[1]!.data).toEqual({ node_type: 'bash' });
      expect(await store.listEvents(input.id, all[1]!.id)).toHaveLength(1);
    });

    // ── approvals ───────────────────────────────────────────────────────────

    test('a run may hold only one pending gate at a time', async () => {
      const input = runInput();
      await store.createRun(input);
      await store.createApproval({ id: randomUUID(), run_id: input.id, node_id: 'gate-1', message: 'first?' });
      const err = await expectRejection(
        store.createApproval({ id: randomUUID(), run_id: input.id, node_id: 'gate-2', message: 'second?' }),
      );
      expect(err).toBeInstanceOf(Error);
    });

    test('deciding a gate frees the run for the next one', async () => {
      const input = runInput();
      await store.createRun(input);
      const first = randomUUID();
      await store.createApproval({ id: first, run_id: input.id, node_id: 'gate-1', message: 'first?' });

      const decided = await store.decideApproval(first, 'approved', 'looks good');
      expect(decided?.decision).toBe('approved');
      expect(decided?.comment).toBe('looks good');
      expect(decided?.decided_at).not.toBeNull();
      expect(await store.getPendingApproval(input.id)).toBeNull();

      await store.createApproval({ id: randomUUID(), run_id: input.id, node_id: 'gate-2', message: 'second?' });
      expect((await store.getPendingApproval(input.id))?.node_id).toBe('gate-2');
    });

    test('deciding an already-decided gate is refused', async () => {
      const input = runInput();
      await store.createRun(input);
      const id = randomUUID();
      await store.createApproval({ id, run_id: input.id, node_id: 'gate', message: 'go?' });
      await store.decideApproval(id, 'approved', null);
      expect(await store.decideApproval(id, 'rejected', 'changed my mind')).toBeNull();
    });

    test('rework attempts accumulate', async () => {
      const input = runInput();
      await store.createRun(input);
      const id = randomUUID();
      await store.createApproval({ id, run_id: input.id, node_id: 'gate', message: 'go?' });
      expect(await store.incrementReworkAttempts(id)).toBe(1);
      expect(await store.incrementReworkAttempts(id)).toBe(2);
    });

    // ── worktrees ───────────────────────────────────────────────────────────

    test('worktrees are unique per repo+branch and upsert in place', async () => {
      await store.upsertWorktree({
        id: randomUUID(), repo_slug: 'api', branch: 'fix/a',
        path: '/wt/a', base_branch: 'main', run_id: null,
      });
      await store.upsertWorktree({
        id: randomUUID(), repo_slug: 'api', branch: 'fix/a',
        path: '/wt/a-moved', base_branch: 'main', run_id: null,
      });
      const all = await store.listWorktrees('api');
      expect(all).toHaveLength(1);
      expect(all[0]!.path).toBe('/wt/a-moved');
    });

    test('worktrees can be looked up and deleted by repo+branch', async () => {
      await store.upsertWorktree({
        id: randomUUID(), repo_slug: 'api', branch: 'fix/b',
        path: '/wt/b', base_branch: null, run_id: null,
      });
      expect(await store.getWorktree('api', 'fix/b')).not.toBeNull();
      await store.deleteWorktree('api', 'fix/b');
      expect(await store.getWorktree('api', 'fix/b')).toBeNull();
    });

    test('listWorktrees scopes by repo', async () => {
      await store.upsertWorktree({
        id: randomUUID(), repo_slug: 'api', branch: 'x', path: '/wt/x', base_branch: null, run_id: null,
      });
      await store.upsertWorktree({
        id: randomUUID(), repo_slug: 'web', branch: 'y', path: '/wt/y', base_branch: null, run_id: null,
      });
      expect(await store.listWorktrees('api')).toHaveLength(1);
      expect(await store.listWorktrees()).toHaveLength(2);
    });
  });
}

// A fresh MemoryStore per test — it owns no connections, so this is free and
// guarantees isolation.
suite('MemoryStore', async () => {
  const s = new MemoryStore();
  await s.migrate();
  return s;
});

if (PG_URL) {
  // One PostgresStore for the whole file: each instance owns a connection
  // pool, so building one per test exhausts max_connections. Isolation comes
  // from wiping rows instead.
  let pg: PostgresStore | null = null;
  suite('PostgresStore', async () => {
    if (!pg) {
      pg = new PostgresStore(PG_URL, { maxConnections: 5 });
      await pg.migrate();
    }
    // DELETE rather than TRUNCATE: TRUNCATE takes an ACCESS EXCLUSIVE lock and
    // blocks behind any other pooled connection, turning a flake into a hang.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = (pg as any).sql;
    await sql.unsafe('DELETE FROM worktrees');
    await sql.unsafe('DELETE FROM workflow_runs'); // children cascade
    return pg;
  });
  afterAll(async () => {
    await pg?.close();
  });
} else {
  describe('Store conformance — PostgresStore', () => {
    test.skip('set TEST_DATABASE_URL to run against a real database', () => {});
  });
}
