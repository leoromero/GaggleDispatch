/**
 * Crash recovery (resume level R3).
 *
 * Most of these simulate a dead executor by leaving a run `running` with a
 * lapsed lease, which is exactly the state a killed process leaves behind. The
 * last block does it for real: a child process starts a run, is killed
 * mid-node, and recovery drives it to completion in a fresh process. That one
 * needs a database that outlives the child, so it is Postgres-gated.
 */

import { describe, expect, test, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../executor/store/memory.ts';
import { PostgresStore } from '../executor/store/postgres.ts';
import { GaggleExecutor } from '../executor/engine/index.ts';
import { recoverInterruptedRuns, buildAtMostOnceGateMessage } from '../executor/engine/recovery.ts';
import type { AiResult, AiRunner } from '../executor/engine/provider/claude.ts';
import type { Store } from '../executor/store/types.ts';
import { resolveBashPath } from '../executor/engine/shell.ts';
import { killTree } from '../executor/engine/nodes/shell.ts';

const PG_URL = process.env.TEST_DATABASE_URL ?? '';
const BASH = resolveBashPath();

let repo: string;
let store: MemoryStore;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gaggle-rec-'));
  mkdirSync(join(repo, '.gaggle', 'workflows'), { recursive: true });
  store = new MemoryStore();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const okAi: AiRunner = async () =>
  ({ text: 'ok', sessionId: null, inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false }) as AiResult;

function writeWorkflow(name: string, yaml: string): void {
  writeFileSync(join(repo, '.gaggle', 'workflows', `${name}.yaml`), yaml);
}

function makeExecutor(s: Store, ai: AiRunner = okAi): GaggleExecutor {
  return new GaggleExecutor({
    store: s,
    artifactsRoot: join(repo, '.artifacts'),
    ai,
    bashPath: BASH ?? undefined,
    config: { bashTimeoutMs: 20_000, nodeIdleTimeoutMs: 20_000 },
  });
}

/**
 * Put a run into the exact state a killed executor leaves behind: status
 * `running`, one node `running`, and no live lease.
 */
async function simulateCrash(
  s: Store,
  opts: { workflowName: string; nodeId: string; sideEffects?: 'idempotent' | 'at_most_once' },
): Promise<string> {
  const id = randomUUID();
  await s.createRun({
    id,
    workflow_name: opts.workflowName,
    workflow_source: join(repo, '.gaggle', 'workflows', `${opts.workflowName}.yaml`),
    workflow_hash: 'stale-hash',
    user_message: 'm',
    working_path: repo,
  });
  await s.updateRun(id, { status: 'running' });
  await s.upsertNode({
    run_id: id,
    node_id: opts.nodeId,
    node_type: 'prompt',
    status: 'running',
    side_effects: opts.sideEffects ?? 'idempotent',
  });
  // No lease acquired, so the run reads as abandoned.
  return id;
}

describe('buildAtMostOnceGateMessage', () => {
  test('names the node and explains the risk', () => {
    const msg = buildAtMostOnceGateMessage([
      { node_id: 'create-pr', side_effects: 'at_most_once' } as never,
    ]);
    expect(msg).toContain("'create-pr'");
    expect(msg).toContain('at_most_once');
    expect(msg).toContain('duplicate');
  });

  test('reads correctly for several nodes', () => {
    const msg = buildAtMostOnceGateMessage([
      { node_id: 'a', side_effects: 'at_most_once' } as never,
      { node_id: 'b', side_effects: 'at_most_once' } as never,
    ]);
    expect(msg).toContain("'a', 'b'");
    expect(msg).toContain('were');
  });
});

describe('recoverInterruptedRuns', () => {
  test('finds nothing when no run has a lapsed lease', async () => {
    expect(await recoverInterruptedRuns({ store, executor: makeExecutor(store) })).toEqual([]);
  });

  test('ignores a run whose lease is still live', async () => {
    const id = await simulateCrash(store, { workflowName: 'w', nodeId: 'a' });
    await store.acquireLease(id, 'other-host:99', 60_000);
    expect(await recoverInterruptedRuns({ store, executor: makeExecutor(store) })).toEqual([]);
  });

  test('marks in-flight nodes interrupted and the run recoverable', async () => {
    const id = await simulateCrash(store, { workflowName: 'w', nodeId: 'stuck' });
    const [res] = await recoverInterruptedRuns({ store, executor: makeExecutor(store) });

    expect(res!.action).toBe('marked_interrupted');
    expect(res!.interrupted_nodes).toEqual(['stuck']);
    expect((await store.getRun(id))!.status).toBe('interrupted');
    expect((await store.getNode(id, 'stuck'))!.status).toBe('interrupted');
  });

  test('leaves completed nodes alone', async () => {
    const id = await simulateCrash(store, { workflowName: 'w', nodeId: 'running-one' });
    await store.upsertNode({
      run_id: id, node_id: 'done-one', node_type: 'bash', status: 'completed', output: 'kept',
    });
    await recoverInterruptedRuns({ store, executor: makeExecutor(store) });
    const done = (await store.getNode(id, 'done-one'))!;
    expect(done.status).toBe('completed');
    expect(done.output).toBe('kept');
  });

  test('records why the run was interrupted', async () => {
    const id = await simulateCrash(store, { workflowName: 'w', nodeId: 'a' });
    await recoverInterruptedRuns({ store, executor: makeExecutor(store) });
    expect((await store.getRun(id))!.metadata.interrupted_reason).toContain('lease expired');
    const events = (await store.listEvents(id)).map((e) => e.event_type);
    expect(events).toContain('run_interrupted');
  });

  test('releases the lease so a later pass can pick the run up', async () => {
    const id = await simulateCrash(store, { workflowName: 'w', nodeId: 'a' });
    await recoverInterruptedRuns({ store, executor: makeExecutor(store) });
    expect((await store.getRun(id))!.lease_owner).toBeNull();
  });

  test('an at_most_once node parks the run for human review instead of resuming', async () => {
    const id = await simulateCrash(store, {
      workflowName: 'w', nodeId: 'create-pr', sideEffects: 'at_most_once',
    });
    const [res] = await recoverInterruptedRuns({
      store, executor: makeExecutor(store), autoResume: true,
    });

    expect(res!.action).toBe('parked_for_review');
    const run = (await store.getRun(id))!;
    expect(run.status).toBe('paused');
    expect(run.metadata.approval?.nodeId).toBe('create-pr');
    expect(run.metadata.approval?.message).toContain('duplicate');

    const gate = await store.getPendingApproval(id);
    expect(gate?.node_id).toBe('create-pr');
  });

  test('does not create a second gate when one is already pending', async () => {
    const id = await simulateCrash(store, {
      workflowName: 'w', nodeId: 'create-pr', sideEffects: 'at_most_once',
    });
    await store.createApproval({
      id: randomUUID(), run_id: id, node_id: 'create-pr', message: 'existing',
    });
    // The one-pending-gate constraint would throw if recovery created another.
    const [res] = await recoverInterruptedRuns({ store, executor: makeExecutor(store) });
    expect(res!.action).toBe('parked_for_review');
    expect((await store.getPendingApproval(id))!.message).toBe('existing');
  });

  test('a mixed run parks if any interrupted node is at_most_once', async () => {
    const id = await simulateCrash(store, { workflowName: 'w', nodeId: 'safe' });
    await store.upsertNode({
      run_id: id, node_id: 'risky', node_type: 'prompt', status: 'running',
      side_effects: 'at_most_once',
    });
    const [res] = await recoverInterruptedRuns({ store, executor: makeExecutor(store) });
    expect(res!.action).toBe('parked_for_review');
    expect(res!.interrupted_nodes.sort()).toEqual(['risky', 'safe']);
  });

  test('autoResume drives an idempotent run to completion', async () => {
    writeWorkflow(
      'resumable',
      `name: resumable\ndescription: d\nnodes:\n  - id: a\n    prompt: "one"\n  - id: b\n    depends_on: [a]\n    prompt: "two"`,
    );
    const exec = makeExecutor(store);

    // Start the run properly so the workflow hash matches, then simulate the
    // executor dying part-way through.
    const handle = await exec.startRun({ workflow: 'resumable', cwd: repo, message: 'm' }, () => {});
    await handle.done;
    await store.updateRun(handle.run_id, { status: 'running' });
    await store.upsertNode({
      run_id: handle.run_id, node_id: 'b', node_type: 'prompt', status: 'running',
    });
    await store.releaseLease(handle.run_id, `${require('node:os').hostname()}:${process.pid}`);

    const [res] = await recoverInterruptedRuns({ store, executor: exec, autoResume: true });
    expect(res!.action).toBe('resumed');
    await Bun.sleep(200);
    expect((await store.getRun(handle.run_id))!.status).toBe('completed');
  });

  test('reports a resume that could not start rather than throwing', async () => {
    // The workflow file does not exist, so resolution fails.
    const id = await simulateCrash(store, { workflowName: 'missing-workflow', nodeId: 'a' });
    const [res] = await recoverInterruptedRuns({
      store, executor: makeExecutor(store), autoResume: true,
    });
    expect(res!.action).toBe('resume_failed');
    expect(res!.detail).toContain('not found');
    expect((await store.getRun(id))!.status).toBe('interrupted');
  });

  test('handles several crashed runs in one pass', async () => {
    await simulateCrash(store, { workflowName: 'w', nodeId: 'a' });
    await simulateCrash(store, { workflowName: 'w', nodeId: 'b' });
    const results = await recoverInterruptedRuns({ store, executor: makeExecutor(store) });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.action === 'marked_interrupted')).toBe(true);
  });
});

