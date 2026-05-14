import { mkdirSync, renameSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Atomic file write — write to `<path>.tmp.<pid>` and rename. */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function joinExisting(...parts: string[]): string {
  return join(...parts);
}
