/**
 * One suite, run against every ControlStore implementation.
 *
 * MemoryControlStore always runs, so CI without a database still covers the
 * semantics the control plane depends on. PostgresControlStore runs only when
 * TEST_DATABASE_URL is set:
 *
 *   docker compose up -d
 *   TEST_DATABASE_URL=postgres://gaggle:gaggle@localhost:55432/gaggle_test bun test control-store
 */

import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { MemoryControlStore } from '../control/store/memory.ts';
import { PostgresControlStore } from '../control/store/postgres.ts';
import type { ControlStore, TargetSpec, UpsertTicketInput } from '../control/store/types.ts';

const PG_URL = process.env.TEST_DATABASE_URL ?? '';
const WS = 'acme';

function ticketInput(over: Partial<UpsertTicketInput> = {}): UpsertTicketInput {
  return {
    workspace: WS,
    external_id: 'lin-1',
    identifier: 'GAG-1',
    title: 'Fix the widget',
    description: 'It is broken',
    priority: 2,
    url: 'https://linear.app/gag-1',
    external_state: 'Todo',
    external_labels: ['bug'],
    blocked_by: [],
    external_created_at: '2026-07-01T00:00:00.000Z',
    external_updated_at: '2026-07-02T00:00:00.000Z',
    ...over,
  };
}

function targetSpec(over: Partial<TargetSpec> = {}): TargetSpec {
  return {
    repo_alias: 'api',
    repo_url: 'https://github.com/acme/api',
    local_path: '/repos/api',
    workflow: 'gaggle/gaggle-fix-issue',
    rationale: 'owns the widget endpoint',
    components: ['widget-service'],
    depends_on: [],
    ...over,
  };
}

/** Postgres truncates timestamps to microseconds and clocks can tie. */
const tick = () => Bun.sleep(2);

