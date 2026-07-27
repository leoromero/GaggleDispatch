/**
 * The board API.
 *
 * A plain `(method, path, body) → { status, body }` router, deliberately not
 * coupled to `Bun.serve`: the hub mounts it, and the tests drive it directly.
 *
 * Reads go straight to Postgres, so the board renders even with every gaggle
 * process stopped. Writes are status writes — no command channel to the daemon,
 * because "Start" means "set these targets to ready" and the daemon picks them up
 * whenever it is running. The one exception is answering a gate, which needs the
 * executor and is therefore recorded as intent for the owning daemon (see
 * `Reconciler.applyGateDecisions`).
 *
 * Error mapping:
 *   404  the id does not resolve
 *   409  the transition is illegal from the current status, or lost a race
 *   400  the request body is unusable
 */

import {
  ControlConflictError,
  InvalidControlTransitionError,
} from './transitions.ts';
import { ControlNotFoundError } from './service.ts';
import type { ControlService } from './service.ts';
import type { ControlStore, TicketQuery } from './store/types.ts';
import { TICKET_STATUSES, type TicketStatus } from './types.ts';

export interface ApiRequest {
  method: string;
  /** Path with the API prefix already stripped, e.g. `/board`. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface ControlApiDeps {
  store: ControlStore;
  /** Absent in a read-only deployment; every write then answers 503. */
  service: ControlService | null;
  /** Triggers a sync pass. Absent when no daemon is reachable. */
  requestSync?: (workspace: string | undefined) => Promise<unknown>;
}

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const bad = (message: string): ApiResponse => ({ status: 400, body: { error: message } });
const notFound = (message: string): ApiResponse => ({ status: 404, body: { error: message } });
const conflict = (message: string): ApiResponse => ({ status: 409, body: { error: message } });

export class ControlApi {
  constructor(private readonly deps: ControlApiDeps) {}

  async handle(req: ApiRequest): Promise<ApiResponse> {
    try {
      return await this.route(req);
    } catch (err) {
      if (err instanceof ControlNotFoundError) return notFound(err.message);
      if (err instanceof InvalidControlTransitionError) return conflict(err.message);
      if (err instanceof ControlConflictError) return conflict(err.message);
      throw err;
    }
  }

  private async route(req: ApiRequest): Promise<ApiResponse> {
    const { method, path } = req;
    const segments = path.split('/').filter(Boolean);

    // ── reads ─────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/board') {
      const query = this.parseQuery(req);
      if ('error' in query) return bad(query.error);
      const [rows, counts] = await Promise.all([
        this.deps.store.board(query.value),
        this.deps.store.countTicketsByStatus(query.value.workspace),
      ]);
      return ok({
        tickets: rows,
        counts,
        latest_event_id: await this.deps.store.latestEventId(query.value.workspace),
      });
    }

    if (method === 'GET' && path === '/gates') {
      return ok({ gates: await this.deps.store.listPendingGates(req.query?.workspace) });
    }

    if (method === 'GET' && path === '/cursor') {
      // Cheap poll target: the dashboard refetches the board only when this moves.
      return ok({ latest_event_id: await this.deps.store.latestEventId(req.query?.workspace) });
    }

    if (method === 'GET' && segments[0] === 'tickets' && segments.length === 2) {
      const ticket = await this.deps.store.getTicket(segments[1]!);
      if (!ticket) return notFound(`ticket ${segments[1]} not found`);
      const [targets, events] = await Promise.all([
        this.deps.store.listTargets(ticket.id),
        this.deps.store.listEvents(ticket.id, 200),
      ]);
      return ok({ ticket, targets, events });
    }

    // ── writes ────────────────────────────────────────────────────────────
    if (method === 'POST' && segments[0] === 'tickets' && segments.length === 3) {
      const service = this.requireService();
      if ('error' in service) return service.error;
      const [, id, action] = segments as [string, string, string];
      switch (action) {
        case 'analyze':
          return ok({ transition: await service.value.requestAnalysis(id) });
        case 'start':
          return ok({ transition: await service.value.start(id) });
        case 'cancel':
          return ok({ transition: await service.value.cancelTicket(id) });
        case 'archive':
          return ok({ transition: await service.value.archive(id) });
        case 'restore':
          return ok({ transition: await service.value.restore(id) });
        default:
          return notFound(`unknown ticket action '${action}'`);
      }
    }

