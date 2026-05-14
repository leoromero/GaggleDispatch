/**
 * Linear OAuth 2.0 authorization-code flow.
 *
 * Endpoints:
 *   Authorize: https://linear.app/oauth/authorize
 *   Token:     https://api.linear.app/oauth/token
 *
 * Linear supports an `actor` query parameter on the authorize URL:
 *   - `user` (default): the access token acts as the authorizing user
 *   - `app`: the access token acts as the OAuth application itself —
 *     comments/issues attributed to the app, with the app icon. This is
 *     what GaggleDispatch wants for a separate bot identity.
 *
 * Tokens come back with a refresh_token (Linear's are long-lived, typically
 * 10 years, but we still respect the expires_in field and refresh proactively).
 */

import { randomBytes } from 'node:crypto';
import { logger } from '../util/logger.ts';
import type { HttpClient } from './http-client.ts';

export const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
export const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  /** Absolute epoch-millisecond timestamp when the access_token expires. */
  expires_at: number;
  scope: string;
}

export interface AuthorizeUrlInput {
  client_id: string;
  redirect_uri: string;
  /** Default ['read', 'write']. */
  scopes?: string[];
  /** CSRF token. The callback handler verifies the returned `state` matches. */
  state: string;
  /** Default 'app' — comments attributed to the OAuth application. */
  actor?: 'user' | 'app';
}

/** Build the URL the user opens in their browser to authorize the app. */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    response_type: 'code',
    scope: (input.scopes ?? ['read', 'write']).join(' '),
    state: input.state,
    actor: input.actor ?? 'app',
    prompt: 'consent',
  });
  return `${LINEAR_AUTHORIZE_URL}?${params.toString()}`;
}

/** Cryptographically-random opaque value for CSRF protection. */
export function generateState(): string {
  return randomBytes(24).toString('hex');
}

// ─── Token exchange + refresh ──────────────────────────────────────────────

interface LinearTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export class OAuthError extends Error {
  override name = 'OAuthError';
  constructor(message: string, public payload?: unknown) {
    super(message);
  }
}

/** Exchange an authorization code for tokens. */
export async function exchangeCodeForTokens(args: {
  http: HttpClient;
  code: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    code: args.code,
    redirect_uri: args.redirect_uri,
    client_id: args.client_id,
    client_secret: args.client_secret,
    grant_type: 'authorization_code',
  }).toString();
  return postToTokenEndpoint(args.http, body);
}

/** Refresh an access token using a refresh_token. */
export async function refreshAccessToken(args: {
  http: HttpClient;
  refresh_token: string;
  client_id: string;
  client_secret: string;
}): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    refresh_token: args.refresh_token,
    client_id: args.client_id,
    client_secret: args.client_secret,
    grant_type: 'refresh_token',
  }).toString();
  return postToTokenEndpoint(args.http, body, args.refresh_token);
}

