/**
 * Sibling-dependency readiness.
 *
 * These cases are carried over from the orchestrator's `repoTargetReady` suite,
 * re-seated against control-plane rows. The rules they pin — `merged` means the
 * upstream succeeded, `deployed` additionally needs the tracker to say so — are
 * the subtle part, and they should not have to be re-derived if this is ever
 * touched again.
 */

import { describe, expect, test } from 'bun:test';
import { evaluateReadiness } from '../control/readiness.ts';
import type { BlockerReadinessConfig } from '../orchestrator/readiness.ts';
import type { TargetRow, TargetStatus, TicketRow } from '../control/types.ts';
import type { BlockerRef } from '../domain/types.ts';

const mergedCfg: BlockerReadinessConfig = {
  terminal_states: ['Done', 'Merged', 'Cancelled'],
  blocker_satisfied_states: [],
  deploy_env_labels: {},
  default_ready_env: 'staging',
  blocker_default_readiness: 'merged',
};

/** With env tracking on, `deployed` needs the label rather than just a terminal state. */
const deployCfg: BlockerReadinessConfig = {
  ...mergedCfg,
  deploy_env_labels: { staging: 'deployed:staging', prod: 'deployed:prod' },
  blocker_satisfied_states: ['Deployed'],
};

function ticket(over: Partial<TicketRow> = {}): TicketRow {
  return {
    id: 'tk-1',
    workspace: 'acme',
    tracker_kind: 'linear',
    external_id: 'lin-1',
    identifier: 'GAG-1',
    title: 'x',
    description: null,
    priority: null,
    url: null,
    branch_name: null,
    parent_external_id: null,
    external_state: 'In Progress',
    external_labels: [],
    blocked_by: [],
    status: 'running',
    analysis_summary: null,
    complexity: null,
    analysis_error: null,
    external_created_at: null,
    external_updated_at: null,
    first_imported_at: '2026-07-01T00:00:00.000Z',
    last_synced_at: '2026-07-01T00:00:00.000Z',
    last_seen_at: '2026-07-01T00:00:00.000Z',
    external_terminal_at: null,
    status_changed_at: '2026-07-01T00:00:00.000Z',
    analyzed_at: null,
    started_at: null,
    completed_at: null,
    ...over,
  };
}

function target(over: Partial<TargetRow> = {}): TargetRow {
  return {
    id: `tg-${over.repo_alias ?? 'fe'}`,
    ticket_id: 'tk-1',
    repo_alias: 'fe',
    repo_url: '',
    local_path: '/fe',
    workflow: 'wf',
    rationale: null,
    components: [],
    depends_on: [],
    ready_when: null,
    status: 'blocked',
    external_target_id: null,
    external_target_url: null,
    external_target_state: null,
    external_target_labels: [],
    run_id: null,
    attempt: 0,
    failure_reason: null,
    cancel_requested: false,
    gate_approval_id: null,
    gate_message: null,
    gate_opened_at: null,
    gate_rework_attempts: 0,
    gate_decision: null,
    gate_decision_comment: null,
    gate_decision_at: null,
    status_changed_at: '2026-07-01T00:00:00.000Z',
    dispatched_at: null,
    completed_at: null,
    ...over,
  };
}

const upstream = (status: TargetStatus, over: Partial<TargetRow> = {}) =>
  target({ repo_alias: 'be', status, ...over });

