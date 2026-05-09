/**
 * Small subprocess helpers wrapping Bun.spawn.
 */

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  input?: string;
}

/** Run a one-shot subprocess and capture stdout/stderr. */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    stdin: opts.input ? new TextEncoder().encode(opts.input) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs);
  }

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) {
      return { exitCode: 124, stdout, stderr: stderr + '\n[gaggle] subprocess timeout' };
    }
    return { exitCode: exitCode ?? -1, stdout, stderr };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Throw if exit code is non-zero. */
export async function runOrThrow(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  const result = await run(cmd, opts);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${cmd.join(' ')}\nSTDERR: ${result.stderr.slice(0, 2000)}`,
    );
  }
  return result;
}

/** Check whether a command exists in PATH. */
export async function commandExists(cmd: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? ['where', cmd] : ['which', cmd];
  const result = await run(probe);
  return result.exitCode === 0;
}
