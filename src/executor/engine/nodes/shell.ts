/**
 * `bash:` and `script:` node execution.
 *
 * Contract, matching what the shipped workflows already assume:
 *   - stdout becomes the node's output, with one trailing newline trimmed
 *   - stderr is streamed as warnings but does not fail the node
 *   - a non-zero exit fails the node
 *   - `timeout` bounds total wall-clock, not idle time
 */

import { spawn, type Subprocess } from 'bun';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { isInlineScript } from '../loader.ts';
import { requireBash } from '../shell.ts';
import type { ScriptRuntime } from '../schema.ts';

export interface ShellOutcome {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  /** Set when the run was aborted by the caller rather than by the timeout. */
  cancelled: boolean;
}

export type LineSink = (line: string, stream: 'stdout' | 'stderr') => void;

export interface RunProcessOptions {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  onLine?: LineSink;
  signal?: AbortSignal;
}

async function pump(
  stream: ReadableStream<Uint8Array> | null,
  which: 'stdout' | 'stderr',
  onLine: LineSink | undefined,
  collect: (chunk: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      collect(text);
      pending += text;
      let idx: number;
      while ((idx = pending.indexOf('\n')) !== -1) {
        onLine?.(pending.slice(0, idx).replace(/\r$/, ''), which);
        pending = pending.slice(idx + 1);
      }
    }
    if (pending) onLine?.(pending, which);
  } catch {
    // A stream torn down by a kill is expected; whatever was collected stands.
  }
}

/**
 * Kill a process and everything it spawned.
 *
 * Killing only the direct child is not enough: `bash -c 'sleep 30'` leaves the
 * sleep running, which both defeats the timeout and holds the stdout pipe open
 * so the caller never observes the exit. A node that ignores its timeout is
 * worse than one that fails.
 */
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(pid)], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      return;
    }
    // Depth-first over the process table so grandchildren go too.
    const res = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid='], { stdout: 'pipe', stderr: 'ignore' });
    const children = new Map<number, number[]>();
    for (const line of new TextDecoder().decode(res.stdout ?? new Uint8Array()).split('\n')) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (!child || !parent) continue;
      children.set(parent, [...(children.get(parent) ?? []), child]);
    }
    const doomed: number[] = [];
    const walk = (p: number) => {
      for (const c of children.get(p) ?? []) {
        doomed.push(c);
        walk(c);
      }
    };
    walk(pid);
    // Leaves first, so a parent cannot respawn a child mid-teardown.
    for (const p of doomed.reverse()) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    process.kill(pid, 'SIGKILL');
  } catch {
    /* best effort */
  }
}

/** How long to keep draining output after the process has exited. */
const DRAIN_GRACE_MS = 2_000;

