/**
 * Hub process manager.
 *
 * Spawns one `gaggle start --api-port 0` child per workspace, watches its
 * health, restarts on crash (with backoff), and exposes a polling client
 * that fans state/log requests out to every child via their HTTP API.
 */

import { spawn, type Subprocess } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HubWorkspaceEntry } from './config.ts';
import { isPidAlive, readSidecar, removeSidecar } from './sidecar.ts';
import { logger } from '../util/logger.ts';

export interface ManagedWorkspace {
  entry: HubWorkspaceEntry;
  process: Subprocess | null;
  api_url: string | null;
  api_port: number | null;
  pid: number | null;
  started_at: string | null;
  last_exit_code: number | null;
  last_exit_at: string | null;
  restart_count: number;
  status: 'starting' | 'running' | 'crashed' | 'stopped';
  /** True when the workspace was explicitly stopped via stopWorkspace(); suppresses auto-restart. */
  manualStopped: boolean;
}

export interface SpawnOptions {
  /** Path to the gaggle CLI entry (absolute). Defaults to the running script. */
  cliEntry: string;
  /** Inherit stdio from parent (default: pipe so we can prefix lines). */
  inheritStdio?: boolean;
}

export class HubProcessManager {
  private workspaces = new Map<string, ManagedWorkspace>();
  private stopped = false;
  private cliEntry: string;
  private inheritStdio: boolean;

  constructor(opts: SpawnOptions) {
    this.cliEntry = opts.cliEntry;
    this.inheritStdio = opts.inheritStdio ?? false;
  }

  list(): ManagedWorkspace[] {
    return Array.from(this.workspaces.values());
  }

  get(name: string): ManagedWorkspace | undefined {
    return this.workspaces.get(name);
  }

  async startWorkspace(entry: HubWorkspaceEntry): Promise<void> {
    if (this.stopped) return;
    if (this.workspaces.has(entry.name)) {
      const existing = this.workspaces.get(entry.name)!;
      if (existing.status === 'running' || existing.status === 'starting') return;
      // Allow re-start of a manually stopped workspace.
      existing.manualStopped = false;
    }

    // Detect already-running gaggle (sidecar present + pid alive).
    const sidecar = readSidecar(entry.path);
    if (sidecar && isPidAlive(sidecar.pid)) {
      logger.info('Adopting already-running gaggle', {
        workspace: entry.name,
        pid: sidecar.pid,
        api_url: sidecar.api_url,
      });
      this.workspaces.set(entry.name, {
        entry,
        process: null,
        api_url: sidecar.api_url,
        api_port: sidecar.api_port,
        pid: sidecar.pid,
        started_at: sidecar.started_at,
        last_exit_code: null,
        last_exit_at: null,
        restart_count: 0,
        status: 'running',
      });
      return;
    }
    if (sidecar) {
      // Stale sidecar — clean it.
      removeSidecar(entry.path);
    }

    const managed: ManagedWorkspace = {
      entry,
      process: null,
      api_url: null,
      api_port: null,
      pid: null,
      started_at: null,
      last_exit_code: null,
      last_exit_at: null,
      restart_count: 0,
      status: 'starting',
      manualStopped: false,
    };
    this.workspaces.set(entry.name, managed);

    const args = [
      this.cliEntry,
      '--cwd',
      entry.path,
      'start',
      '--api-port',
      '0',
      '--workspace-name',
      entry.name,
    ];

    logger.info('Spawning gaggle workspace', { workspace: entry.name, path: entry.path });

    const child = spawn({
      cmd: ['bun', 'run', ...args],
      stdout: this.inheritStdio ? 'inherit' : 'pipe',
      stderr: this.inheritStdio ? 'inherit' : 'pipe',
      stdin: 'ignore',
      env: { ...process.env },
    });

    managed.process = child;
    managed.pid = child.pid ?? null;
    managed.started_at = new Date().toISOString();

    if (!this.inheritStdio) {
      this.pipePrefixed(child.stdout as ReadableStream<Uint8Array>, entry.name, 'out');
      this.pipePrefixed(child.stderr as ReadableStream<Uint8Array>, entry.name, 'err');
    }

    // Wait briefly for the sidecar to appear so we can pick up the API port.
    void this.awaitSidecar(entry, managed);

    // Watch for exit.
    void child.exited.then((code) => {
      managed.last_exit_code = code ?? null;
      managed.last_exit_at = new Date().toISOString();
      const intentional = this.stopped || managed.manualStopped;
      managed.status = intentional ? 'stopped' : 'crashed';
      removeSidecar(entry.path);
      if (!intentional) {
        managed.restart_count += 1;
        const backoff = Math.min(30_000, 1000 * Math.pow(2, managed.restart_count));
        logger.warn('Gaggle workspace exited; restarting', {
          workspace: entry.name,
          exit_code: code ?? -1,
          restart_in_ms: backoff,
        });
        setTimeout(() => {
          if (this.stopped || managed.manualStopped) return;
          void this.startWorkspace(entry);
        }, backoff);
      }
    });
  }

