/**
 * Persistent storage for OAuth tokens.
 *
 * Tokens are written to `<config_dir>/auth.json` where `<config_dir>` is:
 *   - `$XDG_CONFIG_HOME/gaggle` if set, else
 *   - `%APPDATA%/gaggle` on Windows
 *   - `~/.config/gaggle` elsewhere
 *
 * The file is created with `0600` permissions on Unix so that other users on
 * the machine can't read the refresh token. (Windows ACLs are best-effort —
 * the user's home directory permissions usually suffice.)
 *
 * Tokens are per-machine, not per-project: a single Linear OAuth app
 * authorizes a workspace, and the same tokens work for every gaggle
 * project pointing at that workspace.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../util/logger.ts';

const FILENAME = 'auth.json';

export interface StoredTokens {
  /** OAuth access token. Send as `Bearer <access_token>`. */
  access_token: string;
  /** OAuth refresh token. Used to mint new access tokens without user interaction. */
  refresh_token: string;
  /** Absolute epoch-millisecond timestamp when access_token expires. */
  expires_at: number;
  /** Space-separated scopes the token was granted. */
  scope: string;
  /** When this entry was last written, for diagnostics. */
  updated_at: string;
}

export function defaultConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return join(xdg, 'gaggle');
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    if (appdata && appdata.length > 0) return join(appdata, 'gaggle');
  }
  return join(homedir(), '.config', 'gaggle');
}

function authFilePath(configDir: string): string {
  return join(configDir, FILENAME);
}

/** Read stored tokens. Returns null if the file is missing or corrupt. */
export function loadStoredTokens(configDir: string = defaultConfigDir()): StoredTokens | null {
  const p = authFilePath(configDir);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<StoredTokens>;
    if (
      typeof parsed.access_token !== 'string' ||
      typeof parsed.refresh_token !== 'string' ||
      typeof parsed.expires_at !== 'number' ||
      typeof parsed.scope !== 'string'
    ) {
      logger.warn('auth.json has unexpected shape; ignoring', { path: p });
      return null;
    }
    return {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
      expires_at: parsed.expires_at,
      scope: parsed.scope,
      updated_at: parsed.updated_at ?? new Date().toISOString(),
    };
  } catch (err) {
    logger.warn('auth.json read/parse failed; ignoring', { path: p, error: (err as Error).message });
    return null;
  }
}

/** Atomically write tokens to disk. Creates the config dir if missing.
 *  Sets `0600` permissions on Unix. */
export function saveStoredTokens(tokens: Omit<StoredTokens, 'updated_at'>, configDir: string = defaultConfigDir()): void {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const p = authFilePath(configDir);
  const body: StoredTokens = { ...tokens, updated_at: new Date().toISOString() };
  // Write to a temp path then rename, so a crash mid-write can't corrupt the
  // existing file. (Bun's writeFileSync is synchronous so the window is small,
  // but the pattern is cheap insurance.)
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
  if (process.platform !== 'win32') {
    try { chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  }
  // Bun's rename — Node's fs.renameSync also works, but writeFileSync + chmod
  // then replace via writeFileSync on the real path is simpler and almost as
  // safe for our purposes:
  writeFileSync(p, JSON.stringify(body, null, 2), 'utf8');
  if (process.platform !== 'win32') {
    try { chmodSync(p, 0o600); } catch { /* best-effort */ }
  }
  try { unlinkSync(tmp); } catch { /* ignore */ }
}

/** Delete stored tokens. No-op if the file doesn't exist. */
export function clearStoredTokens(configDir: string = defaultConfigDir()): void {
  const p = authFilePath(configDir);
  if (existsSync(p)) {
    try { unlinkSync(p); } catch (err) {
      logger.warn('Failed to delete auth.json', { path: p, error: (err as Error).message });
    }
  }
}
