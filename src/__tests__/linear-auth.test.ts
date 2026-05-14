/**
 * AuthProvider tests for ApiKeyAuth and OAuthAuth.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiKeyAuth, OAuthAuth } from '../tracker/linear-auth.ts';
import { RecordingHttpClient } from '../tracker/http-client.ts';
import { saveStoredTokens } from '../tracker/auth-store.ts';

describe('ApiKeyAuth', () => {
  test('returns the configured API key as the Authorization header', async () => {
    const auth = new ApiKeyAuth('lin_api_xyz');
    expect(await auth.getAuthorizationHeader()).toBe('lin_api_xyz');
  });

  test('throws if constructed with an empty key', () => {
    expect(() => new ApiKeyAuth('')).toThrow(/empty/i);
  });

  test('refreshOnUnauthorized returns false — API keys do not refresh', async () => {
    const auth = new ApiKeyAuth('lin_api_xyz');
    expect(await auth.refreshOnUnauthorized()).toBe(false);
  });
});

describe('OAuthAuth', () => {
  let dir: string;
  let http: RecordingHttpClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gaggle-oauth-auth-'));
    http = new RecordingHttpClient();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function seedTokens(opts: { expiresInMs: number; access?: string; refresh?: string } = { expiresInMs: 60 * 60 * 1000 }) {
    saveStoredTokens(
      {
        access_token: opts.access ?? 'access_seed',
        refresh_token: opts.refresh ?? 'refresh_seed',
        expires_at: Date.now() + opts.expiresInMs,
        scope: 'read write',
      },
      dir,
    );
  }

  test('throws if client_id is empty', () => {
    expect(() => new OAuthAuth({ client_id: '', client_secret: 's' })).toThrow(/client_id/);
  });

  test('throws if client_secret is empty', () => {
    expect(() => new OAuthAuth({ client_id: 'c', client_secret: '' })).toThrow(/client_secret/);
  });

  test('hasTokens returns false when no stored tokens', () => {
    const auth = new OAuthAuth({ client_id: 'c', client_secret: 's', configDir: dir, http });
    expect(auth.hasTokens()).toBe(false);
  });

  test('hasTokens returns true after seeding tokens', () => {
    seedTokens();
    const auth = new OAuthAuth({ client_id: 'c', client_secret: 's', configDir: dir, http });
    expect(auth.hasTokens()).toBe(true);
  });

  test('getAuthorizationHeader throws if no stored tokens', async () => {
    const auth = new OAuthAuth({ client_id: 'c', client_secret: 's', configDir: dir, http });
    await expect(auth.getAuthorizationHeader()).rejects.toThrow(/no stored linear oauth tokens/i);
  });

  test('getAuthorizationHeader returns Bearer <access_token> when token is fresh', async () => {
    seedTokens({ expiresInMs: 60 * 60 * 1000, access: 'fresh_token' });
    const auth = new OAuthAuth({ client_id: 'c', client_secret: 's', configDir: dir, http });
    expect(await auth.getAuthorizationHeader()).toBe('Bearer fresh_token');
  });

  test('refreshes proactively when token is near expiry', async () => {
    seedTokens({ expiresInMs: 10_000, access: 'old', refresh: 'refresh_v1' });
    http.enqueue({
      access_token: 'refreshed_access',
      refresh_token: 'refresh_v2',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'read write',
    });
    const auth = new OAuthAuth({ client_id: 'c', client_secret: 's', configDir: dir, http });
    const header = await auth.getAuthorizationHeader();
    expect(header).toBe('Bearer refreshed_access');
  });

  test('does NOT refresh when token is far from expiry', async () => {
    seedTokens({ expiresInMs: 60 * 60 * 1000, access: 'still_fresh' });
    const auth = new OAuthAuth({ client_id: 'c', client_secret: 's', configDir: dir, http });
    await auth.getAuthorizationHeader();
    expect(http.calls.length).toBe(0);
  });

  test('concurrent getAuthorizationHeader calls share a single refresh', async () => {
    seedTokens({ expiresInMs: 10_000, access: 'old' });
    http.enqueue({
      access_token: 'shared_refresh',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: '',
    });
    const auth = new OAuthAuth({ client_id: 'c', client_secret: 's', configDir: dir, http });
    const [a, b, c] = await Promise.all([
      auth.getAuthorizationHeader(),
      auth.getAuthorizationHeader(),
      auth.getAuthorizationHeader(),
    ]);
    expect(a).toBe('Bearer shared_refresh');
    expect(b).toBe('Bearer shared_refresh');
    expect(c).toBe('Bearer shared_refresh');
    expect(http.calls.length).toBe(1); // ONE refresh
  });

  test('refreshOnUnauthorized refreshes the token and returns true', async () => {
    seedTokens({ expiresInMs: 60 * 60 * 1000, access: 'cur' });
    http.enqueue({
      access_token: 'forced_refresh',
      refresh_token: 'r',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: '',
    });
    const auth = new OAuthAuth({ client_id: 'c', client_secret: 's', configDir: dir, http });
    expect(await auth.refreshOnUnauthorized()).toBe(true);
    expect(await auth.getAuthorizationHeader()).toBe('Bearer forced_refresh');
  });

  test('refreshOnUnauthorized returns false if refresh fails', async () => {
    seedTokens({ expiresInMs: 60 * 60 * 1000 });
    http.enqueue({ status: 401, body: { error: 'invalid_refresh_token' } });
    const auth = new OAuthAuth({ client_id: 'c', client_secret: 's', configDir: dir, http });
    expect(await auth.refreshOnUnauthorized()).toBe(false);
  });

  test('refreshOnUnauthorized returns false if there are no stored tokens', async () => {
    const auth = new OAuthAuth({ client_id: 'c', client_secret: 's', configDir: dir, http });
    expect(await auth.refreshOnUnauthorized()).toBe(false);
  });

  test('refreshed tokens are persisted to disk', async () => {
    seedTokens({ expiresInMs: 10_000 });
    http.enqueue({
      access_token: 'persisted_after_refresh',
      refresh_token: 'r2',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'read write',
    });
    const auth = new OAuthAuth({ client_id: 'c', client_secret: 's', configDir: dir, http });
    await auth.getAuthorizationHeader();

    // A fresh OAuthAuth reading the same dir should pick up the refreshed tokens.
    const auth2 = new OAuthAuth({ client_id: 'c', client_secret: 's', configDir: dir, http });
    expect(await auth2.getAuthorizationHeader()).toBe('Bearer persisted_after_refresh');
  });
});