async function postToTokenEndpoint(
  http: HttpClient,
  body: string,
  fallbackRefreshToken?: string,
): Promise<OAuthTokens> {
  const res = await http.fetch(LINEAR_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OAuthError(`Linear token endpoint HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json().catch(() => null) as LinearTokenResponse | null;
  if (!json || typeof json.access_token !== 'string') {
    throw new OAuthError('Linear token endpoint returned malformed JSON', json);
  }
  return {
    access_token: json.access_token,
    // Linear may omit refresh_token on a refresh — keep the original.
    refresh_token: json.refresh_token ?? fallbackRefreshToken ?? '',
    expires_at: Date.now() + json.expires_in * 1000,
    scope: json.scope,
  };
}

// ─── Local callback server ─────────────────────────────────────────────────

export interface CallbackResult {
  code: string;
  state: string;
}

export interface CallbackServerOptions {
  /** Full redirect URI registered with Linear; the server binds the port from this. */
  redirect_uri: string;
  /** CSRF token to verify against the callback's `state` param. */
  expected_state: string;
  /** Milliseconds to wait before giving up if no callback arrives. Default 5 minutes. */
  timeout_ms?: number;
}

/**
 * Start a one-shot HTTP server that accepts the OAuth redirect, parses the
 * `code` + `state` query params, verifies state, and resolves. Closes
 * immediately after handling the callback (or on timeout).
 *
 * Returns a promise resolving to `{ code, state }`, or rejecting with
 * OAuthError on timeout, state mismatch, or Linear-side error response
 * (e.g. user denied authorization).
 */
export async function runLocalCallbackServer(opts: CallbackServerOptions): Promise<CallbackResult> {
  const url = new URL(opts.redirect_uri);
  const port = parseInt(url.port || '80', 10);
  const path = url.pathname;

  return new Promise<CallbackResult>((resolve, reject) => {
    let resolved = false;
    let server: { stop: () => void } | null = null;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { server?.stop(); } catch { /* ignore */ }
      reject(new OAuthError(`OAuth callback timed out after ${opts.timeout_ms ?? 300_000}ms`));
    }, opts.timeout_ms ?? 300_000);

    // Bun.serve is the runtime we target. Fall back to a Node http server if
    // Bun is unavailable would be needed for portability — we accept the
    // Bun-only dependency to keep this simple.
    const bunRef = (globalThis as unknown as { Bun?: { serve: (opts: unknown) => { stop: () => void; port: number } } }).Bun;
    if (!bunRef) {
      clearTimeout(timer);
      reject(new OAuthError('runLocalCallbackServer requires the Bun runtime (Bun.serve not available)'));
      return;
    }

    try {
      server = bunRef.serve({
        port,
        hostname: url.hostname,
        fetch: (req: Request) => {
          const reqUrl = new URL(req.url);
          if (reqUrl.pathname !== path) {
            return new Response('Not found', { status: 404 });
          }
          const params = reqUrl.searchParams;
          const error = params.get('error');
          if (error) {
            const desc = params.get('error_description') ?? '';
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              setTimeout(() => { try { server?.stop(); } catch { /* ignore */ } }, 100);
              reject(new OAuthError(`Linear returned error: ${error}${desc ? ' — ' + desc : ''}`));
            }
            return new Response(htmlError(error, desc), {
              status: 400,
              headers: { 'Content-Type': 'text/html' },
            });
          }
          const code = params.get('code');
          const state = params.get('state');
          if (!code || !state) {
            return new Response('Missing code or state', { status: 400 });
          }
          if (state !== opts.expected_state) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              setTimeout(() => { try { server?.stop(); } catch { /* ignore */ } }, 100);
              reject(new OAuthError('OAuth state mismatch — possible CSRF attempt'));
            }
            return new Response('State mismatch', { status: 400 });
          }
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            setTimeout(() => { try { server?.stop(); } catch { /* ignore */ } }, 100);
            resolve({ code, state });
          }
          return new Response(htmlSuccess(), {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        },
        error: (err: Error) => {
          logger.warn('OAuth callback server error', { error: err.message });
          return new Response('Internal error', { status: 500 });
        },
      }) as { stop: () => void; port: number };
      logger.debug('OAuth callback server listening', { port, path });
    } catch (err) {
      clearTimeout(timer);
      const msg = (err as Error).message ?? String(err);
      if (/EADDRINUSE|address already in use/i.test(msg)) {
        reject(new OAuthError(
          `Port ${port} is already in use. Either another \`gaggle init\` is running, ` +
          `or a stale process is bound to it. Stop the conflicting process and retry.`,
        ));
      } else {
        reject(new OAuthError(`Failed to start callback server on port ${port}: ${msg}`));
      }
    }
  });
}

function htmlSuccess(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>GaggleDispatch — authorized</title>
<style>body{font-family:system-ui;max-width:480px;margin:48px auto;padding:0 16px}h1{color:#16a34a}</style>
</head><body>
<h1>✓ Authorized</h1>
<p>You can close this tab — gaggle has captured the credentials and is finishing setup.</p>
</body></html>`;
}

function htmlError(error: string, description: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>GaggleDispatch — authorization failed</title>
<style>body{font-family:system-ui;max-width:480px;margin:48px auto;padding:0 16px}h1{color:#dc2626}code{background:#f4f4f5;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>✗ Authorization failed</h1>
<p>Linear returned: <code>${escapeHtml(error)}</code></p>
${description ? `<p>${escapeHtml(description)}</p>` : ''}
<p>Return to your terminal — gaggle has logged the error.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ─── Validation ────────────────────────────────────────────────────────────

/** Validate a redirect_uri is shaped correctly for Linear OAuth (localhost,
 *  with a port and path). Returns null on success, error message on failure. */
export function validateRedirectUri(uri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return `tracker.auth.redirect_uri is not a valid URL: ${uri}`;
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    return `tracker.auth.redirect_uri must use 127.0.0.1 or localhost (Linear rejects others for native apps); got ${parsed.hostname}`;
  }
  if (!parsed.port) {
    return `tracker.auth.redirect_uri must include an explicit port, e.g. http://127.0.0.1:8765/oauth/callback`;
  }
  const port = parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return `tracker.auth.redirect_uri port must be a valid TCP port; got ${parsed.port}`;
  }
  if (parsed.pathname === '' || parsed.pathname === '/') {
    return `tracker.auth.redirect_uri must include a non-empty path, e.g. /oauth/callback`;
  }
  return null;
}
