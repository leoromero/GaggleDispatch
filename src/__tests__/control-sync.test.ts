/**
 * Ticket sync.
 *
 * The tests that matter most here are the negative ones: sync must never move
 * work forwards, never dispatch, and never kill a running ticket. Those are the
 * properties that make the tracker safe as an import source.
 */

import { describe, expect, test } from 'bun:test';
import { TicketSync, type TicketSyncConfig } from '../control/sync.ts';
import type { TrackerIssue, TrackerReadPort } from '../control/ports.ts';
import type { Issue } from '../domain/types.ts';
import { harness, startedTicket, targetSpec, WS, type Harness } from './helpers/control-fixtures.ts';

function issue(over: Partial<Issue> = {}): TrackerIssue {
  return {
    id: 'lin-1',
    identifier: 'GAG-1',
    title: 'Fix the widget',
    description: 'broken',
    priority: 2,
    state: 'Todo',
    branch_name: 'gag-1',
    url: 'https://linear.app/gag-1',
    labels: [],
    blocked_by: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    parent_id: null,
    ...over,
  };
}

class FakeTrackerReads implements TrackerReadPort {
  candidates: TrackerIssue[] = [];
  byId: TrackerIssue[] = [];
  candidateCalls = 0;
  idCalls: string[][] = [];
  idError: string | null = null;

  async fetchCandidateIssues(): Promise<TrackerIssue[]> {
    this.candidateCalls++;
    return this.candidates;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<TrackerIssue[]> {
    this.idCalls.push(ids);
    if (this.idError) throw new Error(this.idError);
    return this.byId.filter((i) => ids.includes(i.id));
  }
}

function syncConfig(over: Partial<TicketSyncConfig> = {}): TicketSyncConfig {
  return {
    workspace: WS,
    tracker_kind: 'linear',
    terminal_states: ['Done', 'Cancelled', 'Merged'],
    active_states: ['Todo', 'In Progress'],
    ...over,
  };
}

async function syncHarness(
  cfgOver: Partial<TicketSyncConfig> = {},
): Promise<{ h: Harness; tracker: FakeTrackerReads; sync: TicketSync }> {
  const h = await harness();
  const tracker = new FakeTrackerReads();
  const sync = new TicketSync({
    store: h.store,
    service: h.service,
    tracker,
    cfg: syncConfig(cfgOver),
  });
  return { h, tracker, sync };
}

describe('TicketSync — import', () => {
  test('a new candidate lands as imported and starts nothing', async () => {
    const { h, tracker, sync } = await syncHarness();
    tracker.candidates = [issue()];

    const result = await sync.sync();

    expect(result.imported).toBe(1);
    const tickets = await h.store.listTickets({ workspace: WS });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.status).toBe('imported');
    expect(tickets[0]!.identifier).toBe('GAG-1');
    expect(await h.store.listTargets(tickets[0]!.id)).toHaveLength(0);
    expect(h.executor.spawned).toEqual([]);
    expect(h.analyzer.calls).toEqual([]);
  });

  test('every tracker-owned column round-trips', async () => {
    const { h, tracker, sync } = await syncHarness();
    tracker.candidates = [
      issue({
        labels: ['bug', 'p1'],
        blocked_by: [{ id: 'lin-9', identifier: 'GAG-9', state: 'Todo', labels: [] }],
      }),
    ];

    await sync.sync();

    const t = (await h.store.listTickets({ workspace: WS }))[0]!;
    expect(t.external_labels).toEqual(['bug', 'p1']);
    expect(t.blocked_by[0]!.identifier).toBe('GAG-9');
    expect(t.description).toBe('broken');
    expect(t.priority).toBe(2);
    expect(t.branch_name).toBe('gag-1');
    expect(t.url).toBe('https://linear.app/gag-1');
    expect(t.external_created_at).toBe('2026-07-01T00:00:00.000Z');
  });

  test('a second pass refreshes rather than duplicates', async () => {
    const { h, tracker, sync } = await syncHarness();
    tracker.candidates = [issue()];
    await sync.sync();
    tracker.candidates = [issue({ title: 'Renamed', labels: ['urgent'] })];

    const result = await sync.sync();

    expect(result.imported).toBe(0);
    expect(result.refreshed).toBe(1);
    const tickets = await h.store.listTickets({ workspace: WS });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.title).toBe('Renamed');
    expect(tickets[0]!.external_labels).toEqual(['urgent']);
  });

  test('malformed tracker rows are skipped, not imported half-formed', async () => {
    const { h, tracker, sync } = await syncHarness();
    tracker.candidates = [
      issue({ id: '' }),
      issue({ id: 'lin-2', identifier: '' }),
      issue({ id: 'lin-3', identifier: 'GAG-3', state: '' }),
      issue({ id: 'lin-4', identifier: 'GAG-4' }),
    ];

    await sync.sync();

    const tickets = await h.store.listTickets({ workspace: WS });
    expect(tickets.map((t) => t.identifier)).toEqual(['GAG-4']);
  });

