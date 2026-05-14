/**
 * Advisory file locking (Section 21.10).
 *
 * Lock file: `<base_folder>/.gaggle.lock`
 * Body: `{pid, command, started_at}` JSON.
 * Acquisition timeout: 10 seconds.
 *
 * Uses `proper-lockfile` (cross-platform advisory lock).
 */

import { lock as plock, unlock as punlock } from 'proper-lockfile';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LockTimeout } from '../domain/errors.ts';

const ACQUISITION_TIMEOUT_MS = 10_000;
const STALE_MS = 30_000;

export interface LockHolderInfo {
  pid: number;
  command: string;
  started_at: string;
}

function readHolder(lockBodyPath: string): LockHolderInfo | null {
  try {
    if (!existsSync(lockBodyPath)) return null;
    return JSON.parse(readFileSync(lockBodyPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeHolder(lockBodyPath: string, command: string): void {
  mkdirSync(dirname(lockBodyPath), { recursive: true });
  const info: LockHolderInfo = {
    pid: process.pid,
    command,
    started_at: new Date().toISOString(),
  };
  writeFileSync(lockBodyPath, JSON.stringify(info), 'utf8');
}

/**
 * Acquire the advisory lock around `lockTargetPath` (the file or directory being protected).
 * Returns a release function. On timeout throws `LockTimeout` with holder info.
 *
 * `command` should be the human-readable command name e.g. "gaggle repo add".
 */
export async function withLock<T>(
  lockTargetPath: string,
  command: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const lockTarget = lockTargetPath;
  // proper-lockfile requires the target to exist; for file-based locks ensure parent dir + file
  mkdirSync(dirname(lockTarget), { recursive: true });
  if (!existsSync(lockTarget)) {
    writeFileSync(lockTarget, '', { flag: 'a' });
  }

  const lockBodyPath = `${lockTarget}.holder.json`;
  const startedAt = Date.now();
  let release: (() => Promise<void>) | null = null;
  let lastErr: unknown = null;

  while (Date.now() - startedAt < ACQUISITION_TIMEOUT_MS) {
    try {
      release = await plock(lockTarget, {
        retries: 0,
        stale: STALE_MS,
        realpath: false,
      });
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (!release) {
    const holder = readHolder(lockBodyPath);
    const holderText = holder
      ? `'${holder.command}' (pid ${holder.pid}) since ${holder.started_at}`
      : undefined;
    throw new LockTimeout(lockTarget, holderText);
  }

  writeHolder(lockBodyPath, command);
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      try {
        await punlock(lockTarget, { realpath: false });
      } catch {
        /* ignore */
      }
    }
  }
}