describe('evaluateReadiness — sibling dependencies', () => {
  test('a target with no dependencies is ready', () => {
    const fe = target();
    expect(evaluateReadiness(ticket(), fe, [fe], mergedCfg).ready).toBe(true);
  });

  test('a dependency that is not in the fan-out is never satisfiable, and says so', () => {
    const fe = target({ depends_on: ['be'] });
    const r = evaluateReadiness(ticket(), fe, [fe], mergedCfg);
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/not in the fan-out/);
  });

  test('an upstream still running blocks, and the reason names it', () => {
    const fe = target({ depends_on: ['be'] });
    const r = evaluateReadiness(ticket(), fe, [fe, upstream('running')], mergedCfg);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('waiting on be (running)');
  });

  test('a succeeded upstream satisfies the default merged readiness', () => {
    const fe = target({ depends_on: ['be'] });
    expect(evaluateReadiness(ticket(), fe, [fe, upstream('succeeded')], mergedCfg).ready).toBe(true);
  });

  test('a failed upstream blocks rather than being treated as done', () => {
    const fe = target({ depends_on: ['be'] });
    expect(evaluateReadiness(ticket(), fe, [fe, upstream('failed')], mergedCfg).ready).toBe(false);
  });

  test('an excluded upstream is called out as unsatisfiable, not left as a bare wait', () => {
    // The exact wording matters: "waiting on be (excluded)" reads as a temporary
    // state an operator should sit out, when in fact nothing will ever change it.
    const fe = target({ depends_on: ['be'] });
    const r = evaluateReadiness(ticket(), fe, [fe, upstream('excluded')], mergedCfg);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('depends on be, which is excluded');
  });

  test('deployed readiness needs more than a succeeded upstream', () => {
    const fe = target({ depends_on: ['be'], ready_when: 'deployed' });
    // Succeeded means merged, not deployed. The sub-issue has no deploy label.
    const be = upstream('succeeded', { external_target_id: 'sub-be', external_target_state: 'Merged' });
    const r = evaluateReadiness(ticket(), fe, [fe, be], deployCfg);
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/deployed/);
  });

  test("deployed readiness is satisfied by the upstream sub-issue's deploy label", () => {
    const fe = target({ depends_on: ['be'], ready_when: 'deployed' });
    const be = upstream('succeeded', {
      external_target_id: 'sub-be',
      external_target_state: 'Merged',
      external_target_labels: ['deployed:staging'],
    });
    expect(evaluateReadiness(ticket(), fe, [fe, be], deployCfg).ready).toBe(true);
  });

  test('a named environment reads that environment’s label, not the default', () => {
    const fe = target({ depends_on: ['be'], ready_when: 'deployed:prod' });
    const staging = upstream('succeeded', {
      external_target_id: 'sub-be',
      external_target_labels: ['deployed:staging'],
    });
    expect(evaluateReadiness(ticket(), fe, [fe, staging], deployCfg).ready).toBe(false);

    const prod = upstream('succeeded', {
      external_target_id: 'sub-be',
      external_target_labels: ['deployed:prod'],
    });
    expect(evaluateReadiness(ticket(), fe, [fe, prod], deployCfg).ready).toBe(true);
  });

  test("a mono-repo upstream falls back to the ticket's own tracker state", () => {
    // No sub-issue, so the ticket is the tracker issue for that target.
    const fe = target({ depends_on: ['be'], ready_when: 'deployed' });
    const be = upstream('succeeded');
    expect(
      evaluateReadiness(
        ticket({ external_state: 'Deployed', external_labels: [] }),
        fe,
        [fe, be],
        deployCfg,
      ).ready,
    ).toBe(true);
  });

  test("a mono-repo upstream reads the ticket's labels, not the empty target ones", () => {
    // The deploy label is the primary signal and the state fallback is secondary,
    // so this is the case that actually distinguishes the two label sources: the
    // state alone ('Merged') does not satisfy `deployed`.
    const fe = target({ depends_on: ['be'], ready_when: 'deployed' });
    const be = upstream('succeeded');
    const t = ticket({ external_state: 'Merged', external_labels: ['deployed:staging'] });
    expect(evaluateReadiness(t, fe, [fe, be], deployCfg).ready).toBe(true);

    // And a target that *does* have its own sub-issue reads that instead — the
    // ticket's label must not stand in for a sub-issue that has not deployed yet.
    const withSub = upstream('succeeded', { external_target_id: 'sub-be', external_target_state: 'Merged' });
    expect(evaluateReadiness(t, fe, [fe, withSub], deployCfg).ready).toBe(false);
  });

  test('every dependency must be satisfied, not just one', () => {
    const fe = target({ depends_on: ['be', 'etl'] });
    const be = upstream('succeeded');
    const etl = target({ repo_alias: 'etl', status: 'running' });
    expect(evaluateReadiness(ticket(), fe, [fe, be, etl], mergedCfg).ready).toBe(false);
  });
});

describe('evaluateReadiness — ticket-level blockers', () => {
  const blocker = (state: string | null, labels: string[] = []): BlockerRef => ({
    id: 'b1',
    identifier: 'GAG-9',
    state,
    labels,
  });

  test('an unsatisfied tracker blocker blocks, whatever the siblings say', () => {
    const fe = target();
    const r = evaluateReadiness(ticket({ blocked_by: [blocker('In Progress')] }), fe, [fe], mergedCfg);
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/GAG-9/);
  });

  test('a terminal blocker is satisfied', () => {
    const fe = target();
    expect(
      evaluateReadiness(ticket({ blocked_by: [blocker('Done')] }), fe, [fe], mergedCfg).ready,
    ).toBe(true);
  });

  test('all blockers must be satisfied', () => {
    const fe = target();
    const t = ticket({ blocked_by: [blocker('Done'), { ...blocker('Todo'), identifier: 'GAG-10' }] });
    expect(evaluateReadiness(t, fe, [fe], mergedCfg).ready).toBe(false);
  });

  test('blockers are checked before siblings, so the reason points at the real cause', () => {
    const fe = target({ depends_on: ['be'] });
    const r = evaluateReadiness(
      ticket({ blocked_by: [blocker('Todo')] }),
      fe,
      [fe, upstream('running')],
      mergedCfg,
    );
    expect(r.reason).toMatch(/blocked by GAG-9/);
  });
});