  test('sync is idempotent — three passes leave one ticket in one status', async () => {
    const { h, tracker, sync } = await syncHarness();
    tracker.candidates = [issue()];
    await sync.sync();
    await sync.sync();
    await sync.sync();
    const tickets = await h.store.listTickets({ workspace: WS });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.status).toBe('imported');
  });
});

describe('TicketSync — status is never written backwards', () => {
  test('a refresh cannot undo an operator action', async () => {
    const { h, tracker, sync } = await syncHarness();
    tracker.candidates = [issue()];
    await sync.sync();
    const ticket = (await h.store.listTickets({ workspace: WS }))[0]!;
    await h.service.requestAnalysis(ticket.id);

    tracker.candidates = [issue({ title: 'Renamed by a human' })];
    await sync.sync();

    const after = await h.store.getTicket(ticket.id);
    expect(after!.status).toBe('analysis_requested');
    expect(after!.title).toBe('Renamed by a human');
  });

  test('a refresh cannot disturb a running ticket or its targets', async () => {
    const { h, tracker, sync } = await syncHarness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);
    const before = (await h.store.listTargets(ticket.id))[0]!;

    tracker.candidates = [issue({ state: 'In Progress' })];
    await sync.sync();

    expect((await h.store.getTicket(ticket.id))!.status).toBe('running');
    const after = (await h.store.listTargets(ticket.id))[0]!;
    expect(after.status).toBe('running');
    expect(after.run_id).toBe(before.run_id);
  });
});

describe('TicketSync — terminal in the tracker', () => {
  test('a pre-run ticket that goes terminal is archived', async () => {
    const { h, tracker, sync } = await syncHarness();
    tracker.candidates = [issue()];
    await sync.sync();
    const ticket = (await h.store.listTickets({ workspace: WS }))[0]!;

    // The issue drops out of the candidate query and answers the tracking pass.
    tracker.candidates = [];
    tracker.byId = [issue({ state: 'Done' })];
    const result = await sync.sync();

    expect(result.archived).toBe(1);
    expect((await h.store.getTicket(ticket.id))!.status).toBe('archived');
  });

  test('a running ticket that goes terminal is flagged, not cancelled', async () => {
    const { h, tracker, sync } = await syncHarness();
    const ticket = await startedTicket(h);
    await h.service.claimAndDispatch(10);

    tracker.candidates = [];
    tracker.byId = [issue({ state: 'Done' })];
    const result = await sync.sync();

    expect(result.flagged).toBe(1);
    expect(result.archived).toBe(0);
    const after = await h.store.getTicket(ticket.id);
    expect(after!.status).toBe('running');
    expect(after!.external_terminal_at).toBeTruthy();
    expect((await h.store.listTargets(ticket.id))[0]!.status).toBe('running');
    expect(h.executor.killed).toEqual([]);
  });

  test('an already-archived ticket is not re-archived on later passes', async () => {
    const { h, tracker, sync } = await syncHarness();
    tracker.candidates = [issue()];
    await sync.sync();
    tracker.candidates = [];
    tracker.byId = [issue({ state: 'Done' })];
    await sync.sync();

    const second = await sync.sync();
    expect(second.archived).toBe(0);
  });

  test('a terminal ticket is not re-queried once it is archived', async () => {
    const { tracker, sync } = await syncHarness();
    tracker.candidates = [issue()];
    await sync.sync();
    tracker.candidates = [];
    tracker.byId = [issue({ state: 'Done' })];
    await sync.sync();

    tracker.idCalls = [];
    await sync.sync();
    expect(tracker.idCalls.flat()).not.toContain('lin-1');
  });
});

