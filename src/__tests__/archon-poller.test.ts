/**
 * ArchonRunPoller stall-detection tests.
 *
 * Focuses on the two regression bugs that produced spurious "worker failed"
 * comments on long-running supervised runs:
 *   1. Stall fired while Archon was status='paused' (gate idle is NOT a stall)
 *   2. After firing once, the poller stopped, losing visibility into the run
 *
 * Construction uses a stub ArchonClient that returns whatever record the test
 * stages, so we can control `status` and `last_activity_at` directly.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { ArchonRunPoller, type ArchonPollEvent } from '../executor/archon-poller.ts';
import type {
  ArchonClient,
  ArchonRunDetail,
  ArchonRunRecord,
  ArchonRunStatus,
} from '../executor/archon-client.ts';

function makeRecord(overrides: Partial<ArchonRunRecord> = {}): ArchonRunRecord {
  return {
    id: 'run-1',
    workflow_name: 'gaggle/gaggle-supervised',
    user_message: 'do the thing',
    status: 'running',
    started_at: '2026-05-14T00:00:00Z',
    completed_at: null,
    last_activity_at: '2026-05-14T00:00:00Z',
    working_path: '/tmp/wt',
    metadata: {},
    ...overrides,
  };
}

/** Stub client whose response is mutated by the test. */
function makeStubClient(initial: ArchonRunRecord): {
  client: ArchonClient;
  setRecord: (r: ArchonRunRecord) => void;
  callCount: () => number;
} {
  let current = initial;
  let calls = 0;
  const client: Partial<ArchonClient> = {
    async getRunDetail(): Promise<ArchonRunDetail | null> {
      calls++;
      return { run: current, events: [] };
    },
  };
  return {
    client: client as ArchonClient,
    setRecord: (r) => { current = r; },
    callCount: () => calls,
  };
}

const activePollers: ArchonRunPoller[] = [];
afterEach(() => {
  for (const p of activePollers.splice(0)) p.stop();
});

function startPoller(
  client: ArchonClient,
  events: ArchonPollEvent[],
  opts: { stallTimeoutMs?: number; pollIntervalMs?: number } = {},
): ArchonRunPoller {
  const p = new ArchonRunPoller(
    client,
    'run-1',
    (e) => events.push(e),
    { pollIntervalMs: opts.pollIntervalMs ?? 5, stallTimeoutMs: opts.stallTimeoutMs ?? 50 },
  );
  activePollers.push(p);
  p.start();
  return p;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

describe('ArchonRunPoller stall detection', () => {
  test('does NOT emit poller_stalled when status is paused (gate idle is not a stall)', async () => {
    const initial = makeRecord({ status: 'paused', last_activity_at: '2026-05-14T00:00:00Z' });
    const { client } = makeStubClient(initial);
    const events: ArchonPollEvent[] = [];
    startPoller(client, events, { stallTimeoutMs: 20, pollIntervalMs: 5 });

    // Let the poller tick a few times — long enough to cross the stall window.
    await new Promise((r) => setTimeout(r, 80));

    expect(events.some((e) => e.type === 'poller_stalled')).toBe(false);
    // It should still observe the run (gate_paused event fires on first sight of 'paused')
    expect(events.some((e) => e.type === 'poller_gate_paused')).toBe(true);
  });

  test('does NOT emit poller_stalled when status is pending', async () => {
    const initial = makeRecord({ status: 'pending' });
    const { client } = makeStubClient(initial);
    const events: ArchonPollEvent[] = [];
    startPoller(client, events, { stallTimeoutMs: 20, pollIntervalMs: 5 });
    await new Promise((r) => setTimeout(r, 80));
    expect(events.some((e) => e.type === 'poller_stalled')).toBe(false);
  });

  test('emits poller_stalled when status is running and last_activity_at is frozen', async () => {
    const initial = makeRecord({ status: 'running', last_activity_at: '2026-05-14T00:00:00Z' });
    const { client } = makeStubClient(initial);
    const events: ArchonPollEvent[] = [];
    startPoller(client, events, { stallTimeoutMs: 20, pollIntervalMs: 5 });
    await waitFor(() => events.some((e) => e.type === 'poller_stalled'));
    expect(events.find((e) => e.type === 'poller_stalled')).toBeDefined();
  });

  test('continues polling after emitting poller_stalled (does not stop itself)', async () => {
    const initial = makeRecord({ status: 'running', last_activity_at: '2026-05-14T00:00:00Z' });
    const { client, setRecord, callCount } = makeStubClient(initial);
    const events: ArchonPollEvent[] = [];
    startPoller(client, events, { stallTimeoutMs: 20, pollIntervalMs: 5 });

    await waitFor(() => events.some((e) => e.type === 'poller_stalled'));
    const callsAtStall = callCount();

    // Flip Archon to 'completed' and verify the poller observes it post-stall.
    setRecord(makeRecord({
      status: 'completed',
      last_activity_at: '2026-05-14T00:01:00Z',
      completed_at: '2026-05-14T00:01:00Z',
    }));

    await waitFor(() => events.some((e) => e.type === 'poller_completed'));
    expect(callCount()).toBeGreaterThan(callsAtStall);
  });

  test('initialDelayMs defers the first poll (post-approve grace window)', async () => {
    const initial = makeRecord({ status: 'running', last_activity_at: '2026-05-14T00:00:00Z' });
    const { client, callCount } = makeStubClient(initial);
    const events: ArchonPollEvent[] = [];
    const p = new ArchonRunPoller(
      client,
      'run-1',
      (e) => events.push(e),
      { pollIntervalMs: 5, stallTimeoutMs: 0, initialDelayMs: 50 },
    );
    activePollers.push(p);
    p.start();
    // Before the initial delay elapses, no poll should have happened.
    await new Promise((r) => setTimeout(r, 20));
    expect(callCount()).toBe(0);
    // After the delay, polling resumes normally.
    await waitFor(() => callCount() > 0);
    expect(callCount()).toBeGreaterThan(0);
  });

  test('does not spam poller_stalled on every subsequent poll', async () => {
    const initial = makeRecord({ status: 'running', last_activity_at: '2026-05-14T00:00:00Z' });
    const { client } = makeStubClient(initial);
    const events: ArchonPollEvent[] = [];
    startPoller(client, events, { stallTimeoutMs: 20, pollIntervalMs: 5 });

    await waitFor(() => events.filter((e) => e.type === 'poller_stalled').length >= 1);
    // Wait a window that includes several poll ticks but less than another stall threshold.
    await new Promise((r) => setTimeout(r, 15));
    expect(events.filter((e) => e.type === 'poller_stalled').length).toBe(1);
  });
});
