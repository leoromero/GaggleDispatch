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

export interface HubConfig {
  workspaces: HubWorkspaceEntry[];
  ui: HubUiConfig;
  /** Optional override for the history DB location. */
  history_db?: string;
}

const DEFAULT_CONFIG: HubConfig = {
  workspaces: [],
  ui: { port: 4242, host: '127.0.0.1' },
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
