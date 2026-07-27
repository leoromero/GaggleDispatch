/**
 * Locating a POSIX shell.
 *
 * Workflow `bash:` nodes are written as POSIX scripts, and GaggleDispatch runs
 * on Windows. Rather than translate shell dialects — a losing game once
 * workflows use pipelines, heredocs and `set -euo pipefail` — we require Git
 * Bash and resolve it explicitly. Resolution is deliberately eager and loud:
 * `gaggle doctor` fails at startup instead of a workflow dying at node 12.
 */

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Standard Git for Windows install locations, in preference order. */
const WINDOWS_FALLBACKS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
];

const POSIX_FALLBACKS = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];

/** Scan PATH for an executable, honouring PATHEXT-style suffixes on Windows. */
export function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathValue = env.PATH ?? env.Path ?? '';
  if (!pathValue) return null;
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, command + suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Absolute path to a bash executable, or null when none is installed.
 *
 * `GAGGLE_BASH` wins when set — the escape hatch for a non-standard install
 * (WSL, MSYS2, Cygwin, Nix) without needing a code change.
 */
export function resolveBashPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const override = env.GAGGLE_BASH?.trim();
  if (override) return existsSync(override) ? override : null;

  const onPath = findOnPath('bash', env, platform);
  if (onPath) return onPath;

  const fallbacks = platform === 'win32' ? WINDOWS_FALLBACKS : POSIX_FALLBACKS;
  return fallbacks.find((p) => existsSync(p)) ?? null;
}

export class BashNotFoundError extends Error {
  constructor() {
    super(
      process.platform === 'win32'
        ? 'bash was not found. Workflow `bash:` and `script:` nodes need a POSIX shell — ' +
            'install Git for Windows, or point GAGGLE_BASH at a bash executable. ' +
            'Run `gaggle doctor` to verify.'
        : 'bash was not found on PATH. Set GAGGLE_BASH, or install bash. ' +
            'Run `gaggle doctor` to verify.',
    );
    this.name = 'BashNotFoundError';
  }
}

/** Same as `resolveBashPath`, but throws the actionable error instead of returning null. */
export function requireBash(): string {
  const bash = resolveBashPath();
  if (!bash) throw new BashNotFoundError();
  return bash;
}
