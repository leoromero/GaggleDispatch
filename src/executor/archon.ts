/**
 * Archon Workflow Executor (Section 11).
 *
 * Spawns `archon workflow run <workflow> --cwd <checkout> "<message>"`,
 * streams stdout+stderr, captures the DB run-id, and detects gate-pause
 * from log output (fast path — the poller is the authoritative source).
 *
 * Approve / reject / cancel / status-query are handled by ArchonClient
 * (HTTP API). The stall timer lives in ArchonRunPoller. This file owns
 * only: process lifecycle, output streaming, and early event detection.
 */

import { logger } from '../util/logger.ts';

export type ArchonEvent =
  | { type: 'archon_started'; pid: number }
  | { type: 'archon_output'; line: string }
  | { type: 'run_gate_paused'; run_id: string; gate_message: string; raw: string }
  /** Emitted once when Archon logs the workflowRunId — use this to correlate with the DB. */
  | { type: 'run_id'; db_run_id: string }
  | { type: 'run_succeeded' }
  | { type: 'run_failed'; exit_code: number }
  | { type: 'run_timed_out' }
  | { type: 'run_stalled' }
  | { type: 'run_cancelled' };

/**
 * Matches Archon's `workflow_starting` log line to extract the DB run id.
 * Example line: {"level":30,...,"workflowRunId":"9136a16135d082cb9f0ac75523b3b56e","msg":"workflow_starting"}
 */
export const WORKFLOW_RUN_ID_REGEX = /"workflowRunId":"([0-9a-f]{32})"/;

export interface ExecutorOptions {
  archonCommand: string; // e.g. "archon workflow run"
  workflowName: string;
  cwd: string;
  message: string;
  env?: Record<string, string | undefined>;
  turnTimeoutMs: number;
  /** @deprecated Stall detection is handled by ArchonRunPoller. Kept for back-compat; ignored. */
  stallTimeoutMs?: number;
}

export interface RunHandle {
  pid: number | null;
  cancel: (reason?: string) => void;
  done: Promise<void>;
}

export const RUN_ID_REGEX = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;
export const PAUSE_REGEX = /paused|approval[- ]?gate|waiting for approval|loop[- ]interactive/i;

/**
 * Returns the run-id when the line indicates a gate pause AND a UUID is present.
 * Used by the orchestrator's stderr handler. Pure / safe to unit-test.
 */
export function detectGatePause(line: string): { run_id: string } | null {
  if (!PAUSE_REGEX.test(line)) return null;
  const m = line.match(RUN_ID_REGEX);
  if (!m || !m[1]) return null;
  return { run_id: m[1] };
}

