/**
 * Control-plane composition root.
 *
 * Everything in `src/control/` takes its collaborators through constructor
 * parameters and depends only on interfaces. This is the one file that knows the
 * concrete types, so it is the only place to look to answer "what is actually
 * wired to what".
 *
 * Two shapes, because two processes need different halves:
 *
 *   - {@link openControlPlane} — the full plane, for the gaggle daemon: store,
 *     transitions, sync, reconciler, and the ports that reach the executor and
 *     the tracker.
 *   - {@link openControlReadPlane} — store and API only, for the hub. The hub
 *     serves the board and records operator intent; it never touches the
 *     executor, which is why gate answers are written as intent for the daemon
 *     rather than applied inline.
 */

import type { ServiceConfig } from '../domain/types.ts';
import type { LinearClient } from '../tracker/linear.ts';
import { logger } from '../util/logger.ts';
import { ControlApi } from './api.ts';
import {
  LinearReadAdapter,
  LinearStructureAdapter,
  LinearWriteAdapter,
} from './adapters/linear.ts';
import type {
  AnalyzerPort,
  ExecutorPort,
  RunStatusPort,
  SlotPort,
  TrackerStructurePort,
} from './ports.ts';
import { Reconciler } from './reconciler.ts';
import { ControlService, type ControlServiceConfig } from './service.ts';
import { PostgresControlStore } from './store/postgres.ts';
import type { ControlStore } from './store/types.ts';
import { TicketSync } from './sync.ts';
import { DEFAULT_MIRROR_LABELS, type MirrorLabels } from './transitions.ts';
import { completedState, defaultGateResumeState } from '../config/service-config.ts';

export interface ControlPlane {
  store: ControlStore;
  service: ControlService;
  sync: TicketSync;
  reconciler: Reconciler;
  api: ControlApi;
  close(): Promise<void>;
}

export interface ControlReadPlane {
  store: ControlStore;
  api: ControlApi;
  close(): Promise<void>;
}

export interface OpenControlPlaneOptions {
  cfg: ServiceConfig;
  /** Names the tickets this process owns. Several gaggles share one database. */
  workspace: string;
  tracker: LinearClient;
  executor: ExecutorPort;
  runs: RunStatusPort;
  analyzer: AnalyzerPort;
  slots: SlotPort;
  /** Injected by tests to avoid a real database. */
  store?: ControlStore;
}

/** Build the full control plane. Runs pending migrations. */
export async function openControlPlane(opts: OpenControlPlaneOptions): Promise<ControlPlane> {
  const store = opts.store ?? openStore(opts.cfg);
  await store.migrate();

  const structure = new LinearStructureAdapter(opts.tracker, opts.cfg);

  const service = new ControlService({
    store,
    cfg: serviceConfigFrom(opts.cfg, opts.workspace),
    executor: opts.executor,
    tracker: structure,
    analyzer: opts.analyzer,
  });

  const sync = new TicketSync({
    store,
    service,
    tracker: new LinearReadAdapter(opts.tracker),
    cfg: {
      workspace: opts.workspace,
      tracker_kind: opts.cfg.tracker.kind,
      terminal_states: opts.cfg.tracker.terminal_states,
      active_states: opts.cfg.tracker.active_states,
    },
  });

  const reconciler = new Reconciler({
    store,
    service,
    tracker: structure,
    slots: opts.slots,
    runs: opts.runs,
    trackerWrites: new LinearWriteAdapter(opts.tracker),
    cfg: {
      workspace: opts.workspace,
      gate_timeout_ms: opts.cfg.archon.gate_timeout_ms,
      outbox: {
        batch_size: 50,
        max_attempts: opts.cfg.tracker.outbox_max_attempts,
      },
    },
  });

  const api = new ControlApi({
    store,
    service,
    requestSync: () => sync.sync(),
  });

  logger.info('Control plane open', {
    workspace: opts.workspace,
    mirror_labels: opts.cfg.tracker.mirror_labels,
    gate_timeout_ms: opts.cfg.archon.gate_timeout_ms,
  });

  return {
    store,
    service,
    sync,
    reconciler,
    api,
    close: () => store.close(),
  };
}

/**
 * Build the read/intent half, for the hub.
 *
 * `service` is present, because most operator actions are pure status writes the
 * hub can perform itself. The executor and analyzer ports throw if reached, which
 * is deliberate: the hub's action set provably never needs them, and a loud
 * failure is better than a silent one if that ever stops being true. Gate answers
 * take the intent path precisely to keep that promise.
 */
export async function openControlReadPlane(opts: {
  cfg: ServiceConfig;
  /** Forwards a sync request to a running gaggle. Omit when none is reachable. */
  requestSync?: (workspace: string | undefined) => Promise<unknown>;
  store?: ControlStore;
}): Promise<ControlReadPlane> {
  const store = opts.store ?? openStore(opts.cfg);
  await store.migrate();

  const service = new ControlService({
    store,
    // The workspace is per-ticket on the read side: every action addresses a
    // ticket by id, and the row carries its own workspace. The value here is only
    // used to stamp outbox rows, which take it from the ticket in practice.
    cfg: serviceConfigFrom(opts.cfg, ''),
    executor: unreachable<ExecutorPort>('executor'),
    tracker: unreachable<TrackerStructurePort>('tracker structure'),
    analyzer: unreachable<AnalyzerPort>('analyzer'),
  });

  const api = new ControlApi({ store, service, requestSync: opts.requestSync });
  return { store, api, close: () => store.close() };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function openStore(cfg: ServiceConfig): ControlStore {
  return new PostgresControlStore(
    cfg.database.url,
    cfg.database.max_connections > 0 ? { maxConnections: cfg.database.max_connections } : {},
  );
}

export function serviceConfigFrom(cfg: ServiceConfig, workspace: string): ControlServiceConfig {
  return {
    workspace,
    tracker_kind: cfg.tracker.kind,
    mirror_labels: cfg.tracker.mirror_labels,
    labels: mirrorLabelsFrom(cfg),
    completed_state: completedState(cfg),
    gate_waiting_state: cfg.tracker.gate_waiting_state,
    gate_resume_state: cfg.tracker.gate_resume_state ? defaultGateResumeState(cfg) : null,
    // Matches the supervised workflow's plan gate, which advertises three
    // revision cycles before it proceeds.
    max_gate_rework_attempts: 3,
    readiness: cfg.tracker,
  };
}

function mirrorLabelsFrom(cfg: ServiceConfig): MirrorLabels {
  const l = cfg.tracker.gaggle_labels;
  return {
    analyzing: l.analyzing || DEFAULT_MIRROR_LABELS.analyzing,
    claimed: l.claimed || DEFAULT_MIRROR_LABELS.claimed,
    waiting_human: l.waiting_human || DEFAULT_MIRROR_LABELS.waiting_human,
    failed: l.failed || DEFAULT_MIRROR_LABELS.failed,
  };
}

/**
 * A port the caller has established it never needs.
 *
 * Throwing names the port and the reason, so if the assumption ever breaks the
 * log says exactly what to wire up rather than leaving a silent no-op.
 */
function unreachable<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get: (_target, prop) => () => {
      throw new Error(
        `The ${what} port is not available in this process (called ${String(prop)}). ` +
          `Operator actions that need it are recorded as intent for the owning gaggle daemon.`,
      );
    },
  });
}
