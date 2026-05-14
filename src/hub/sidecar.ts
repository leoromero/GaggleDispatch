/**
 * Hub sidecar file written by each `gaggle start` process so the hub can
 * discover and reach the per-gaggle HTTP API.
 *
 * Path: <project_dir>/.gaggle/hub.json
 *
 * Written on start, removed on graceful shutdown. The hub treats a stale
 * file (pid not alive) as a crashed gaggle.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface HubSidecar {
  pid: number;
  api_port: number;
  api_url: string;
  workspace_name?: string;
  workflow_md_path: string;
  started_at: string;
}

export function sidecarPath(projectDir: string): string {
  return join(projectDir, '.gaggle', 'hub.json');
}

export function writeSidecar(projectDir: string, payload: HubSidecar): void {
  const path = sidecarPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
}

export function readSidecar(projectDir: string): HubSidecar | null {
  const path = sidecarPath(projectDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as HubSidecar;
  } catch {
    return null;
  }
}

export function removeSidecar(projectDir: string): void {
  const path = sidecarPath(projectDir);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process. EPERM = process exists but we can't signal it.
    const err = e as NodeJS.ErrnoException;
    return err.code === 'EPERM';
  }
}
