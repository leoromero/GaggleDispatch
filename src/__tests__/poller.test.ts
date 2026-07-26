/**
 * RunPoller.
 *
 * The poller is how the orchestrator follows a run it did not start — one
 * adopted after a restart. A live run needs no poller because the engine emits
 * events directly, which makes this easy to forget about and easy to break:
 * if it stops early or never fires, an adopted run is simply never noticed
 * finishing.
 *
 * Driven with a fake client and a very short interval so the whole file runs
 * in well under a second.
 */

import { describe, expect, test } from 'bun:test';
import { RunPoller, type RunPollerOptions, type RunPollEvent } from '../executor/poller.ts';
import type { ExecutorClient } from '../executor/client.ts';
import type { RunRecord, RunStatus } from '../executor/types.ts';

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    workflow_name: 'gaggle/test',
    user_message: 'm',
    status: 'running',
    working_path: '/repos/api',
    started_at: new Date().toISOString(),
    completed_at: null,
    last_activity_at: new Date().toISOString(),
    metadata: {},
    ...over,
  };
}

/**
 * A client that returns a scripted sequence, one entry per poll. The last
 * entry repeats once the script is exhausted.
 */
function scriptedClient(sequence: Array<RunRecord | null>): {
  client: ExecutorClient;
  calls: () => number;
} {
  let i = 0;
  const client = {
    getRun: async () => {
      const value = sequence[Math.min(i, sequence.length - 1)] ?? null;
      i += 1;
      return value;
    },
  } as unknown as ExecutorClient;
  return { client, calls: () => i };
}

/** Run a poller until it stops or the deadline passes, collecting events. */
async function drain(
  client: ExecutorClient,
  opts: RunPollerOptions = {},
  budgetMs = 400,
): Promise<RunPollEvent[]> {
  const events: RunPollEvent[] = [];
  const poller = new RunPoller(client, 'run-1', (e) => events.push(e), {
    pollIntervalMs: 5,
    ...opts,
  });
  poller.start();
  await Bun.sleep(budgetMs);
  poller.stop();
  return events;
}

const typesOf = (events: RunPollEvent[]) => events.map((e) => e.type);

describe('terminal statuses', () => {
  test('a completed run emits poller_completed and stops', async () => {
    const { client, calls } = scriptedClient([record({ status: 'completed' })]);
    const events = await drain(client, {}, 120);

    expect(typesOf(events)).toContain('poller_completed');
    // Stopped: one poll, not a stream of them over the whole budget.
    expect(calls()).toBe(1);
  });

  test('a failed run reports the status it failed with', async () => {
    const { client } = scriptedClient([record({ status: 'failed' })]);
    const events = await drain(client, {}, 120);
    const failed = events.find((e) => e.type === 'poller_failed');
    expect(failed).toBeDefined();
    expect((failed as { status: RunStatus }).status).toBe('failed');
  });

  test('a cancelled run is reported as failed, carrying the real status', async () => {
    const { client } = scriptedClient([record({ status: 'cancelled' })]);
    const events = await drain(client, {}, 120);
    expect((events.find((e) => e.type === 'poller_failed') as { status: RunStatus }).status).toBe(
      'cancelled',
    );
  });

  test('a terminal status is announced exactly once', async () => {
    const { client } = scriptedClient([record({ status: 'completed' })]);
    const events = await drain(client, {}, 200);
    expect(typesOf(events).filter((t) => t === 'poller_completed')).toHaveLength(1);
  });

  test('a run already terminal on the very first poll still stops', async () => {
    // lastStatus starts null, so the first poll always takes the
    // status-changed branch — but a poller restarted against an
    // already-finished run must not spin either.
    const { client, calls } = scriptedClient([record({ status: 'completed' })]);
    await drain(client, {}, 150);
    expect(calls()).toBe(1);
  });
});

describe('gate pauses', () => {
  test('a paused run emits the gate message from metadata', async () => {
    const { client } = scriptedClient([
      record({ status: 'paused', metadata: { approval: { nodeId: 'g', message: 'Approve?' } } }),
    ]);
    const events = await drain(client, {}, 120);
    const gate = events.find((e) => e.type === 'poller_gate_paused');
    expect(gate).toBeDefined();
    expect((gate as { gate_message: string }).gate_message).toBe('Approve?');
  });

  test('a pause with no recorded message still reports something usable', async () => {
    const { client } = scriptedClient([record({ status: 'paused' })]);
    const events = await drain(client, {}, 120);
    expect((events.find((e) => e.type === 'poller_gate_paused') as { gate_message: string })
      .gate_message).toContain('approval gate');
  });

  test('polling continues while paused, so a decision made elsewhere is noticed', async () => {
    // The human may approve through another surface; the poller has to keep
    // watching rather than treating `paused` as an end state.
    const { client, calls } = scriptedClient([
      record({ status: 'paused' }),
      record({ status: 'paused' }),
      record({ status: 'completed' }),
    ]);
    const events = await drain(client, {}, 200);
    expect(calls()).toBeGreaterThanOrEqual(3);
    expect(typesOf(events)).toContain('poller_gate_paused');
    expect(typesOf(events)).toContain('poller_completed');
  });
});

