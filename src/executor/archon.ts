/**
 * Archon Workflow Executor (Section 11).
 *
 * Spawns `archon workflow run <workflow> --cwd <checkout> "<message>"`.
 * Streams stderr; emits typed events; detects gate-pause and stall.
 */

import { logger } from '../util/logger.ts';

export type ArchonEvent =
  | { type: 'archon_started'; pid: number }
  | { type: 'archon_output'; line: string }
  | { type: 'archon_gate_paused'; run_id: string; gate_message: string; raw: string }
  | { type: 'archon_succeeded' }
  | { type: 'archon_failed'; exit_code: number }
  | { type: 'archon_timed_out' }
  | { type: 'archon_stalled' }
  | { type: 'archon_cancelled' };

export interface ExecutorOptions {
  archonCommand: string; // e.g. "archon workflow run"
  workflowName: string;
  cwd: string;
  message: string;
  env?: Record<string, string | undefined>;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
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
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  let timedOut = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });

  const armStallTimer = () => {
    if (opts.stallTimeoutMs <= 0) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      logger.warn('Archon run stalled — killing', { pid: proc.pid });
      onEvent({ type: 'archon_stalled' });
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, opts.stallTimeoutMs);
  };

  armStallTimer();

  const turnTimer = setTimeout(() => {
    if (proc.exitCode === undefined) {
      timedOut = true;
      logger.warn('Archon turn timeout — killing', { pid: proc.pid });
      onEvent({ type: 'archon_timed_out' });
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }
  }, opts.turnTimeoutMs);

  const handleStderrLine = (line: string) => {
    if (!line.trim()) return;
    onEvent({ type: 'archon_output', line });
    armStallTimer();

    if (capturedRunId === null) {
      const detected = detectGatePause(line);
      if (detected) {
        capturedRunId = detected.run_id;
        onEvent({
          type: 'archon_gate_paused',
          run_id: capturedRunId,
          gate_message: line.trim(),
          raw: line,
        });
      }
    }
  };

  // Stream stderr line-by-line.
  void streamLines(proc.stderr, handleStderrLine);
  // Also drain stdout so the pipe doesn't fill (but we don't parse it).
  void drain(proc.stdout);

  void (async () => {
    try {
      const exitCode = await proc.exited;
      if (stallTimer) clearTimeout(stallTimer);
      clearTimeout(turnTimer);

      if (cancelled) {
        onEvent({ type: 'archon_cancelled' });
      } else if (timedOut) {
        // already emitted
      } else if (exitCode === 0) {
        onEvent({ type: 'archon_succeeded' });
      } else {
        onEvent({ type: 'archon_failed', exit_code: exitCode ?? -1 });
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

/** Parse the archon command string into argv with workflow + flags + message. */
function parseArchonCommand(commandStr: string, workflow: string, cwd: string, message: string): string[] {
  return buildArchonRunArgv(commandStr, workflow, cwd, message);
}

const tokenize = tokenizeArchonCommand;

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

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  } catch {
    /* ignore */
  }
}

/** Call `archon workflow approve <run-id> --comment "<text>"`. */
export async function archonApprove(commandStr: string, runId: string, comment: string): Promise<void> {
  const baseTokens = tokenize(commandStr);
  // commandStr is "archon workflow run" — replace last token with "approve"
  const argv = [...baseTokens.slice(0, -1), 'approve', runId, '--comment', comment];
  const proc = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) {
    logger.warn('archon approve exited non-zero', { run_id: runId, exit_code: code });
  }
}

/** Call `archon workflow reject <run-id> --reason "<text>"`. */
export async function archonReject(commandStr: string, runId: string, reason: string): Promise<void> {
  const baseTokens = tokenize(commandStr);
  const argv = [...baseTokens.slice(0, -1), 'reject', runId, '--reason', reason];
  const proc = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) {
    logger.warn('archon reject exited non-zero', { run_id: runId, exit_code: code });
  }
}

/** Call `archon workflow abandon <run-id>`. */
export async function archonAbandon(commandStr: string, runId: string): Promise<void> {
  const baseTokens = tokenize(commandStr);
  const argv = [...baseTokens.slice(0, -1), 'abandon', runId];
  const proc = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit' });
  await proc.exited;
}