/** Tokenize a shell-ish command string (handles "double" and 'single' quotes). */
export function tokenizeArchonCommand(s: string): string[] {
  const out: string[] = [];
  const re = /(?:[^\s"']+|"([^"]*)"|'([^']*)')+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] ?? m[2] ?? m[0]);
  }
  return out;
}

/** Build the argv for `archon workflow run`. Pure helper for unit tests. */
export function buildArchonRunArgv(commandStr: string, workflow: string, cwd: string, message: string): string[] {
  return [...tokenizeArchonCommand(commandStr), workflow, '--cwd', cwd, message];
}

/**
 * Build the argv for `archon workflow approve <runId> [comment]`.
 * Uses the same binary prefix as the run command ("archon workflow").
 * The CLI approve command stores the approval AND auto-resumes via
 * workflowRunCommand(..., { resume: true }), preserving the comment as
 * $<gate-id>.output for downstream nodes.
 */
export function buildArchonApproveArgv(commandStr: string, runId: string, comment?: string): string[] {
  const parts = tokenizeArchonCommand(commandStr);
  const argv = [...parts.slice(0, 2), 'approve', runId];
  if (comment) argv.push(comment);
  return argv;
}

/**
 * Build the argv for `archon workflow resume <runId>`.
 * commandStr is the same `archon workflow run` string — we reuse the prefix
 * ("archon workflow") and replace the subcommand with "resume".
 */
export function buildArchonResumeArgv(commandStr: string, runId: string): string[] {
  const parts = tokenizeArchonCommand(commandStr);
  // parts = ["archon", "workflow", "run"] → take first two, swap last for "resume"
  return [...parts.slice(0, 2), 'resume', runId];
}

export function startArchon(opts: ExecutorOptions, onEvent: (e: ArchonEvent) => void): RunHandle {
  const argv = parseArchonCommand(opts.archonCommand, opts.workflowName, opts.cwd, opts.message);

  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  let pidEmitted = false;
  if (proc.pid) {
    pidEmitted = true;
    onEvent({ type: 'archon_started', pid: proc.pid });
  }

  let capturedRunId: string | null = null;
  let cancelled = false;
  let timedOut = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });

  const turnTimer = setTimeout(() => {
    if (proc.exitCode === undefined) {
      timedOut = true;
      logger.warn('Archon turn timeout — killing', { pid: proc.pid });
      onEvent({ type: 'run_timed_out' });
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
  }, opts.turnTimeoutMs);

  let capturedDbRunId: string | null = null;

  const handleStderrLine = (line: string) => {
    if (!line.trim()) return;
    onEvent({ type: 'archon_output', line });

    // Capture the Archon DB run id from the workflow_starting log line.
    if (capturedDbRunId === null) {
      const m = line.match(WORKFLOW_RUN_ID_REGEX);
      if (m?.[1]) {
        capturedDbRunId = m[1];
        onEvent({ type: 'run_id', db_run_id: capturedDbRunId });
      }
    }

    if (capturedRunId === null) {
      const detected = detectGatePause(line);
      if (detected) {
        capturedRunId = detected.run_id;
        onEvent({
          type: 'run_gate_paused',
          run_id: capturedRunId,
          gate_message: line.trim(),
          raw: line,
        });
      }
    }
  };

  // Stream both stderr and stdout line-by-line. Archon's pino logger writes
  // structured JSON (including the `workflowRunId` we need) to stdout, while
  // the human-readable progress lines go to stderr. We need both.
  void streamLines(proc.stderr, handleStderrLine);
  void streamLines(proc.stdout, handleStderrLine);

  void (async () => {
    try {
      const exitCode = await proc.exited;
      clearTimeout(turnTimer);

      if (cancelled) {
        onEvent({ type: 'run_cancelled' });
      } else if (timedOut) {
        // already emitted
      } else if (exitCode === 0) {
        onEvent({ type: 'run_succeeded' });
      } else {
        onEvent({ type: 'run_failed', exit_code: exitCode ?? -1 });
      }
    } finally {
      resolveDone();
    }
  })();

  return {
    pid: proc.pid ?? null,
    cancel: (reason?: string) => {
      if (cancelled) return;
      cancelled = true;
      logger.info('Cancelling Archon run', { pid: proc.pid, reason });
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
    done,
  };
}

/**
 * Approve a paused Archon gate and immediately resume the workflow.
 *
 * Calls `archon workflow approve <runId> [comment]` which (1) stores the
 * approval with the comment as $<gate-id>.output for downstream nodes, then
 * (2) auto-resumes via workflowRunCommand(..., { resume: true }).
 *
 * This is the correct path for supervised gates — the raw HTTP approveRun API
 * only stores the approval without resuming, losing the human comment.
 */
export function approveAndResumeArchon(
  archonCommand: string,
  runId: string,
  comment: string | undefined,
  turnTimeoutMs: number,
  onEvent: (e: ArchonEvent) => void,
): RunHandle {
  const argv = buildArchonApproveArgv(archonCommand, runId, comment);

  const proc = Bun.spawn(argv, {
    env: process.env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  if (proc.pid) {
    onEvent({ type: 'archon_started', pid: proc.pid });
  }

  let capturedDbRunId: string | null = null;
  let capturedRunId: string | null = null;
  let cancelled = false;
  let timedOut = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((res) => { resolveDone = res; });

  const turnTimer = setTimeout(() => {
    if (proc.exitCode === undefined) {
      timedOut = true;
      logger.warn('Archon approve+resume turn timeout — killing', { pid: proc.pid, runId });
      onEvent({ type: 'run_timed_out' });
      try { proc.kill(); } catch { /* ignore */ }
    }
  }, turnTimeoutMs);

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    onEvent({ type: 'archon_output', line });
    if (capturedDbRunId === null) {
      const m = line.match(WORKFLOW_RUN_ID_REGEX);
      if (m?.[1]) {
        capturedDbRunId = m[1];
        onEvent({ type: 'run_id', db_run_id: capturedDbRunId });
      }
    }
    if (capturedRunId === null) {
      const detected = detectGatePause(line);
      if (detected) {
        capturedRunId = detected.run_id;
        onEvent({ type: 'run_gate_paused', run_id: capturedRunId, gate_message: line.trim(), raw: line });
      }
    }
  };

  void streamLines(proc.stderr, handleLine);
  void streamLines(proc.stdout, handleLine);

  void (async () => {
    try {
      const exitCode = await proc.exited;
      clearTimeout(turnTimer);
      if (cancelled) {
        onEvent({ type: 'run_cancelled' });
      } else if (!timedOut) {
        if (exitCode === 0) onEvent({ type: 'run_succeeded' });
        else onEvent({ type: 'run_failed', exit_code: exitCode ?? -1 });
      }
    } finally {
      resolveDone();
    }
  })();

  return {
    pid: proc.pid ?? null,
    cancel: (reason?: string) => {
      if (cancelled) return;
      cancelled = true;
      logger.info('Cancelling Archon approve+resume', { pid: proc.pid, runId, reason });
      try { proc.kill(); } catch { /* ignore */ }
    },
    done,
  };
}

/** Parse the archon command string into argv with workflow + flags + message. */
function parseArchonCommand(commandStr: string, workflow: string, cwd: string, message: string): string[] {
  return buildArchonRunArgv(commandStr, workflow, cwd, message);
}

async function streamLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        if (buf.length > 0) onLine(buf);
        return;
      }
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    }
  } catch {
    /* ignore */
  }
}

// ─── re-exports for callers that imported from here ───────────────────────────
// ArchonRunRecord and findArchonRunForRepo live in archon-client.ts now.
// These re-exports keep existing imports from breaking during migration.
export type { ArchonRunRecord } from './archon-client.ts';
export { findArchonRunForRepo } from './archon-client.ts';
