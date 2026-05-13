/**
 * auth-store tests: read/write/clear round-trips, malformed file handling,
 * and (on Unix) the file-permission contract.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadStoredTokens,
  saveStoredTokens,
  clearStoredTokens,
  defaultConfigDir,
} from '../tracker/auth-store.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gaggle-auth-store-'));
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('auth-store: round-trip', () => {
  test('saveStoredTokens then loadStoredTokens returns equivalent data', () => {
    const tokens = {
      access_token: 'access_abc',
      refresh_token: 'refresh_xyz',
      expires_at: 1_700_000_000_000,
      scope: 'read write',
    };
    saveStoredTokens(tokens, dir);
    const loaded = loadStoredTokens(dir);
    expect(loaded?.access_token).toBe('access_abc');
    expect(loaded?.refresh_token).toBe('refresh_xyz');
    expect(loaded?.expires_at).toBe(1_700_000_000_000);
    expect(loaded?.scope).toBe('read write');
    expect(typeof loaded?.updated_at).toBe('string');
  });

  test('saveStoredTokens creates the config dir if missing', () => {
    const nested = join(dir, 'nested', 'dir');
    saveStoredTokens(
      { access_token: 'a', refresh_token: 'b', expires_at: 1, scope: '' },
      nested,
    );
    expect(existsSync(join(nested, 'auth.json'))).toBe(true);
  });

  test('overwriting tokens replaces the file content', () => {
    saveStoredTokens({ access_token: 'first', refresh_token: 'r1', expires_at: 1, scope: '' }, dir);
    saveStoredTokens({ access_token: 'second', refresh_token: 'r2', expires_at: 2, scope: 'read' }, dir);
    const loaded = loadStoredTokens(dir);
    expect(loaded?.access_token).toBe('second');
    expect(loaded?.refresh_token).toBe('r2');
    expect(loaded?.scope).toBe('read');
  });
});

describe('auth-store: missing / corrupt file', () => {
  test('loadStoredTokens returns null when the file does not exist', () => {
    expect(loadStoredTokens(dir)).toBeNull();
  });

  test('loadStoredTokens returns null when the file is not valid JSON', () => {
    writeFileSync(join(dir, 'auth.json'), 'not-json {{{ ', 'utf8');
    expect(loadStoredTokens(dir)).toBeNull();
  });

  test('loadStoredTokens returns null when the file lacks required fields', () => {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ access_token: 'just-this' }), 'utf8');
    expect(loadStoredTokens(dir)).toBeNull();
  });
});

describe('auth-store: clearStoredTokens', () => {
  test('removes the file when present', () => {
    saveStoredTokens({ access_token: 'a', refresh_token: 'b', expires_at: 1, scope: '' }, dir);
    clearStoredTokens(dir);
    expect(loadStoredTokens(dir)).toBeNull();
    expect(existsSync(join(dir, 'auth.json'))).toBe(false);
  });

  test('is a no-op when the file does not exist', () => {
    expect(() => clearStoredTokens(dir)).not.toThrow();
  });
});

describe('auth-store: file permissions (Unix only)', () => {
  const isWindows = process.platform === 'win32';
  test.skipIf(isWindows)('auth.json is written with 0600 permissions', () => {
    saveStoredTokens({ access_token: 'a', refresh_token: 'b', expires_at: 1, scope: '' }, dir);
    const mode = statSync(join(dir, 'auth.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('auth-store: defaultConfigDir', () => {
  test('respects XDG_CONFIG_HOME when set', () => {
    const original = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-test-home';
    try {
      // Use path.join in the expectation so the test is platform-agnostic
      // (Windows joins with backslashes).
      expect(defaultConfigDir()).toBe(join('/tmp/xdg-test-home', 'gaggle'));
    } finally {
      if (original === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = original;
    }
  });
});

describe('auth-store: JSON shape on disk', () => {
  test('written file is valid JSON with expected keys', () => {
    saveStoredTokens({ access_token: 'a', refresh_token: 'b', expires_at: 1, scope: 'read' }, dir);
    const raw = readFileSync(join(dir, 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ['access_token', 'expires_at', 'refresh_token', 'scope', 'updated_at'].sort(),
    );
  });
});