  private async awaitSidecar(entry: HubWorkspaceEntry, managed: ManagedWorkspace): Promise<void> {
    const deadline = Date.now() + 30_000;
    // We cleared any stale sidecar before spawning, so any sidecar that appears
    // now belongs to our child (possibly under a `bun run` wrapper process,
    // whose pid differs from the orchestrator's pid).
    while (Date.now() < deadline && !this.stopped) {
      const sc = readSidecar(entry.path);
      if (sc && isPidAlive(sc.pid)) {
        managed.api_url = sc.api_url;
        managed.api_port = sc.api_port;
        managed.pid = sc.pid;
        managed.status = 'running';
        logger.info('Gaggle workspace ready', {
          workspace: entry.name,
          api_url: sc.api_url,
          pid: sc.pid,
        });
        return;
      }
      await Bun.sleep(250);
    }
    if (managed.status === 'starting') {
      logger.warn('Gaggle workspace did not write sidecar within 30s', { workspace: entry.name });
    }
  }

  private pipePrefixed(stream: ReadableStream<Uint8Array> | null, name: string, kind: 'out' | 'err'): void {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const out = kind === 'err' ? process.stderr : process.stdout;
    const prefix = `[${name}] `;
    let pending = '';
    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) {
            out.write(`${prefix}${line}\n`);
          }
        }
        if (pending) out.write(`${prefix}${pending}\n`);
      } catch {
        /* ignore */
      }
    })();
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    const tasks: Promise<unknown>[] = [];
    for (const w of this.workspaces.values()) {
      if (w.process && w.pid) {
        try {
          w.process.kill('SIGTERM');
          tasks.push(
            Promise.race([w.process.exited, Bun.sleep(8000)]).then(() => {
              try {
                w.process?.kill('SIGKILL');
              } catch {
                /* ignore */
              }
            }),
          );
        } catch {
          /* ignore */
        }
      }
      w.status = 'stopped';
    }
    await Promise.all(tasks);
  }

  /** Stop a single workspace without affecting others or preventing future restarts via startWorkspace(). */
  async stopWorkspace(name: string): Promise<void> {
    const w = this.workspaces.get(name);
    if (!w || w.status === 'stopped') return;
    w.manualStopped = true;
    w.status = 'stopped';
    if (w.process) {
      try {
        w.process.kill('SIGTERM');
        await Promise.race([w.process.exited, Bun.sleep(8000)]);
        try { w.process.kill('SIGKILL'); } catch { /* ignore */ }
      } catch {
        /* ignore */
      }
    } else if (w.pid) {
      // Adopted workspace — signal by PID.
      try { process.kill(w.pid, 'SIGTERM'); } catch { /* ignore */ }
    }
    w.api_url = null;
    w.api_port = null;
  }

  /** Stop all workspaces without shutting down the nest (gaggles can be restarted individually). */
  async stopAllWorkspaces(): Promise<void> {
    await Promise.all(Array.from(this.workspaces.keys()).map((n) => this.stopWorkspace(n)));
  }

  /** Fetch the live state snapshot from one workspace. */
  async fetchState(name: string): Promise<unknown | null> {
    const w = this.workspaces.get(name);
    if (!w || !w.api_url) return null;
    try {
      const res = await fetch(`${w.api_url}/api/state`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Fetch all known workspace states in parallel. */
  async fetchAllStates(): Promise<Record<string, unknown | null>> {
    const out: Record<string, unknown | null> = {};
    await Promise.all(
      Array.from(this.workspaces.keys()).map(async (name) => {
        out[name] = await this.fetchState(name);
      }),
    );
    return out;
  }

  /** Subscribe to the WS stream for one workspace, forwarding events to a handler. */
  attachStream(name: string, onEvent: (workspaceName: string, ev: unknown) => void): () => void {
    const w = this.workspaces.get(name);
    if (!w || !w.api_url) return () => undefined;
    const wsUrl = w.api_url.replace(/^http/, 'ws') + '/api/stream';
    let closed = false;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl);
        ws.onmessage = (e) => {
          try {
            const ev = JSON.parse(String(e.data));
            onEvent(name, ev);
          } catch {
            /* ignore */
          }
        };
        ws.onclose = () => {
          if (!closed) setTimeout(connect, 2000);
        };
        ws.onerror = () => {
          try {
            ws?.close();
          } catch {
            /* ignore */
          }
        };
      } catch {
        if (!closed) setTimeout(connect, 2000);
      }
    };
    connect();

    return () => {
      closed = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }
}

/** Best-effort resolution of the bundled CLI entry script. */
export function resolveCliEntry(): string {
  // process.argv[1] is the script Bun started with; for the hub command it
  // is the gaggle CLI entry.
  return process.argv[1] ?? join(process.cwd(), 'src', 'cli', 'index.ts');
}

/** Tiny helper: read a file if it exists. */
export function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