/** Spawn a process, stream its output, and enforce a wall-clock limit. */
export async function runProcess(opts: RunProcessOptions): Promise<ShellOutcome> {
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let cancelled = false;

  const proc: Subprocess = spawn(opts.argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: 'pipe',
    stderr: 'pipe',
    // Nothing to type at: an interactive prompt would hang the run forever.
    stdin: 'ignore',
  });

  const kill = () => {
    if (proc.pid) killTree(proc.pid);
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs);

  const onAbort = () => {
    cancelled = true;
    kill();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const pumps = Promise.all([
    pump(proc.stdout as ReadableStream<Uint8Array>, 'stdout', opts.onLine, (c) => (stdout += c)),
    pump(proc.stderr as ReadableStream<Uint8Array>, 'stderr', opts.onLine, (c) => (stderr += c)),
  ]);

  try {
    // Exit drives completion, not the pumps. An orphaned grandchild can hold a
    // pipe open indefinitely; waiting on that first would hang the node.
    const exitCode = await proc.exited;
    await Promise.race([pumps, Bun.sleep(DRAIN_GRACE_MS)]);
    return {
      stdout: stdout.replace(/\r?\n$/, ''),
      stderr,
      exit_code: exitCode ?? -1,
      timed_out: timedOut,
      cancelled,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export interface BashNodeOptions {
  script: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  onLine?: LineSink;
  signal?: AbortSignal;
  /** Override the resolved bash. Tests use this; production resolves once. */
  bashPath?: string;
}

export async function runBash(opts: BashNodeOptions): Promise<ShellOutcome> {
  const bash = opts.bashPath ?? requireBash();
  return runProcess({
    argv: [bash, '-c', opts.script],
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    onLine: opts.onLine,
    signal: opts.signal,
  });
}

export class ScriptResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptResolutionError';
  }
}

const RUNTIME_EXTENSIONS: Record<ScriptRuntime, string[]> = {
  bun: ['.ts', '.js'],
  uv: ['.py'],
};

/**
 * Locate a named script under `.gaggle/scripts/`, checkout-first then user-level.
 *
 * The file extension has to agree with the declared runtime — a `.py` file run
 * through bun fails in a way that is hard to read from the node's stderr.
 */
export function resolveNamedScript(
  name: string,
  runtime: ScriptRuntime,
  searchDirs: string[],
): string {
  const wanted = RUNTIME_EXTENSIONS[runtime];
  const tried: string[] = [];
  for (const dir of searchDirs) {
    for (const ext of wanted) {
      const candidate = join(dir, `${name}${ext}`);
      tried.push(candidate);
      if (existsSync(candidate)) return candidate;
    }
    // A file that exists with the wrong extension is a mismatch worth naming.
    for (const [rt, exts] of Object.entries(RUNTIME_EXTENSIONS)) {
      if (rt === runtime) continue;
      for (const ext of exts) {
        if (existsSync(join(dir, `${name}${ext}`))) {
          throw new ScriptResolutionError(
            `script '${name}' resolves to ${join(dir, `${name}${ext}`)}, whose extension implies ` +
              `runtime '${rt}', but the node declares runtime '${runtime}'`,
          );
        }
      }
    }
  }
  throw new ScriptResolutionError(
    `named script '${name}' not found for runtime '${runtime}'. Looked for: ${tried.join(', ')}`,
  );
}

export interface ScriptNodeOptions {
  script: string;
  runtime: ScriptRuntime;
  deps?: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Directories searched for named scripts, in precedence order. */
  scriptDirs: string[];
  onLine?: LineSink;
  signal?: AbortSignal;
}

/** Build the argv for a script node. Pure, so dispatch is unit-testable. */
export function buildScriptArgv(opts: {
  script: string;
  runtime: ScriptRuntime;
  deps?: string[];
  scriptDirs: string[];
}): string[] {
  const inline = isInlineScript(opts.script);

  if (opts.runtime === 'bun') {
    // --no-env-file keeps the target repo's .env out of the subprocess.
    return inline
      ? ['bun', '--no-env-file', '-e', opts.script]
      : ['bun', '--no-env-file', 'run', resolveNamedScript(opts.script, 'bun', opts.scriptDirs)];
  }

  const withDeps = (opts.deps ?? []).flatMap((d) => ['--with', d]);
  return inline
    ? ['uv', 'run', ...withDeps, 'python', '-c', opts.script]
    : ['uv', 'run', ...withDeps, resolveNamedScript(opts.script, 'uv', opts.scriptDirs)];
}

export async function runScript(opts: ScriptNodeOptions): Promise<ShellOutcome> {
  const argv = buildScriptArgv(opts);
  return runProcess({
    argv,
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    onLine: opts.onLine,
    signal: opts.signal,
  });
}

/** Extension → runtime, for validating named script files. */
export function runtimeForExtension(path: string): ScriptRuntime | null {
  const ext = extname(path);
  if (ext === '.ts' || ext === '.js') return 'bun';
  if (ext === '.py') return 'uv';
  return null;
}
