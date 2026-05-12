/**
 * Archon supervisor.
 *
 * Detects whether Archon's web UI (`archon serve`) is already running on
 * the configured `ui_url`. If not and `autostart` is true, spawns it as
 * a managed child process. The hub only owns the process when it spawned
 * it — an adopted Archon is left alone on shutdown.
 *
 * Health probe: GET <ui_url>/health expects {status:'ok'}.
 */

import { spawn, type Subprocess } from 'bun';
import type { HubArchonConfig } from './config.ts';
import { logger } from '../util/logger.ts';

export type ArchonStatus = 'running' | 'starting' | 'unavailable' | 'disabled' | 'crashed';

export interface ArchonState {
  status: ArchonStatus;
  ui_url: string;
  run_path: string;
  spawned_by_hub: boolean;
  pid: number | null;
  last_health_check: string | null;
  last_error: string | null;
}

const PROBE_TIMEOUT_MS = 1500;

async function probeHealth(uiUrl: string): Promise<boolean> {
  const url = `${uiUrl.replace(/\/$/, '')}/health`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

export class ArchonSupervisor {
  private cfg: HubArchonConfig;
  private process: Subprocess | null = null;
  private state: ArchonState;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(cfg: HubArchonConfig) {
    this.cfg = cfg;
    this.state = {
      status: cfg.autostart ? 'unavailable' : 'disabled',
      ui_url: cfg.ui_url,
      run_path: cfg.run_path,
      spawned_by_hub: false,
      pid: null,
      last_health_check: null,
      last_error: null,
    };
  }

  getState(): ArchonState {
    return { ...this.state };
  }

  buildRunUrl(runId: string | null | undefined): string | null {
    if (!runId) return null;
    const base = this.cfg.ui_url.replace(/\/$/, '');
    const path = this.cfg.run_path.replace('{run_id}', encodeURIComponent(runId));
    return `${base}${path}`;
  }

  async start(): Promise<void> {
    // Always probe first. If Archon is already running, adopt it regardless
    // of autostart — we still want to surface its URL for deep links.
    const alive = await probeHealth(this.cfg.ui_url);
    if (alive) {
      logger.info('Adopting already-running Archon', { ui_url: this.cfg.ui_url });
      this.state.status = 'running';
      this.state.spawned_by_hub = false;
      this.state.last_health_check = new Date().toISOString();
      this.startHealthLoop();
      return;
    }

    if (!this.cfg.autostart) {
      logger.info('Archon not detected and autostart disabled', { ui_url: this.cfg.ui_url });
      this.state.status = 'disabled';
      this.startHealthLoop();
      return;
    }

    this.spawnArchon();
    this.startHealthLoop();
  }

  private spawnArchon(): void {
    if (this.stopped) return;
    const parts = this.cfg.serve_command.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      this.state.status = 'unavailable';
      this.state.last_error = 'archon.serve_command is empty';
      logger.warn('Cannot spawn Archon: serve_command is empty');
      return;
    }

    logger.info('Spawning archon serve', { cmd: this.cfg.serve_command });
    this.state.status = 'starting';
    this.state.spawned_by_hub = true;

    const child = spawn({
      cmd: parts,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { ...process.env, ARCHON_SUPPRESS_NESTED_CLAUDE_WARNING: '1', ...(this.cfg.archon_home ? { ARCHON_HOME: this.cfg.archon_home } : {}) },
    });
    this.process = child;
    this.state.pid = child.pid ?? null;

    this.pipePrefixed(child.stdout as ReadableStream<Uint8Array>, 'out');
    this.pipePrefixed(child.stderr as ReadableStream<Uint8Array>, 'err');

    void child.exited.then((code) => {
      this.state.status = this.stopped ? 'disabled' : 'crashed';
      this.state.last_error = `archon serve exited with code ${code ?? -1}`;
      this.process = null;
      this.state.pid = null;
      if (!this.stopped) {
        logger.warn('Archon serve exited; will retry on next health probe', {
          exit_code: code ?? -1,
        });
      }
    });
  }

  private pipePrefixed(stream: ReadableStream<Uint8Array> | null, kind: 'out' | 'err'): void {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const out = kind === 'err' ? process.stderr : process.stdout;
    let pending = '';
    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) out.write(`[archon] ${line}\n`);
        }
        if (pending) out.write(`[archon] ${pending}\n`);
      } catch {
        /* ignore */
      }
    })();
  }

  private startHealthLoop(): void {
    if (this.healthTimer) return;
    const tick = async () => {
      if (this.stopped) return;
      const alive = await probeHealth(this.cfg.ui_url);
      this.state.last_health_check = new Date().toISOString();
      if (alive) {
        if (this.state.status !== 'running') {
          logger.info('Archon reachable', { ui_url: this.cfg.ui_url });
        }
        this.state.status = 'running';
        this.state.last_error = null;
      } else if (this.state.status === 'running') {
        this.state.status = 'unavailable';
        this.state.last_error = 'health probe failed';
      } else if (
        this.cfg.autostart &&
        this.state.spawned_by_hub &&
        this.state.status === 'crashed'
      ) {
        // We started it; it crashed; try again.
        this.spawnArchon();
      }
    };
    this.healthTimer = setInterval(() => void tick(), 5000);
    // Kick off the first probe immediately.
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    if (this.process && this.state.spawned_by_hub) {
      try {
        this.process.kill('SIGTERM');
        await Promise.race([this.process.exited, Bun.sleep(5000)]);
        try {
          this.process.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      } catch {
        /* ignore */
      }
    }
    this.process = null;
  }
}