describe('TicketSync — vanishing and staleness', () => {
  test('a ticket that leaves the candidate query keeps its row and status', async () => {
    const { h, tracker, sync } = await syncHarness();
    const ticket = await startedTicket(h);

    tracker.candidates = [];
    tracker.byId = [issue({ state: 'In Progress' })];
    await sync.sync();

    const after = await h.store.getTicket(ticket.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('running');
  });

  test('the tracking pass asks about exactly the tickets it can no longer see', async () => {
    const { h, tracker, sync } = await syncHarness();
    tracker.candidates = [issue({ id: 'lin-1', identifier: 'GAG-1' }), issue({ id: 'lin-2', identifier: 'GAG-2' })];
    await sync.sync();

    tracker.idCalls = [];
    tracker.candidates = [issue({ id: 'lin-1', identifier: 'GAG-1' })];
    await sync.sync();

    expect(tracker.idCalls).toHaveLength(1);
    expect(tracker.idCalls[0]).toEqual(['lin-2']);
  });

  test('the tracking pass is skipped entirely when there is nothing to ask about', async () => {
    const { tracker, sync } = await syncHarness();
    tracker.candidates = [issue()];
    await sync.sync();
    tracker.idCalls = [];
    await sync.sync();
    expect(tracker.idCalls).toEqual([]);
  });

  test('a failing tracking pass keeps the discovery pass results', async () => {
    const { h, tracker, sync } = await syncHarness();
    tracker.candidates = [issue({ id: 'lin-1', identifier: 'GAG-1' })];
    await sync.sync();

    tracker.candidates = [issue({ id: 'lin-2', identifier: 'GAG-2' })];
    tracker.idError = 'tracker 500';
    const result = await sync.sync();

    expect(result.imported).toBe(1);
    expect((await h.store.listTickets({ workspace: WS })).map((t) => t.identifier).sort()).toEqual([
      'GAG-1',
      'GAG-2',
    ]);
  });
});

describe('TicketSync — sub-issues', () => {
  test("a known ticket's sub-issue is not imported as a ticket", async () => {
    const { h, tracker, sync } = await syncHarness();
    tracker.candidates = [issue()];
    await sync.sync();

    tracker.candidates = [
      issue(),
      issue({ id: 'lin-sub', identifier: 'GAG-2', title: '[api] Fix the widget', parent_id: 'lin-1' }),
    ];
    const result = await sync.sync();

    expect(result.skipped_subissues).toBe(1);
    expect((await h.store.listTickets({ workspace: WS })).map((t) => t.identifier)).toEqual(['GAG-1']);
  });

  test('a sub-issue of an unknown parent is imported as its own ticket', async () => {
    const { h, tracker, sync } = await syncHarness();
    tracker.candidates = [
      issue({ id: 'lin-x', identifier: 'GAG-X', parent_id: 'some-other-project-issue' }),
    ];

    const result = await sync.sync();

    expect(result.imported).toBe(1);
    expect((await h.store.listTickets({ workspace: WS })).map((t) => t.identifier)).toEqual(['GAG-X']);
  });

  test("a sub-issue's state and labels land on the target row it represents", async () => {
    const { h, tracker, sync } = await syncHarness();
    const ticket = await startedTicket(h, [targetSpec({ repo_alias: 'api' })]);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.store.updateTarget(target.id, { external_target_id: 'lin-sub' });

    tracker.candidates = [
      issue(),
      issue({ id: 'lin-sub', identifier: 'GAG-2', parent_id: 'lin-1', state: 'Deployed', labels: ['deployed:staging'] }),
    ];
    const result = await sync.sync();

    expect(result.targets_refreshed).toBe(1);
    const after = await h.store.getTarget(target.id);
    expect(after!.external_target_state).toBe('Deployed');
    expect(after!.external_target_labels).toEqual(['deployed:staging']);
  });

  test('an unchanged sub-issue is not rewritten', async () => {
    const { h, tracker, sync } = await syncHarness();
    const ticket = await startedTicket(h);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.store.updateTarget(target.id, {
      external_target_id: 'lin-sub',
      external_target_state: 'Todo',
      external_target_labels: [],
    });

    tracker.candidates = [issue(), issue({ id: 'lin-sub', identifier: 'GAG-2', parent_id: 'lin-1', state: 'Todo' })];
    const result = await sync.sync();

    expect(result.targets_refreshed).toBe(0);
  });

  test('sub-issue state also arrives through the tracking pass', async () => {
    const { h, tracker, sync } = await syncHarness();
    const ticket = await startedTicket(h);
    const target = (await h.store.listTargets(ticket.id))[0]!;
    await h.store.updateTarget(target.id, { external_target_id: 'lin-sub' });

    tracker.candidates = [issue()];
    tracker.byId = [issue({ id: 'lin-sub', identifier: 'GAG-2', parent_id: 'lin-1', state: 'Merged' })];
    const result = await sync.sync();

    expect(result.targets_refreshed).toBe(1);
    expect((await h.store.getTarget(target.id))!.external_target_state).toBe('Merged');
  });
});

describe('TicketSync — workspace isolation', () => {
  test('sync only touches its own workspace', async () => {
    const { h, tracker, sync } = await syncHarness();
    const foreign = await h.store.upsertTicket({
      workspace: 'other',
      external_id: 'lin-1',
      identifier: 'OTH-1',
      title: 'Someone else',
      external_state: 'Todo',
    });

    tracker.candidates = [issue({ title: 'Ours' })];
    await sync.sync();

    expect((await h.store.getTicket(foreign.id))!.title).toBe('Someone else');
    const ours = await h.store.listTickets({ workspace: WS });
    expect(ours).toHaveLength(1);
    expect(ours[0]!.title).toBe('Ours');
  });
});
