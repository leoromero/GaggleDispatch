/**
 * Hub config (~/.config/gaggle/hub.yaml).
 *
 * The hub config is user-global: it lists every gaggle workspace the user
 * wants the hub to manage, and the port the dashboard listens on. Workspaces
 * are added/removed explicitly via `gaggle hub add` / `gaggle hub remove`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import YAML from 'yaml';

export interface HubWorkspaceEntry {
  name: string;
  path: string;
  color?: string;
}

export interface HubUiConfig {
  port: number;
  host?: string;
}

export interface HubArchonConfig {
  /** Auto-launch `archon serve` if it isn't already running on `ui_url`. */
  autostart: boolean;
  /** Base URL where Archon's web UI serves. Default: http://localhost:3090. */
  ui_url: string;
  /**
   * Path template for a single workflow run page. `{run_id}` is replaced
   * with the LiveSession's `archon_db_run_id`.
   */
  run_path: string;
  /** Command used to launch Archon's web UI (only when autostart applies). */
  serve_command: string;
  /** Optional override for ARCHON_HOME env var passed to the Archon process. */
  archon_home?: string;
}

export interface HubConfig {
  workspaces: HubWorkspaceEntry[];
  ui: HubUiConfig;
  archon: HubArchonConfig;
  /** Optional override for the history DB location. */
  history_db?: string;
}

const DEFAULT_ARCHON: HubArchonConfig = {
  autostart: true,
  ui_url: 'http://localhost:3090',
  run_path: '/workflows/runs/{run_id}',
  serve_command: 'archon serve',
};

const DEFAULT_CONFIG: HubConfig = {
  workspaces: [],
  ui: { port: 4242, host: '127.0.0.1' },
  archon: { ...DEFAULT_ARCHON },
};

const DEFAULT_PALETTE = [
  '#4f9cf9',
  '#f97316',
  '#10b981',
  '#a855f7',
  '#ef4444',
  '#eab308',
  '#06b6d4',
  '#ec4899',
];

export function defaultHubConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return `${home}/.config/gaggle/hub.yaml`;
}

export function loadHubConfig(path = defaultHubConfigPath()): HubConfig {
  if (!existsSync(path)) {
    return structuredClone(DEFAULT_CONFIG);
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = YAML.parse(raw) as Partial<HubConfig> | null;
  if (!parsed || typeof parsed !== 'object') return structuredClone(DEFAULT_CONFIG);
  const workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
  const archonRaw = (parsed.archon ?? {}) as Partial<HubArchonConfig>;
  return {
    workspaces: workspaces.map((w) => ({
      name: String(w.name),
      path: String(w.path),
      color: w.color ? String(w.color) : undefined,
    })),
    ui: {
      port: parsed.ui?.port ?? DEFAULT_CONFIG.ui.port,
      host: parsed.ui?.host ?? DEFAULT_CONFIG.ui.host,
    },
    archon: {
      autostart: archonRaw.autostart ?? DEFAULT_ARCHON.autostart,
      ui_url: archonRaw.ui_url ?? DEFAULT_ARCHON.ui_url,
      run_path: archonRaw.run_path ?? DEFAULT_ARCHON.run_path,
      serve_command: archonRaw.serve_command ?? DEFAULT_ARCHON.serve_command,
      archon_home: (archonRaw as { archon_home?: string }).archon_home,
    },
    history_db: parsed.history_db ? String(parsed.history_db) : undefined,
  };
}

export function saveHubConfig(cfg: HubConfig, path = defaultHubConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const out = YAML.stringify(cfg, { lineWidth: 0 });
  writeFileSync(path, out, 'utf8');
}

export function ensureHubConfig(path = defaultHubConfigPath()): HubConfig {
  if (existsSync(path)) return loadHubConfig(path);
  const cfg = structuredClone(DEFAULT_CONFIG);
  saveHubConfig(cfg, path);
  return cfg;
}

export function pickColorForWorkspace(cfg: HubConfig): string {
  const taken = new Set(cfg.workspaces.map((w) => w.color).filter(Boolean) as string[]);
  for (const c of DEFAULT_PALETTE) if (!taken.has(c)) return c;
  return DEFAULT_PALETTE[cfg.workspaces.length % DEFAULT_PALETTE.length]!;
}

export function addWorkspace(
  cfg: HubConfig,
  entry: HubWorkspaceEntry,
): { cfg: HubConfig; added: boolean } {
  if (cfg.workspaces.some((w) => w.name === entry.name)) {
    return { cfg, added: false };
  }
  const color = entry.color ?? pickColorForWorkspace(cfg);
  const next: HubConfig = {
    ...cfg,
    workspaces: [...cfg.workspaces, { ...entry, color }],
  };
  return { cfg: next, added: true };
}

export function removeWorkspace(
  cfg: HubConfig,
  name: string,
): { cfg: HubConfig; removed: boolean } {
  const before = cfg.workspaces.length;
  const next: HubConfig = {
    ...cfg,
    workspaces: cfg.workspaces.filter((w) => w.name !== name),
  };
  return { cfg: next, removed: next.workspaces.length < before };
}