function suite(name: string, makeStore: () => Promise<ControlStore>, cleanup?: () => Promise<void>) {
  describe(`ControlStore conformance — ${name}`, () => {
    let store: ControlStore;

    beforeEach(async () => {
      store = await makeStore();
    });

    if (cleanup) afterAll(cleanup);

    // ── tickets ───────────────────────────────────────────────────────────

    test('upsertTicket inserts with status imported', async () => {
      const row = await store.upsertTicket(ticketInput());
      expect(row.status).toBe('imported');
      expect(row.identifier).toBe('GAG-1');
      expect(row.external_labels).toEqual(['bug']);
      expect(row.blocked_by).toEqual([]);
      expect(row.tracker_kind).toBe('linear');
      expect(row.analyzed_at).toBeNull();
      expect(row.external_terminal_at).toBeNull();
      expect(row.id).toBeTruthy();
    });

    test('upsertTicket round-trips jsonb columns as parsed values', async () => {
      const row = await store.upsertTicket(
        ticketInput({
          external_labels: ['bug', 'p1'],
          blocked_by: [{ id: 'lin-9', identifier: 'GAG-9', state: 'Todo', labels: ['x'] }],
        }),
      );
      expect(row.external_labels).toEqual(['bug', 'p1']);
      expect(row.blocked_by).toHaveLength(1);
      expect(row.blocked_by[0]!.identifier).toBe('GAG-9');
      const reread = await store.getTicket(row.id);
      expect(reread!.blocked_by[0]!.state).toBe('Todo');
    });

    test('upsertTicket is idempotent on (workspace, tracker_kind, external_id)', async () => {
      const a = await store.upsertTicket(ticketInput());
      const b = await store.upsertTicket(ticketInput({ title: 'Renamed' }));
      expect(b.id).toBe(a.id);
      expect(b.title).toBe('Renamed');
      expect(await store.listTickets({ workspace: WS })).toHaveLength(1);
    });

    test('upsertTicket cannot move status backwards — the sync-safety invariant', async () => {
      const t = await store.upsertTicket(ticketInput());
      await store.updateTicket(t.id, { status: 'running' });
      const after = await store.upsertTicket(ticketInput({ title: 'Renamed by sync' }));
      expect(after.status).toBe('running');
      expect(after.title).toBe('Renamed by sync');
    });

    test('upsertTicket preserves first_imported_at but advances last_synced_at', async () => {
      const a = await store.upsertTicket(ticketInput());
      await tick();
      const b = await store.upsertTicket(ticketInput());
      expect(b.first_imported_at).toBe(a.first_imported_at);
      expect(Date.parse(b.last_synced_at)).toBeGreaterThanOrEqual(Date.parse(a.last_synced_at));
    });

    test('the same external_id in another workspace is a distinct ticket', async () => {
      const a = await store.upsertTicket(ticketInput());
      const b = await store.upsertTicket(ticketInput({ workspace: 'other' }));
      expect(b.id).not.toBe(a.id);
    });

    test('getTicketByExternalId finds by tracker identity', async () => {
      const t = await store.upsertTicket(ticketInput());
      expect((await store.getTicketByExternalId(WS, 'linear', 'lin-1'))!.id).toBe(t.id);
      expect(await store.getTicketByExternalId(WS, 'linear', 'nope')).toBeNull();
      expect(await store.getTicketByExternalId('other', 'linear', 'lin-1')).toBeNull();
    });

    test('getTicket returns null for an unknown id', async () => {
      expect(await store.getTicket('00000000-0000-4000-8000-000000000000')).toBeNull();
    });

    test('listTickets filters by workspace, status, and search', async () => {
      const a = await store.upsertTicket(ticketInput({ external_id: 'l1', identifier: 'GAG-1', title: 'Widget bug' }));
      const b = await store.upsertTicket(ticketInput({ external_id: 'l2', identifier: 'GAG-2', title: 'Gadget crash' }));
      await store.upsertTicket(ticketInput({ workspace: 'other', external_id: 'l3', identifier: 'OTH-1' }));
      await store.updateTicket(b.id, { status: 'analyzed' });

      expect(await store.listTickets({ workspace: WS })).toHaveLength(2);
      expect(await store.listTickets({ workspace: WS, status: ['analyzed'] })).toHaveLength(1);
      expect(await store.listTickets({ workspace: WS, status: ['imported', 'analyzed'] })).toHaveLength(2);
      expect(await store.listTickets({ status: [] })).toHaveLength(3);

      const byTitle = await store.listTickets({ workspace: WS, search: 'gadget' });
      expect(byTitle.map((t) => t.id)).toEqual([b.id]);
      const byIdent = await store.listTickets({ workspace: WS, search: 'gag-1' });
      expect(byIdent.map((t) => t.id)).toEqual([a.id]);
    });

    test('listTickets honours limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.upsertTicket(ticketInput({ external_id: `l${i}`, identifier: `GAG-${i}` }));
      }
      expect(await store.listTickets({ workspace: WS, limit: 3 })).toHaveLength(3);
    });

    test('countTicketsByStatus tallies per status', async () => {
      const a = await store.upsertTicket(ticketInput({ external_id: 'l1' }));
      await store.upsertTicket(ticketInput({ external_id: 'l2' }));
      await store.updateTicket(a.id, { status: 'running' });
      const counts = await store.countTicketsByStatus(WS);
      expect(counts.imported).toBe(1);
      expect(counts.running).toBe(1);
      expect(counts.done ?? 0).toBe(0);
    });

    test('updateTicket patches only named columns and stamps status_changed_at', async () => {
      const t = await store.upsertTicket(ticketInput());
      await tick();
      const patched = await store.updateTicket(t.id, {
        status: 'analyzed',
        analysis_summary: 'two repos',
        complexity: 'complex',
        analyzed_at: '2026-07-03T00:00:00.000Z',
      });
      expect(patched!.status).toBe('analyzed');
      expect(patched!.analysis_summary).toBe('two repos');
      expect(patched!.complexity).toBe('complex');
      expect(patched!.analyzed_at).toBe('2026-07-03T00:00:00.000Z');
      expect(patched!.title).toBe(t.title);
      expect(Date.parse(patched!.status_changed_at)).toBeGreaterThan(Date.parse(t.status_changed_at));
    });

    test('updateTicket leaves status_changed_at alone when status is unchanged', async () => {
      const t = await store.upsertTicket(ticketInput());
      await tick();
      const patched = await store.updateTicket(t.id, { analysis_error: 'boom' });
      expect(patched!.status_changed_at).toBe(t.status_changed_at);
    });

    test('updateTicket returns null for an unknown id', async () => {
      expect(
        await store.updateTicket('00000000-0000-4000-8000-000000000000', { status: 'done' }),
      ).toBeNull();
    });

    test('updateTicket can clear a nullable column', async () => {
      const t = await store.upsertTicket(ticketInput());
      await store.updateTicket(t.id, { analysis_error: 'boom' });
      const cleared = await store.updateTicket(t.id, { analysis_error: null });
      expect(cleared!.analysis_error).toBeNull();
    });

    // ── analysis claiming ─────────────────────────────────────────────────

    test('claimTicketsForAnalysis takes only analysis_requested and moves them to analyzing', async () => {
      const a = await store.upsertTicket(ticketInput({ external_id: 'l1' }));
      const b = await store.upsertTicket(ticketInput({ external_id: 'l2' }));
      await store.updateTicket(a.id, { status: 'analysis_requested' });

      const claimed = await store.claimTicketsForAnalysis(WS, 10);
      expect(claimed.map((t) => t.id)).toEqual([a.id]);
      expect(claimed[0]!.status).toBe('analyzing');
      expect((await store.getTicket(a.id))!.status).toBe('analyzing');
      expect((await store.getTicket(b.id))!.status).toBe('imported');
    });

    test('claimTicketsForAnalysis is exclusive — a second call finds nothing', async () => {
      const a = await store.upsertTicket(ticketInput());
      await store.updateTicket(a.id, { status: 'analysis_requested' });
      expect(await store.claimTicketsForAnalysis(WS, 10)).toHaveLength(1);
      expect(await store.claimTicketsForAnalysis(WS, 10)).toHaveLength(0);
    });

    test('claimTicketsForAnalysis honours the limit and the workspace', async () => {
      for (let i = 0; i < 4; i++) {
        const t = await store.upsertTicket(ticketInput({ external_id: `l${i}` }));
        await store.updateTicket(t.id, { status: 'analysis_requested' });
      }
      const other = await store.upsertTicket(ticketInput({ workspace: 'other', external_id: 'o1' }));
      await store.updateTicket(other.id, { status: 'analysis_requested' });

      expect(await store.claimTicketsForAnalysis(WS, 2)).toHaveLength(2);
      expect(await store.claimTicketsForAnalysis(WS, 10)).toHaveLength(2);
      expect(await store.claimTicketsForAnalysis('other', 10)).toHaveLength(1);
    });

    // ── targets ───────────────────────────────────────────────────────────

    test('replaceTargets creates rows blocked by default', async () => {
      const t = await store.upsertTicket(ticketInput());
      const targets = await store.replaceTargets(t.id, [
        targetSpec(),
        targetSpec({ repo_alias: 'web', depends_on: ['api'] }),
      ]);
      expect(targets).toHaveLength(2);
      expect(targets.every((x) => x.status === 'blocked')).toBe(true);
      expect(targets.every((x) => x.attempt === 0)).toBe(true);
      expect(targets.every((x) => x.cancel_requested === false)).toBe(true);
      const web = targets.find((x) => x.repo_alias === 'web')!;
      expect(web.depends_on).toEqual(['api']);
      expect(web.gate_rework_attempts).toBe(0);
    });

    test('replaceTargets discards the previous fan-out', async () => {
      const t = await store.upsertTicket(ticketInput());
      const first = await store.replaceTargets(t.id, [targetSpec(), targetSpec({ repo_alias: 'web' })]);
      const second = await store.replaceTargets(t.id, [targetSpec({ repo_alias: 'worker' })]);
      expect(second).toHaveLength(1);
      expect(await store.listTargets(t.id)).toHaveLength(1);
      expect(await store.getTarget(first[0]!.id)).toBeNull();
    });

    test('listTargets is ordered by repo_alias for stable rendering', async () => {
      const t = await store.upsertTicket(ticketInput());
      await store.replaceTargets(t.id, [
        targetSpec({ repo_alias: 'web' }),
        targetSpec({ repo_alias: 'api' }),
        targetSpec({ repo_alias: 'worker' }),
      ]);
      expect((await store.listTargets(t.id)).map((x) => x.repo_alias)).toEqual(['api', 'web', 'worker']);
    });

    test('updateTarget patches and stamps status_changed_at on a status change', async () => {
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      await tick();
      const patched = await store.updateTarget(target!.id, {
        status: 'running',
        run_id: '11111111-1111-4111-8111-111111111111',
        attempt: 1,
      });
      expect(patched!.status).toBe('running');
      expect(patched!.run_id).toBe('11111111-1111-4111-8111-111111111111');
      expect(patched!.attempt).toBe(1);
      expect(Date.parse(patched!.status_changed_at)).toBeGreaterThan(Date.parse(target!.status_changed_at));
    });

    test('run_id is stored verbatim, whatever shape the executor uses', async () => {
      // Archon emits 32 hex characters with no dashes. A UUID column would
      // normalize that into dashed form, and Archon would then reject the id we
      // handed back to it. The round trip has to be byte-exact.
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      const archonId = '9136a16135d082cb9f0ac75523b3b56e';
      await store.updateTarget(target!.id, { status: 'running', run_id: archonId });
      expect((await store.getTarget(target!.id))!.run_id).toBe(archonId);

      // And a dashed uuid, for an executor that uses those.
      const dashed = '11111111-1111-4111-8111-111111111111';
      await store.updateTarget(target!.id, { run_id: dashed });
      expect((await store.getTarget(target!.id))!.run_id).toBe(dashed);
    });

    test('updateTarget can set and clear the gate fields', async () => {
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      const opened = await store.updateTarget(target!.id, {
        status: 'gate_waiting',
        gate_approval_id: 'appr-1',
        gate_message: 'Approve the plan?',
        gate_opened_at: '2026-07-04T00:00:00.000Z',
      });
      expect(opened!.gate_message).toBe('Approve the plan?');
      const closed = await store.updateTarget(target!.id, {
        status: 'running',
        gate_approval_id: null,
        gate_message: null,
        gate_opened_at: null,
      });
      expect(closed!.gate_message).toBeNull();
      expect(closed!.gate_opened_at).toBeNull();
    });

    test('listTargetsByStatus filters by status and workspace', async () => {
      const a = await store.upsertTicket(ticketInput({ external_id: 'l1' }));
      const b = await store.upsertTicket(ticketInput({ workspace: 'other', external_id: 'l2' }));
      const [ta] = await store.replaceTargets(a.id, [targetSpec()]);
      const [tb] = await store.replaceTargets(b.id, [targetSpec()]);
      await store.updateTarget(ta!.id, { status: 'ready' });
      await store.updateTarget(tb!.id, { status: 'ready' });

      expect(await store.listTargetsByStatus(['ready'])).toHaveLength(2);
      expect(await store.listTargetsByStatus(['ready'], WS)).toHaveLength(1);
      expect(await store.listTargetsByStatus(['running'], WS)).toHaveLength(0);
      expect(await store.listTargetsByStatus([], WS)).toHaveLength(0);
    });

    // ── ready drain ───────────────────────────────────────────────────────

    test('claimReadyTargets takes only ready rows and moves them to dispatching', async () => {
      const t = await store.upsertTicket(ticketInput());
      const targets = await store.replaceTargets(t.id, [
        targetSpec({ repo_alias: 'api' }),
        targetSpec({ repo_alias: 'web' }),
      ]);
      await store.updateTarget(targets[0]!.id, { status: 'ready' });

      const claimed = await store.claimReadyTargets(WS, 10);
      expect(claimed.map((x) => x.repo_alias)).toEqual(['api']);
      expect(claimed[0]!.status).toBe('dispatching');
      expect((await store.getTarget(targets[1]!.id))!.status).toBe('blocked');
    });

    test('claimReadyTargets is exclusive and slot-limited', async () => {
      const t = await store.upsertTicket(ticketInput());
      const targets = await store.replaceTargets(t.id, [
        targetSpec({ repo_alias: 'a' }),
        targetSpec({ repo_alias: 'b' }),
        targetSpec({ repo_alias: 'c' }),
      ]);
      for (const x of targets) await store.updateTarget(x.id, { status: 'ready' });

      expect(await store.claimReadyTargets(WS, 2)).toHaveLength(2);
      expect(await store.claimReadyTargets(WS, 2)).toHaveLength(1);
      expect(await store.claimReadyTargets(WS, 2)).toHaveLength(0);
    });

    test('claimReadyTargets returns zero rows for a zero limit', async () => {
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      await store.updateTarget(target!.id, { status: 'ready' });
      expect(await store.claimReadyTargets(WS, 0)).toHaveLength(0);
      expect((await store.getTarget(target!.id))!.status).toBe('ready');
    });

    test('claimReadyTargets orders by ticket priority then age', async () => {
      const low = await store.upsertTicket(
        ticketInput({ external_id: 'lo', identifier: 'GAG-LO', priority: 4, external_created_at: '2026-01-01T00:00:00.000Z' }),
      );
      const high = await store.upsertTicket(
        ticketInput({ external_id: 'hi', identifier: 'GAG-HI', priority: 1, external_created_at: '2026-06-01T00:00:00.000Z' }),
      );
      const none = await store.upsertTicket(
        ticketInput({ external_id: 'no', identifier: 'GAG-NO', priority: null, external_created_at: '2025-01-01T00:00:00.000Z' }),
      );
      for (const t of [low, high, none]) {
        const [target] = await store.replaceTargets(t.id, [targetSpec()]);
        await store.updateTarget(target!.id, { status: 'ready' });
      }
      const claimed = await store.claimReadyTargets(WS, 10);
      expect(claimed.map((x) => x.ticket_id)).toEqual([high.id, low.id, none.id]);
    });

    test('claimReadyTargets ignores other workspaces', async () => {
      const other = await store.upsertTicket(ticketInput({ workspace: 'other' }));
      const [target] = await store.replaceTargets(other.id, [targetSpec()]);
      await store.updateTarget(target!.id, { status: 'ready' });
      expect(await store.claimReadyTargets(WS, 10)).toHaveLength(0);
      expect(await store.claimReadyTargets('other', 10)).toHaveLength(1);
    });

    // ── gates and cancellation ────────────────────────────────────────────

    test('listPendingGates denormalizes ticket context', async () => {
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      await store.updateTarget(target!.id, {
        status: 'gate_waiting',
        gate_approval_id: 'appr-1',
        gate_message: 'Approve?',
        gate_opened_at: '2026-07-05T00:00:00.000Z',
        run_id: '22222222-2222-4222-8222-222222222222',
        gate_rework_attempts: 1,
      });
      const gates = await store.listPendingGates(WS);
      expect(gates).toHaveLength(1);
      expect(gates[0]).toMatchObject({
        target_id: target!.id,
        ticket_id: t.id,
        identifier: 'GAG-1',
        title: 'Fix the widget',
        repo_alias: 'api',
        approval_id: 'appr-1',
        gate_message: 'Approve?',
        rework_attempts: 1,
      });
    });

    test('listPendingGates excludes targets that are not gate_waiting', async () => {
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      await store.updateTarget(target!.id, { status: 'running' });
      expect(await store.listPendingGates(WS)).toHaveLength(0);
    });

    test('requestGateDecision records an answer on an open gate', async () => {
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      await store.updateTarget(target!.id, { status: 'gate_waiting', gate_message: 'ok?' });

      const answered = await store.requestGateDecision(target!.id, 'approved', 'ship it');
      expect(answered!.gate_decision).toBe('approved');
      expect(answered!.gate_decision_comment).toBe('ship it');
      expect(answered!.gate_decision_at).toBeTruthy();
      // The status does not move: only the daemon can resume the run.
      expect(answered!.status).toBe('gate_waiting');
    });

    test('requestGateDecision refuses a second answer, so a race resolves to the first', async () => {
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      await store.updateTarget(target!.id, { status: 'gate_waiting' });

      expect(await store.requestGateDecision(target!.id, 'approved', 'first')).not.toBeNull();
      expect(await store.requestGateDecision(target!.id, 'rejected', 'second')).toBeNull();
      expect((await store.getTarget(target!.id))!.gate_decision).toBe('approved');
    });

    test('requestGateDecision refuses a target that is not at a gate', async () => {
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      await store.updateTarget(target!.id, { status: 'running' });
      expect(await store.requestGateDecision(target!.id, 'approved', null)).toBeNull();
    });

    test('listGateDecisions returns answers awaiting the daemon, oldest first', async () => {
      const t = await store.upsertTicket(ticketInput());
      const targets = await store.replaceTargets(t.id, [
        targetSpec({ repo_alias: 'a' }),
        targetSpec({ repo_alias: 'b' }),
        targetSpec({ repo_alias: 'c' }),
      ]);
      for (const x of targets) await store.updateTarget(x.id, { status: 'gate_waiting' });
      await store.requestGateDecision(targets[1]!.id, 'approved', null);
      await tick();
      await store.requestGateDecision(targets[0]!.id, 'rejected', 'no');

      const pending = await store.listGateDecisions(WS);
      expect(pending.map((p) => p.repo_alias)).toEqual(['b', 'a']);
      expect(await store.listGateDecisions('other')).toHaveLength(0);
    });

    test('clearing a decision removes it from the pending list', async () => {
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      await store.updateTarget(target!.id, { status: 'gate_waiting' });
      await store.requestGateDecision(target!.id, 'approved', null);
      await store.updateTarget(target!.id, {
        gate_decision: null,
        gate_decision_comment: null,
        gate_decision_at: null,
      });
      expect(await store.listGateDecisions(WS)).toHaveLength(0);
    });

    test('listPendingGates surfaces a pending decision', async () => {
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      await store.updateTarget(target!.id, { status: 'gate_waiting', gate_message: 'ok?' });
      expect((await store.listPendingGates(WS))[0]!.pending_decision).toBeNull();
      await store.requestGateDecision(target!.id, 'rejected', 'nope');
      expect((await store.listPendingGates(WS))[0]!.pending_decision).toBe('rejected');
    });

    test('listCancelRequested finds only flagged live targets', async () => {
      const t = await store.upsertTicket(ticketInput());
      const targets = await store.replaceTargets(t.id, [
        targetSpec({ repo_alias: 'a' }),
        targetSpec({ repo_alias: 'b' }),
      ]);
      await store.updateTarget(targets[0]!.id, { status: 'running', cancel_requested: true });
      await store.updateTarget(targets[1]!.id, { status: 'running' });
      const pending = await store.listCancelRequested(WS);
      expect(pending.map((x) => x.repo_alias)).toEqual(['a']);
    });

    // ── events ────────────────────────────────────────────────────────────

    test('appendEvent records the transition and listEvents returns newest first', async () => {
      const t = await store.upsertTicket(ticketInput());
      await store.appendEvent({
        ticket_id: t.id,
        event_kind: 'analyze_requested',
        from_status: 'imported',
        to_status: 'analysis_requested',
        actor: 'operator',
      });
      await tick();
      await store.appendEvent({
        ticket_id: t.id,
        event_kind: 'analysis_claimed',
        from_status: 'analysis_requested',
        to_status: 'analyzing',
        actor: 'daemon',
        detail: { pid: 42 },
      });
      const events = await store.listEvents(t.id);
      expect(events.map((e) => e.event_kind)).toEqual(['analysis_claimed', 'analyze_requested']);
      expect(events[0]!.actor).toBe('daemon');
      expect(events[0]!.detail).toEqual({ pid: 42 });
      expect(events[1]!.detail).toEqual({});
      expect(events[1]!.target_id).toBeNull();
    });

    test('listEvents honours the limit and scopes to one ticket', async () => {
      const a = await store.upsertTicket(ticketInput({ external_id: 'l1' }));
      const b = await store.upsertTicket(ticketInput({ external_id: 'l2' }));
      for (let i = 0; i < 4; i++) {
        await store.appendEvent({ ticket_id: a.id, event_kind: `e${i}`, to_status: 'imported', actor: 'sync' });
      }
      await store.appendEvent({ ticket_id: b.id, event_kind: 'other', to_status: 'imported', actor: 'sync' });
      expect(await store.listEvents(a.id)).toHaveLength(4);
      expect(await store.listEvents(a.id, 2)).toHaveLength(2);
      expect(await store.listEvents(b.id)).toHaveLength(1);
    });

    test('latestEventId advances monotonically and is workspace-scopable', async () => {
      const t = await store.upsertTicket(ticketInput());
      expect(await store.latestEventId(WS)).toBe(0);
      await store.appendEvent({ ticket_id: t.id, event_kind: 'x', to_status: 'imported', actor: 'sync' });
      const first = await store.latestEventId(WS);
      expect(first).toBeGreaterThan(0);
      await store.appendEvent({ ticket_id: t.id, event_kind: 'y', to_status: 'imported', actor: 'sync' });
      expect(await store.latestEventId(WS)).toBeGreaterThan(first);
      expect(await store.latestEventId('other')).toBe(0);
    });

    test('an event records the target it concerns', async () => {
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      await store.appendEvent({
        ticket_id: t.id,
        target_id: target!.id,
        event_kind: 'x',
        to_status: 'blocked',
        actor: 'daemon',
      });
      const events = await store.listEvents(t.id);
      expect(events[0]!.target_id).toBe(target!.id);
    });

    test('replacing the fan-out keeps the audit trail', async () => {
      // Re-analysing must not erase the record of what the previous targets did.
      // The events survive with their target reference cleared.
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      await store.appendEvent({
        ticket_id: t.id,
        target_id: target!.id,
        event_kind: 'run_failed',
        to_status: 'failed',
        actor: 'daemon',
        detail: { reason: 'tests failed' },
      });

      await store.replaceTargets(t.id, [targetSpec({ repo_alias: 'worker' })]);

      const events = await store.listEvents(t.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.event_kind).toBe('run_failed');
      expect(events[0]!.detail).toEqual({ reason: 'tests failed' });
      expect(events[0]!.target_id).toBeNull();
    });

    // ── outbox ────────────────────────────────────────────────────────────

    test('claimOutbox returns unsent rows oldest first', async () => {
      await store.enqueueOutbox({ workspace: WS, external_id: 'lin-1', op: 'post_comment', payload: { body: 'first' } });
      await tick();
      await store.enqueueOutbox({ workspace: WS, external_id: 'lin-1', op: 'set_state', payload: { state: 'Done' } });
      const rows = await store.claimOutbox(WS, 10);
      expect(rows.map((r) => r.op)).toEqual(['post_comment', 'set_state']);
      expect(rows[0]!.payload).toEqual({ body: 'first' });
      expect(rows[0]!.attempts).toBe(0);
      expect(rows[0]!.sent_at).toBeNull();
    });

    test('markOutboxSent removes a row from future claims', async () => {
      await store.enqueueOutbox({ workspace: WS, external_id: 'lin-1', op: 'set_state' });
      const [row] = await store.claimOutbox(WS, 10);
      await store.markOutboxSent(row!.id);
      expect(await store.claimOutbox(WS, 10)).toHaveLength(0);
    });

    test('markOutboxFailed bumps attempts and keeps the row claimable', async () => {
      await store.enqueueOutbox({ workspace: WS, external_id: 'lin-1', op: 'set_state' });
      const [row] = await store.claimOutbox(WS, 10);
      await store.markOutboxFailed(row!.id, 'network down');
      const again = await store.claimOutbox(WS, 10);
      expect(again).toHaveLength(1);
      expect(again[0]!.attempts).toBe(1);
      expect(again[0]!.last_error).toBe('network down');
    });

    test('discardExhaustedOutbox drops rows at or past the attempt ceiling', async () => {
      await store.enqueueOutbox({ workspace: WS, external_id: 'lin-1', op: 'set_state' });
      await store.enqueueOutbox({ workspace: WS, external_id: 'lin-2', op: 'set_state' });
      const rows = await store.claimOutbox(WS, 10);
      for (let i = 0; i < 3; i++) await store.markOutboxFailed(rows[0]!.id, 'nope');
      expect(await store.discardExhaustedOutbox(WS, 3)).toBe(1);
      const left = await store.claimOutbox(WS, 10);
      expect(left).toHaveLength(1);
      expect(left[0]!.external_id).toBe('lin-2');
    });

    test('claimOutbox honours the limit', async () => {
      for (let i = 0; i < 4; i++) {
        await store.enqueueOutbox({ workspace: WS, external_id: `lin-${i}`, op: 'set_state' });
      }
      expect(await store.claimOutbox(WS, 2)).toHaveLength(2);
    });

    // ── scaffold jobs ─────────────────────────────────────────────────────

    test('scaffold jobs round-trip and upsert by slug', async () => {
      const job = {
        slug: 'acme-api',
        workspace: WS,
        url: 'https://github.com/acme/api',
        checkout_path: '/repos/api',
        run_id: null,
        workflow_name: 'gaggle/gaggle-scaffold',
        branch: 'gaggle/scaffold',
        started_at: '2026-07-01T00:00:00.000Z',
        last_polled_at: null,
        last_status: 'pending',
        pr_url: null,
        last_error: null,
      };
      await store.upsertScaffoldJob(job);
      await store.upsertScaffoldJob({ ...job, last_status: 'running', pr_url: 'https://github.com/acme/api/pull/1' });
      const jobs = await store.listScaffoldJobs(WS);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.last_status).toBe('running');
      expect(jobs[0]!.pr_url).toBe('https://github.com/acme/api/pull/1');
      expect((await store.getScaffoldJob('acme-api'))!.slug).toBe('acme-api');
      await store.deleteScaffoldJob('acme-api');
      expect(await store.listScaffoldJobs(WS)).toHaveLength(0);
      expect(await store.getScaffoldJob('acme-api')).toBeNull();
    });

    // ── board ─────────────────────────────────────────────────────────────

    test('board nests targets under their ticket', async () => {
      const a = await store.upsertTicket(ticketInput({ external_id: 'l1', identifier: 'GAG-1' }));
      const b = await store.upsertTicket(ticketInput({ external_id: 'l2', identifier: 'GAG-2' }));
      await store.replaceTargets(a.id, [targetSpec({ repo_alias: 'api' }), targetSpec({ repo_alias: 'web' })]);

      const board = await store.board({ workspace: WS });
      expect(board).toHaveLength(2);
      const rowA = board.find((r) => r.ticket.id === a.id)!;
      expect(rowA.targets.map((t) => t.repo_alias)).toEqual(['api', 'web']);
      expect(board.find((r) => r.ticket.id === b.id)!.targets).toEqual([]);
    });

    test('board applies the same filters as listTickets', async () => {
      const a = await store.upsertTicket(ticketInput({ external_id: 'l1' }));
      await store.upsertTicket(ticketInput({ external_id: 'l2' }));
      await store.updateTicket(a.id, { status: 'running' });
      const board = await store.board({ workspace: WS, status: ['running'] });
      expect(board.map((r) => r.ticket.id)).toEqual([a.id]);
    });

    // ── transactions ──────────────────────────────────────────────────────

    test('tx commits on success', async () => {
      const t = await store.upsertTicket(ticketInput());
      await store.tx(async (tr) => {
        await tr.updateTicket(t.id, { status: 'analyzed' });
        await tr.appendEvent({ ticket_id: t.id, event_kind: 'x', to_status: 'analyzed', actor: 'operator' });
      });
      expect((await store.getTicket(t.id))!.status).toBe('analyzed');
      expect(await store.listEvents(t.id)).toHaveLength(1);
    });

    test('tx rolls back every write when the body throws', async () => {
      const t = await store.upsertTicket(ticketInput());
      const err = await store
        .tx(async (tr) => {
          await tr.updateTicket(t.id, { status: 'running' });
          await tr.appendEvent({ ticket_id: t.id, event_kind: 'x', to_status: 'running', actor: 'operator' });
          throw new Error('boom');
        })
        .then(() => null)
        .catch((e: Error) => e);

      expect(err?.message).toBe('boom');
      expect((await store.getTicket(t.id))!.status).toBe('imported');
      expect(await store.listEvents(t.id)).toHaveLength(0);
    });

    test('tx returns the body result', async () => {
      const t = await store.upsertTicket(ticketInput());
      const got = await store.tx(async (tr) => (await tr.getTicket(t.id))!.identifier);
      expect(got).toBe('GAG-1');
    });

    test('lockTicket and lockTarget read the current row inside a transaction', async () => {
      const t = await store.upsertTicket(ticketInput());
      const [target] = await store.replaceTargets(t.id, [targetSpec()]);
      await store.tx(async (tr) => {
        expect((await tr.lockTicket(t.id))!.status).toBe('imported');
        expect((await tr.lockTarget(target!.id))!.repo_alias).toBe('api');
        expect(await tr.lockTicket('00000000-0000-4000-8000-000000000000')).toBeNull();
      });
    });
  });
}

// ── MemoryControlStore: always ────────────────────────────────────────────────
suite('MemoryControlStore', async () => {
  const s = new MemoryControlStore();
  await s.migrate();
  return s;
});

// ── PostgresControlStore: only with TEST_DATABASE_URL ─────────────────────────
if (PG_URL) {
  let shared: PostgresControlStore | null = null;
  suite(
    'PostgresControlStore',
    async () => {
      if (!shared) {
        shared = new PostgresControlStore(PG_URL);
        await shared.migrate();
      }
      await shared.truncateAllForTests();
      return shared;
    },
    async () => {
      await shared?.close();
      shared = null;
    },
  );
} else {
  describe('ControlStore conformance — PostgresControlStore', () => {
    test.skip('set TEST_DATABASE_URL to run against real Postgres', () => {});
  });
}