describe('missing runs', () => {
  test('a transient miss does not give up', async () => {
    const { client } = scriptedClient([null, record({ status: 'completed' })]);
    const events = await drain(client, { maxMissingPolls: 3 }, 200);
    expect(typesOf(events)).not.toContain('poller_run_not_found');
    expect(typesOf(events)).toContain('poller_completed');
  });

  test('a run missing for maxMissingPolls is reported gone, and polling stops', async () => {
    const { client, calls } = scriptedClient([null]);
    const events = await drain(client, { maxMissingPolls: 2 }, 200);
    expect(typesOf(events)).toContain('poller_run_not_found');
    expect(calls()).toBe(2);
  });

  test('the miss counter resets after the run reappears', async () => {
    const { client } = scriptedClient([
      null,
      record({ status: 'running' }),
      null,
      record({ status: 'completed' }),
    ]);
    const events = await drain(client, { maxMissingPolls: 2 }, 250);
    expect(typesOf(events)).not.toContain('poller_run_not_found');
    expect(typesOf(events)).toContain('poller_completed');
  });
});

describe('stall detection', () => {
  test('a frozen last_activity_at on a running run eventually stalls', async () => {
    const frozen = new Date(Date.now() - 60_000).toISOString();
    const { client } = scriptedClient([record({ status: 'running', last_activity_at: frozen })]);
    const events = await drain(client, { stallTimeoutMs: 20 }, 200);
    expect(typesOf(events)).toContain('poller_stalled');
  });

  test('a paused run never counts as stalled', async () => {
    // Waiting on a human is a legitimate idle state. Counting it produced
    // false positives that killed live work in the previous implementation.
    const frozen = new Date(Date.now() - 60_000).toISOString();
    const { client } = scriptedClient([record({ status: 'paused', last_activity_at: frozen })]);
    const events = await drain(client, { stallTimeoutMs: 20 }, 200);
    expect(typesOf(events)).not.toContain('poller_stalled');
  });

  test('a pending run never counts as stalled', async () => {
    const frozen = new Date(Date.now() - 60_000).toISOString();
    const { client } = scriptedClient([record({ status: 'pending', last_activity_at: frozen })]);
    const events = await drain(client, { stallTimeoutMs: 20 }, 200);
    expect(typesOf(events)).not.toContain('poller_stalled');
  });

  test('stallTimeoutMs of 0 disables detection', async () => {
    const frozen = new Date(Date.now() - 60_000).toISOString();
    const { client } = scriptedClient([record({ status: 'running', last_activity_at: frozen })]);
    const events = await drain(client, { stallTimeoutMs: 0 }, 200);
    expect(typesOf(events)).not.toContain('poller_stalled');
  });

  test('activity moving forward clears the stall timer', async () => {
    let n = 0;
    const client = {
      getRun: async () =>
        record({ status: 'running', last_activity_at: new Date(Date.now() + n++ * 1000).toISOString() }),
    } as unknown as ExecutorClient;
    const events = await drain(client, { stallTimeoutMs: 30 }, 200);
    expect(typesOf(events)).not.toContain('poller_stalled');
  });

  test('a stall is re-armed rather than fired on every tick', async () => {
    const frozen = new Date(Date.now() - 60_000).toISOString();
    const { client } = scriptedClient([record({ status: 'running', last_activity_at: frozen })]);
    const events = await drain(client, { stallTimeoutMs: 40 }, 250);
    const stalls = typesOf(events).filter((t) => t === 'poller_stalled').length;
    // Fires, but not once per 5 ms poll.
    expect(stalls).toBeGreaterThanOrEqual(1);
    expect(stalls).toBeLessThan(10);
  });
});

describe('lifecycle', () => {
  test('heartbeats carry the latest record', async () => {
    const { client } = scriptedClient([record({ status: 'running' })]);
    const events = await drain(client, {}, 60);
    const beat = events.find((e) => e.type === 'poller_heartbeat');
    expect(beat).toBeDefined();
    expect((beat as { record: RunRecord }).record.id).toBe('run-1');
  });

  test('stop() prevents any further polling', async () => {
    const { client, calls } = scriptedClient([record({ status: 'running' })]);
    const poller = new RunPoller(client, 'run-1', () => {}, { pollIntervalMs: 5 });
    poller.start();
    await Bun.sleep(40);
    poller.stop();
    const after = calls();
    await Bun.sleep(60);
    expect(calls()).toBe(after);
  });

  test('start() after stop() is a no-op', async () => {
    const { client, calls } = scriptedClient([record({ status: 'running' })]);
    const poller = new RunPoller(client, 'run-1', () => {}, { pollIntervalMs: 5 });
    poller.stop();
    poller.start();
    await Bun.sleep(60);
    expect(calls()).toBe(0);
  });

  test('initialDelayMs holds the first poll back', async () => {
    // Used by the post-approve path, where the run briefly still reads as its
    // pre-resume status.
    const { client, calls } = scriptedClient([record({ status: 'running' })]);
    const poller = new RunPoller(client, 'run-1', () => {}, {
      pollIntervalMs: 5,
      initialDelayMs: 150,
    });
    poller.start();
    await Bun.sleep(60);
    expect(calls()).toBe(0);
    poller.stop();
  });

  test('a failing client is retried rather than silencing the poller', async () => {
    // This is the only channel by which an adopted run's outcome is learned,
    // so one transient store error must not end it permanently.
    let n = 0;
    const client = {
      getRun: async () => {
        n += 1;
        if (n <= 2) throw new Error('connection reset');
        return record({ status: 'completed' });
      },
    } as unknown as ExecutorClient;

    const events = await drain(client, {}, 300);
    expect(n).toBeGreaterThan(2);
    expect(typesOf(events)).toContain('poller_completed');
  });
});