    if (method === 'POST' && segments[0] === 'targets' && segments.length === 3) {
      const service = this.requireService();
      if ('error' in service) return service.error;
      const [, id, action] = segments as [string, string, string];
      switch (action) {
        case 'redispatch':
          return ok({ transition: await service.value.redispatchTarget(id) });
        case 'cancel':
          return ok({ transition: await service.value.cancelTarget(id) });
        case 'exclude':
          return ok({ transition: await service.value.excludeTarget(id) });
        case 'include':
          return ok({ transition: await service.value.includeTarget(id) });
        default:
          return notFound(`unknown target action '${action}'`);
      }
    }

    if (method === 'PATCH' && segments[0] === 'targets' && segments.length === 2) {
      const service = this.requireService();
      if ('error' in service) return service.error;
      const body = asObject(req.body);
      if (!body) return bad('expected a JSON object body');
      const workflow = body.workflow;
      if (typeof workflow !== 'string' || !workflow.trim()) {
        return bad("expected a non-empty string 'workflow'");
      }
      return ok({ target: await service.value.setTargetWorkflow(segments[1]!, workflow) });
    }

    // ── gates: recorded as intent, applied by the owning daemon ───────────
    if (method === 'POST' && segments[0] === 'gates' && segments.length === 3) {
      const [, id, action] = segments as [string, string, string];
      const body = asObject(req.body) ?? {};
      switch (action) {
        case 'approve': {
          const comment = optionalString(body.comment);
          if (comment instanceof Error) return bad(comment.message);
          return this.recordGate(id, 'approved', comment);
        }
        case 'reject': {
          const reason = optionalString(body.reason);
          if (reason instanceof Error) return bad(reason.message);
          if (!reason) return bad("a rejection needs a 'reason' so the rework has something to act on");
          return this.recordGate(id, 'rejected', reason);
        }
        case 'create-blocker': {
          const title = body.title;
          if (typeof title !== 'string' || !title.trim()) {
            return bad("expected a non-empty string 'title'");
          }
          const description = typeof body.description === 'string' ? body.description : '';
          return this.recordGate(id, 'blocker', JSON.stringify({ title, description }));
        }
        default:
          return notFound(`unknown gate action '${action}'`);
      }
    }

    if (method === 'POST' && path === '/sync') {
      if (!this.deps.requestSync) {
        return { status: 503, body: { error: 'no gaggle is reachable to run a sync' } };
      }
      return ok({ result: await this.deps.requestSync(req.query?.workspace) });
    }

    return notFound(`no route for ${method} ${path}`);
  }

  private async recordGate(
    targetId: string,
    decision: 'approved' | 'rejected' | 'blocker',
    comment: string | null,
  ): Promise<ApiResponse> {
    const target = await this.deps.store.requestGateDecision(targetId, decision, comment);
    if (target) return ok({ target_id: target.id, decision, pending: true });

    // The conditional update matched nothing. Distinguish "no such target" from
    // "the gate moved on" so the dashboard can say something useful.
    const existing = await this.deps.store.getTarget(targetId);
    if (!existing) return notFound(`target ${targetId} not found`);
    if (existing.gate_decision) {
      return conflict(`this gate was already answered (${existing.gate_decision})`);
    }
    return conflict(`target is ${existing.status}, not waiting at a gate`);
  }

  private requireService(): { value: ControlService } | { error: ApiResponse } {
    if (!this.deps.service) {
      return { error: { status: 503, body: { error: 'control writes are not configured' } } };
    }
    return { value: this.deps.service };
  }

  private parseQuery(req: ApiRequest): { value: TicketQuery } | { error: string } {
    const q = req.query ?? {};
    const value: TicketQuery = {};
    if (q.workspace) value.workspace = q.workspace;
    if (q.q) value.search = q.q;

    if (q.status) {
      const parts = q.status.split(',').map((s) => s.trim()).filter(Boolean);
      const invalid = parts.filter((p) => !TICKET_STATUSES.includes(p as TicketStatus));
      if (invalid.length > 0) return { error: `unknown status: ${invalid.join(', ')}` };
      value.status = parts as TicketStatus[];
    }

    if (q.limit !== undefined) {
      const n = Number(q.limit);
      if (!Number.isFinite(n) || n <= 0) return { error: `limit must be a positive number` };
      value.limit = Math.min(Math.floor(n), 500);
    }
    if (q.offset !== undefined) {
      const n = Number(q.offset);
      if (!Number.isFinite(n) || n < 0) return { error: `offset must be zero or more` };
      value.offset = Math.floor(n);
    }
    return { value };
  }
}

// ─── body helpers ───────────────────────────────────────────────────────────

function asObject(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return null;
}

/** A present-but-wrong-typed field is a client bug; absent is fine. */
function optionalString(v: unknown): string | null | Error {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return new Error('expected a string');
  return v;
}
