/**
 * In-memory Store, for tests only.
 *
 * Not a second supported backend — it exists so engine semantics (planning,
 * conditions, loops, resume) can be tested without a database. It mirrors the
 * Postgres behaviours the engine actually leans on, including the ones that
 * are easy to get subtly wrong: shallow metadata merge, COALESCE-on-upsert for
 * node output, lease expiry, and the one-pending-approval-per-run constraint.
 *
 * `store-conformance.test.ts` runs the same suite against both, so drift
 * between the two shows up as a test failure rather than a production
 * surprise.
 */

import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalRow,
  CreateRunInput,
  EventRow,
  LoopIterationRow,
  NodeRow,
  RunQuery,
  RunRow,
  ScaffoldJobRow,
  Store,
  SyncedRepoRow,
  UpsertNodeInput,
  WorktreeRow,
} from './types.ts';

const nowIso = () => new Date().toISOString();

/**
 * Composite map key. Uses a unit separator rather than a space or a slash so a
 * node id or branch name containing one cannot collide with another row's key.
 */
const SEP = '\u001f';
const key = (...parts: string[]): string => parts.join(SEP);

function clone<T>(v: T): T {
  return v === undefined || v === null ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export class MemoryStore implements Store {
  private runs = new Map<string, RunRow>();
  private nodes = new Map<string, NodeRow>(); // `${run_id}${SEP}${node_id}`
  private loops = new Map<string, LoopIterationRow>(); // key(run, node, iteration)
  private events: EventRow[] = [];
  private approvals = new Map<string, ApprovalRow>();
  private worktrees = new Map<string, WorktreeRow>(); // key(repo_slug, branch)
  private analyses = new Map<string, unknown>();
  private scaffolds = new Map<string, ScaffoldJobRow>();
  private syncedRepos: SyncedRepoRow[] = [];
  private syncedAt: string | null = null;
  private eventSeq = 0;
  /** Preserves insertion order when started_at timestamps collide. */
  private runSeq = new Map<string, number>();
  private seqCounter = 0;

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  private nodeKey(runId: string, nodeId: string) {
    return key(runId, nodeId);
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  async createRun(input: CreateRunInput): Promise<RunRow> {
    const row: RunRow = {
      id: input.id,
      workflow_name: input.workflow_name,
      workflow_source: input.workflow_source,
      workflow_hash: input.workflow_hash,
      user_message: input.user_message,
      status: 'pending',
      repo_slug: input.repo_slug ?? null,
      working_path: input.working_path ?? null,
      base_branch: input.base_branch ?? null,
      branch: input.branch ?? null,
      artifacts_dir: input.artifacts_dir ?? null,
      external_key: input.external_key ?? null,
      env: clone(input.env ?? {}),
      metadata: clone(input.metadata ?? {}),
      started_at: nowIso(),
      completed_at: null,
      last_activity_at: nowIso(),
      lease_owner: null,
      lease_expires_at: null,
      dry_run: input.dry_run ?? false,
    };
    this.runs.set(row.id, row);
    this.runSeq.set(row.id, this.seqCounter++);
    return clone(row);
  }

  async getRun(id: string): Promise<RunRow | null> {
    const r = this.runs.get(id);
    return r ? clone(r) : null;
  }

  async listRuns(query: RunQuery = {}): Promise<RunRow[]> {
    let out = [...this.runs.values()];
    if (query.status?.length) out = out.filter((r) => query.status!.includes(r.status));
    if (query.repo_slug) out = out.filter((r) => r.repo_slug === query.repo_slug);
    if (query.working_path_contains) {
      const needle = query.working_path_contains.toLowerCase();
      out = out.filter((r) => (r.working_path ?? '').toLowerCase().includes(needle));
    }
    out.sort((a, b) => {
      const d = Date.parse(b.started_at) - Date.parse(a.started_at);
      return d !== 0 ? d : (this.runSeq.get(b.id) ?? 0) - (this.runSeq.get(a.id) ?? 0);
    });
    if (query.limit && query.limit > 0) out = out.slice(0, Math.trunc(query.limit));
    return out.map(clone);
  }

  async updateRun(
    id: string,
    patch: Parameters<Store['updateRun']>[1],
  ): Promise<RunRow | null> {
    const r = this.runs.get(id);
    if (!r) return null;
    const { metadata, ...rest } = patch;
    const target = r as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) target[k] = v;
    }
    // Shallow merge, matching `metadata || $n::jsonb` in Postgres.
    if (metadata !== undefined) r.metadata = { ...r.metadata, ...clone(metadata) };
    return clone(r);
  }

  async touchRun(id: string): Promise<void> {
    const r = this.runs.get(id);
    if (r) r.last_activity_at = nowIso();
  }

  // ── leases ────────────────────────────────────────────────────────────────

  async acquireLease(id: string, owner: string, ttlMs: number): Promise<boolean> {
    const r = this.runs.get(id);
    if (!r) return false;
    const free =
      r.lease_owner === null ||
      r.lease_owner === owner ||
      r.lease_expires_at === null ||
      Date.parse(r.lease_expires_at) < Date.now();
    if (!free) return false;
    r.lease_owner = owner;
    r.lease_expires_at = new Date(Date.now() + ttlMs).toISOString();
    return true;
  }

  async renewLease(id: string, owner: string, ttlMs: number): Promise<void> {
    const r = this.runs.get(id);
    if (r && r.lease_owner === owner) {
      r.lease_expires_at = new Date(Date.now() + ttlMs).toISOString();
    }
  }

  async releaseLease(id: string, owner: string): Promise<void> {
    const r = this.runs.get(id);
    if (r && r.lease_owner === owner) {
      r.lease_owner = null;
      r.lease_expires_at = null;
    }
  }

  async findExpiredRuns(): Promise<RunRow[]> {
    const now = Date.now();
    return [...this.runs.values()]
      .filter(
        (r) =>
          r.status === 'running' &&
          (r.lease_expires_at === null || Date.parse(r.lease_expires_at) < now),
      )
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
      .map(clone);
  }

  // ── nodes ─────────────────────────────────────────────────────────────────

  async upsertNode(input: UpsertNodeInput): Promise<NodeRow> {
    const key = this.nodeKey(input.run_id, input.node_id);
    const prev = this.nodes.get(key);
    const row: NodeRow = {
      run_id: input.run_id,
      node_id: input.node_id,
      node_type: input.node_type,
      status: input.status,
      attempt: input.attempt ?? prev?.attempt ?? 0,
      // COALESCE semantics: a later write with null output must not erase a
      // previously captured one (the engine writes status transitions
      // separately from results).
      output: input.output ?? prev?.output ?? null,
      output_json: input.output_json ?? prev?.output_json ?? null,
      error: input.error ?? null,
      claude_session_id: input.claude_session_id ?? prev?.claude_session_id ?? null,
      side_effects: input.side_effects ?? prev?.side_effects ?? 'idempotent',
      input_tokens: input.input_tokens ?? prev?.input_tokens ?? 0,
      output_tokens: input.output_tokens ?? prev?.output_tokens ?? 0,
      started_at: prev?.started_at ?? input.started_at ?? null,
      completed_at: input.completed_at ?? null,
    };
    this.nodes.set(key, row);
    return clone(row);
  }

  async getNodes(runId: string): Promise<NodeRow[]> {
    return [...this.nodes.values()]
      .filter((n) => n.run_id === runId)
      .sort((a, b) => a.node_id.localeCompare(b.node_id))
      .map(clone);
  }

  async getNode(runId: string, nodeId: string): Promise<NodeRow | null> {
    const n = this.nodes.get(this.nodeKey(runId, nodeId));
    return n ? clone(n) : null;
  }

  async markRunningNodesInterrupted(runId: string): Promise<NodeRow[]> {
    const hit: NodeRow[] = [];
    for (const n of this.nodes.values()) {
      if (n.run_id === runId && n.status === 'running') {
        n.status = 'interrupted';
        hit.push(clone(n));
      }
    }
    return hit;
  }

  // ── loop iterations ───────────────────────────────────────────────────────

  async appendLoopIteration(row: Omit<LoopIterationRow, 'created_at'>): Promise<void> {
    const k = key(row.run_id, row.node_id, String(row.iteration));
    const prev = this.loops.get(k);
    this.loops.set(k, { ...row, created_at: prev?.created_at ?? nowIso() });
  }

  async getLoopIterations(runId: string, nodeId: string): Promise<LoopIterationRow[]> {
    return [...this.loops.values()]
      .filter((l) => l.run_id === runId && l.node_id === nodeId)
      .sort((a, b) => a.iteration - b.iteration)
      .map(clone);
  }

  // ── events ────────────────────────────────────────────────────────────────

  async appendEvent(
    runId: string,
    eventType: string,
    nodeId: string | null,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    this.events.push({
      id: ++this.eventSeq,
      run_id: runId,
      event_type: eventType,
      node_id: nodeId,
      data: clone(data),
      created_at: nowIso(),
    });
  }

  async listEvents(runId: string, sinceId = 0): Promise<EventRow[]> {
    return this.events.filter((e) => e.run_id === runId && e.id > sinceId).map(clone);
  }

  // ── approvals ─────────────────────────────────────────────────────────────

  async createApproval(input: {
    id: string;
    run_id: string;
    node_id: string;
    message: string;
  }): Promise<ApprovalRow> {
    // Mirrors the partial unique index: one undecided gate per run.
    for (const a of this.approvals.values()) {
      if (a.run_id === input.run_id && a.decision === null) {
        throw new Error(`run ${input.run_id} already has a pending approval (${a.node_id})`);
      }
    }
    const row: ApprovalRow = {
      id: input.id,
      run_id: input.run_id,
      node_id: input.node_id,
      message: input.message,
      decision: null,
      comment: null,
      rework_attempts: 0,
      created_at: nowIso(),
      decided_at: null,
    };
    this.approvals.set(row.id, row);
    return clone(row);
  }

  async getPendingApproval(runId: string): Promise<ApprovalRow | null> {
    const pending = [...this.approvals.values()]
      .filter((a) => a.run_id === runId && a.decision === null)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return pending[0] ? clone(pending[0]) : null;
  }

  async updateApprovalMessage(id: string, message: string): Promise<void> {
    const a = this.approvals.get(id);
    if (a) a.message = message;
  }

  async decideApproval(
    id: string,
    decision: ApprovalDecision,
    comment: string | null,
  ): Promise<ApprovalRow | null> {
    const a = this.approvals.get(id);
    if (!a || a.decision !== null) return null;
    a.decision = decision;
    a.comment = comment;
    a.decided_at = nowIso();
    return clone(a);
  }

  async incrementReworkAttempts(id: string): Promise<number> {
    const a = this.approvals.get(id);
    if (!a) return 0;
    a.rework_attempts += 1;
    return a.rework_attempts;
  }

  // -- run lookup by caller identity ----------------------------------------

  async findRunByExternalKey(externalKey: string): Promise<RunRow | null> {
    const hits = [...this.runs.values()]
      .filter((r) => r.external_key === externalKey)
      .sort((a, b) => {
        const d = Date.parse(b.started_at) - Date.parse(a.started_at);
        return d !== 0 ? d : (this.runSeq.get(b.id) ?? 0) - (this.runSeq.get(a.id) ?? 0);
      });
    return hits[0] ? clone(hits[0]) : null;
  }

  // -- retry schedule --------------------------------------------------------

  // -- analysis cache --------------------------------------------------------

  async saveAnalysis(issueId: string, analysis: unknown): Promise<void> {
    this.analyses.set(issueId, clone(analysis));
  }

  async getAnalysis(issueId: string): Promise<unknown | null> {
    const a = this.analyses.get(issueId);
    return a === undefined ? null : clone(a);
  }

  async deleteAnalysis(issueId: string): Promise<void> {
    this.analyses.delete(issueId);
  }

  // -- scaffold jobs ---------------------------------------------------------

  async upsertScaffoldJob(row: ScaffoldJobRow): Promise<void> {
    this.scaffolds.set(row.slug, clone(row));
  }

  async listScaffoldJobs(): Promise<ScaffoldJobRow[]> {
    return [...this.scaffolds.values()]
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
      .map(clone);
  }

  async deleteScaffoldJob(slug: string): Promise<void> {
    this.scaffolds.delete(slug);
  }

  // -- synced registry -------------------------------------------------------

  async replaceSyncedRegistry(syncedAt: string, repos: SyncedRepoRow[]): Promise<void> {
    this.syncedRepos = clone(repos);
    this.syncedAt = syncedAt;
  }

  async loadSyncedRegistry(): Promise<{ synced_at: string; repositories: SyncedRepoRow[] } | null> {
    if (this.syncedAt === null) return null;
    return {
      synced_at: this.syncedAt,
      repositories: [...this.syncedRepos].sort((a, b) => a.slug.localeCompare(b.slug)).map(clone),
    };
  }

  async registrySyncedAt(): Promise<string | null> {
    return this.syncedAt;
  }

  // ── worktrees ─────────────────────────────────────────────────────────────

  async upsertWorktree(
    row: Omit<WorktreeRow, 'created_at' | 'last_activity_at'>,
  ): Promise<WorktreeRow> {
    const k = key(row.repo_slug, row.branch);
    const prev = this.worktrees.get(k);
    const next: WorktreeRow = {
      ...row,
      id: prev?.id ?? row.id ?? randomUUID(),
      created_at: prev?.created_at ?? nowIso(),
      last_activity_at: nowIso(),
    };
    this.worktrees.set(k, next);
    return clone(next);
  }

  async listWorktrees(repoSlug?: string): Promise<WorktreeRow[]> {
    return [...this.worktrees.values()]
      .filter((w) => !repoSlug || w.repo_slug === repoSlug)
      .sort((a, b) => Date.parse(b.last_activity_at) - Date.parse(a.last_activity_at))
      .map(clone);
  }

  async getWorktree(repoSlug: string, branch: string): Promise<WorktreeRow | null> {
    const w = this.worktrees.get(key(repoSlug, branch));
    return w ? clone(w) : null;
  }

  async touchWorktree(repoSlug: string, branch: string): Promise<void> {
    const w = this.worktrees.get(key(repoSlug, branch));
    if (w) w.last_activity_at = nowIso();
  }

  async deleteWorktree(repoSlug: string, branch: string): Promise<void> {
    this.worktrees.delete(key(repoSlug, branch));
  }
}