// ── a genuine process kill ──────────────────────────────────────────────────

describe('kill and resume, for real', () => {
  const gated = PG_URL && BASH ? test : test.skip;
  let pg: PostgresStore | null = null;

  afterAll(async () => {
    await pg?.close();
  });

  gated(
    'a killed executor leaves a run another process can finish',
    async () => {
      pg = new PostgresStore(PG_URL, { maxConnections: 4 });
      await pg.migrate();

      const marker = join(repo, 'phase-two-ran.txt').replace(/\\/g, '/');
      // Node 'slow' outlives the kill; 'after' proves the resumed run got past it.
      writeWorkflow(
        'crashy',
        `name: crashy
description: d
nodes:
  - id: slow
    bash: "sleep 30; echo done"
    timeout: 60000
  - id: after
    depends_on: [slow]
    bash: "echo second > '${marker}'; echo ok"
`,
      );

      // A child process starts the run and is killed while 'slow' is running.
      const child = join(repo, 'child.ts');
      const enginePath = join(process.cwd(), 'src', 'executor', 'engine', 'index.ts').replace(/\\/g, '/');
      const storePath = join(process.cwd(), 'src', 'executor', 'store', 'postgres.ts').replace(/\\/g, '/');
      writeFileSync(
        child,
        `
const { GaggleExecutor } = await import(${JSON.stringify(enginePath)});
const { PostgresStore } = await import(${JSON.stringify(storePath)});
const store = new PostgresStore(process.env.U, { maxConnections: 2 });
await store.migrate();
const exec = new GaggleExecutor({
  store,
  artifactsRoot: ${JSON.stringify(join(repo, '.artifacts').replace(/\\/g, '/'))},
  bashPath: ${JSON.stringify(BASH!.replace(/\\/g, '/'))},
  config: { leaseTtlMs: 5000, leaseHeartbeatMs: 1000 },
});
const h = await exec.startRun(
  { workflow: 'crashy', cwd: ${JSON.stringify(repo.replace(/\\/g, '/'))}, message: 'm' },
  () => {},
);
console.log('RUN_ID=' + h.run_id);
await h.done;
`,
      );

      const proc = Bun.spawn(['bun', child], {
        env: { ...process.env, U: PG_URL } as Record<string, string>,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Read until the child reports its run id, then kill it mid-node.
      let runId = '';
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      const deadline = Date.now() + 30_000;
      let buf = '';
      while (!runId && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const m = buf.match(/RUN_ID=([0-9a-f-]{36})/);
        if (m) runId = m[1]!;
      }
      expect(runId).toMatch(/^[0-9a-f-]{36}$/);

      await Bun.sleep(1500); // let the node get properly under way

      // killTree, not proc.kill: on Windows the child survives a plain kill
      // and keeps renewing its lease, so the run never looks crashed. This is
      // the same failure mode the engine's node timeout had.
      killTree(proc.pid!);
      proc.kill();
      await proc.exited;

      // The run is still 'running' with a lease that will lapse.
      expect((await pg.getRun(runId))!.status).toBe('running');

      // Wait out the 5s lease, then recover in this process.
      await Bun.sleep(6000);
      const exec = makeExecutor(pg);
      const results = await recoverInterruptedRuns({
        store: pg,
        executor: exec,
        autoResume: true,
        leaseTtlMs: 30_000,
      });
      const mine = results.find((r) => r.run_id === runId);
      expect(mine?.action).toBe('resumed');

      // Give the resumed run time to redo 'slow' and reach 'after'.
      const finish = Date.now() + 90_000;
      let status = '';
      while (Date.now() < finish) {
        status = (await pg.getRun(runId))!.status;
        if (status === 'completed' || status === 'failed') break;
        await Bun.sleep(1000);
      }
      expect(status).toBe('completed');
      expect(existsSync(join(repo, 'phase-two-ran.txt'))).toBe(true);
    },
    180_000,
  );
});
