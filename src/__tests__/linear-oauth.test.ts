/**
 * linear-oauth tests: authorize URL builder, token exchange, refresh,
 * redirect URI validation. Uses {@link RecordingHttpClient} so no network
 * calls happen.
 *
 * The local callback server (`runLocalCallbackServer`) is end-to-end-tested
 * by spinning up a real Bun.serve on a random port and firing a fetch at it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { RecordingHttpClient } from '../tracker/http-client.ts';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  generateState,
  LINEAR_AUTHORIZE_URL,
  LINEAR_TOKEN_URL,
  OAuthError,
  refreshAccessToken,
  runLocalCallbackServer,
  validateRedirectUri,
} from '../tracker/linear-oauth.ts';

// ─── authorize URL ─────────────────────────────────────────────────────────

describe('buildAuthorizeUrl', () => {
  test('includes all required params', () => {
    const url = buildAuthorizeUrl({
      client_id: 'lin_oauth_xyz',
      redirect_uri: 'http://127.0.0.1:8765/oauth/callback',
      state: 'abc123',
      scopes: ['read', 'write'],
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(LINEAR_AUTHORIZE_URL);
    expect(parsed.searchParams.get('client_id')).toBe('lin_oauth_xyz');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8765/oauth/callback');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe('read write');
    expect(parsed.searchParams.get('state')).toBe('abc123');
    expect(parsed.searchParams.get('actor')).toBe('app');
  });

  test('defaults scopes to read+write and actor to app', () => {
    const url = buildAuthorizeUrl({
      client_id: 'x', redirect_uri: 'http://127.0.0.1:8765/cb', state: 's',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toBe('read write');
    expect(parsed.searchParams.get('actor')).toBe('app');
  });

  test('honours actor=user when explicitly set', () => {
    const url = buildAuthorizeUrl({
      client_id: 'x', redirect_uri: 'http://127.0.0.1:8765/cb', state: 's', actor: 'user',
    });
    expect(new URL(url).searchParams.get('actor')).toBe('user');
  });
});

describe('generateState', () => {
  test('returns a non-empty hex string', () => {
    const s = generateState();
    expect(s.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/.test(s)).toBe(true);
  });

  test('generates distinct values across calls', () => {
    expect(generateState()).not.toBe(generateState());
  });
});

// ─── Token endpoint ────────────────────────────────────────────────────────

describe('exchangeCodeForTokens', () => {
  test('POSTs form-encoded body to the token endpoint and returns parsed tokens', async () => {
    const http = new RecordingHttpClient();
    http.enqueue({
      access_token: 'access_aaa',
      refresh_token: 'refresh_bbb',
      token_type: 'Bearer',
      expires_in: 36_000,
      scope: 'read write',
    });
    const tokens = await exchangeCodeForTokens({
      http, code: 'CODE_X', client_id: 'cid', client_secret: 'csec', redirect_uri: 'http://x/cb',
    });
    expect(tokens.access_token).toBe('access_aaa');
    expect(tokens.refresh_token).toBe('refresh_bbb');
    expect(tokens.scope).toBe('read write');
    expect(tokens.expires_at).toBeGreaterThan(Date.now());

    expect(http.calls[0]?.url).toBe(LINEAR_TOKEN_URL);
    expect(http.calls[0]?.method).toBe('POST');
    expect(http.calls[0]?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = http.calls[0]?.body as string;
    expect(body).toContain('code=CODE_X');
    expect(body).toContain('client_id=cid');
    expect(body).toContain('grant_type=authorization_code');
  });

  test('throws OAuthError on non-OK HTTP status', async () => {
    const http = new RecordingHttpClient();
    http.enqueue({ status: 400, body: { error: 'invalid_grant' } });
    await expect(
      exchangeCodeForTokens({ http, code: 'X', client_id: 'c', client_secret: 's', redirect_uri: 'r' }),
    ).rejects.toThrow(OAuthError);
  });

  test('throws OAuthError on malformed JSON response', async () => {
    const http = new RecordingHttpClient();
    http.enqueue({ not_a_token: true });
    await expect(
      exchangeCodeForTokens({ http, code: 'X', client_id: 'c', client_secret: 's', redirect_uri: 'r' }),
    ).rejects.toThrow(/malformed/i);
  });
});

describe('refreshAccessToken', () => {
  test('falls back to the original refresh_token when Linear omits one in the response', async () => {
    const http = new RecordingHttpClient();
    http.enqueue({
      access_token: 'new_access',
      // refresh_token intentionally omitted — Linear sometimes returns no new refresh
      token_type: 'Bearer',
      expires_in: 36_000,
      scope: 'read write',
    });
    const tokens = await refreshAccessToken({
      http, refresh_token: 'old_refresh', client_id: 'cid', client_secret: 'csec',
    });
    expect(tokens.access_token).toBe('new_access');
    expect(tokens.refresh_token).toBe('old_refresh');
  });

  test('uses grant_type=refresh_token in the form body', async () => {
    const http = new RecordingHttpClient();
    http.enqueue({
      access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 1, scope: '',
    });
    await refreshAccessToken({ http, refresh_token: 'old', client_id: 'c', client_secret: 's' });
    const body = http.calls[0]?.body as string;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=old');
  });

  test('propagates HTTP error from the token endpoint', async () => {
    const http = new RecordingHttpClient();
    http.enqueue({ status: 401, body: { error: 'invalid_refresh_token' } });
    await expect(
      refreshAccessToken({ http, refresh_token: 'old', client_id: 'c', client_secret: 's' }),
    ).rejects.toThrow(OAuthError);
  });
});

// ─── redirect URI validation ───────────────────────────────────────────────

describe('validateRedirectUri', () => {
  test.each([
    ['http://127.0.0.1:8765/oauth/callback'],
    ['http://localhost:1234/cb'],
    ['https://localhost:8443/x'],
  ])('accepts %s', (uri: string) => {
    expect(validateRedirectUri(uri)).toBeNull();
  });

  test('rejects non-URL strings', () => {
    expect(validateRedirectUri('not-a-url')).toMatch(/not a valid URL/);
  });

  test('rejects non-localhost hosts', () => {
    expect(validateRedirectUri('http://example.com:8080/cb')).toMatch(/127\.0\.0\.1 or localhost/);
  });

  test('rejects URLs without a port', () => {
    expect(validateRedirectUri('http://127.0.0.1/cb')).toMatch(/explicit port/);
  });

  test('rejects URLs without a path', () => {
    expect(validateRedirectUri('http://127.0.0.1:8765')).toMatch(/non-empty path/);
    expect(validateRedirectUri('http://127.0.0.1:8765/')).toMatch(/non-empty path/);
  });
});

// ─── Local callback server (real network) ─────────────────────────────────

describe('runLocalCallbackServer (end-to-end)', () => {
  // Each test uses a distinct port to avoid Bun.serve EADDRINUSE flakes
  // when ports linger in TIME_WAIT between tests.
  test('captures code+state on a valid callback', async () => {
    const uri = `http://127.0.0.1:39871/oauth/callback`;
    const promise = runLocalCallbackServer({
      redirect_uri: uri,
      expected_state: 'expected_state_123',
      timeout_ms: 5_000,
    });
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`${uri}?code=THE_CODE&state=expected_state_123`);
    expect(res.status).toBe(200);
    const result = await promise;
    expect(result.code).toBe('THE_CODE');
    expect(result.state).toBe('expected_state_123');
  });

  test('rejects on state mismatch (CSRF guard)', async () => {
    const uri = `http://127.0.0.1:39872/oauth/callback`;
    const promise = runLocalCallbackServer({
      redirect_uri: uri,
      expected_state: 'expected_xyz',
      timeout_ms: 5_000,
    });
    // Attach a catch handler synchronously so the rejection isn't unhandled
    // by the time we trigger it from the fetch below.
    const caught: Error[] = [];
    promise.catch((err: Error) => caught.push(err));
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${uri}?code=c&state=different_state`);
    // Give the rejection a moment to land.
    await new Promise((r) => setTimeout(r, 100));
    expect(caught.length).toBe(1);
    expect(caught[0]?.message).toMatch(/state mismatch/i);
  });

  test('rejects when Linear redirects with an error param (user denied)', async () => {
    const uri = `http://127.0.0.1:39873/oauth/callback`;
    const promise = runLocalCallbackServer({
      redirect_uri: uri,
      expected_state: 's',
      timeout_ms: 5_000,
    });
    const caught: Error[] = [];
    promise.catch((err: Error) => caught.push(err));
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${uri}?error=access_denied&error_description=User+denied`);
    await new Promise((r) => setTimeout(r, 100));
    expect(caught.length).toBe(1);
    expect(caught[0]?.message).toMatch(/access_denied/);
  });

  test('rejects on timeout if no callback arrives', async () => {
    const uri = `http://127.0.0.1:39874/oauth/callback`;
    const promise = runLocalCallbackServer({
      redirect_uri: uri,
      expected_state: 's',
      timeout_ms: 200,
    });
    await expect(promise).rejects.toThrow(/timed out/i);
  });
});
