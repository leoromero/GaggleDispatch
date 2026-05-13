/**
 * Auth abstraction for the Linear tracker. {@link LinearClient} reads its
 * Authorization header from an {@link AuthProvider}, so the same client
 * supports both legacy API-key auth and OAuth.
 */

import { loadStoredTokens, saveStoredTokens } from './auth-store.ts';
import { refreshAccessToken, OAuthError, type OAuthTokens } from './linear-oauth.ts';
import type { HttpClient } from './http-client.ts';
import { FetchHttpClient } from './http-client.ts';
import { logger } from '../util/logger.ts';

/**
 * Returns a string suitable for use as the value of a Linear API
 * `Authorization` header.
 *
 * Linear accepts two formats:
 *   - Personal API key: the raw key string (e.g. "lin_api_xxx")
 *   - OAuth bearer:    "Bearer <access_token>"
 *
 * Implementations decide which they return.
 */
export interface AuthProvider {
  getAuthorizationHeader(): Promise<string>;
  /**
   * Called by {@link LinearClient} when a request returns HTTP 401. Provides
   * a hook for OAuth implementations to refresh the access token and signal
   * "try the request again with a new header". Returns true if the caller
   * should retry; false if no retry is possible (e.g. API key auth can't
   * refresh).
   */
  refreshOnUnauthorized(): Promise<boolean>;
}

// ─── API-key (legacy) ──────────────────────────────────────────────────────

export class ApiKeyAuth implements AuthProvider {
  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error('ApiKeyAuth: api key is empty');
    }
  }

  async getAuthorizationHeader(): Promise<string> {
    return this.apiKey;
  }

  async refreshOnUnauthorized(): Promise<boolean> {
    // API keys don't refresh. A 401 means the key was revoked or is invalid.
    return false;
  }
}

// ─── OAuth ─────────────────────────────────────────────────────────────────

/** Buffer applied to the access-token expiry check. Refresh proactively if
 *  the token would expire within this window during the next request. */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

export interface OAuthAuthConfig {
  client_id: string;
  client_secret: string;
  /** Optional override of the auth.json directory. Defaults to the standard
   *  per-machine config dir. Useful for tests. */
  configDir?: string;
  /** Optional HttpClient override for refresh requests. Defaults to a fresh
   *  FetchHttpClient. */
  http?: HttpClient;
}

/**
 * OAuth-backed auth provider. Reads tokens from auth.json at construction;
 * proactively refreshes the access token when it's near expiry; provides the
 * refresh-on-401 hook for {@link LinearClient}.
 *
 * Thread-safety: a single in-flight refresh is shared by concurrent
 * `getAuthorizationHeader` callers so we don't fire multiple refresh
 * requests for the same expiry window.
 */
export class OAuthAuth implements AuthProvider {
  private tokens: OAuthTokens | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private http: HttpClient;

  constructor(private readonly oauth: OAuthAuthConfig) {
    if (!oauth.client_id) throw new Error('OAuthAuth: client_id is empty');
    if (!oauth.client_secret) throw new Error('OAuthAuth: client_secret is empty (set LINEAR_OAUTH_CLIENT_SECRET)');
    this.http = oauth.http ?? new FetchHttpClient();
    const stored = loadStoredTokens(oauth.configDir);
    if (stored) {
      this.tokens = {
        access_token: stored.access_token,
        refresh_token: stored.refresh_token,
        expires_at: stored.expires_at,
        scope: stored.scope,
      };
    }
  }

  hasTokens(): boolean {
    return this.tokens !== null;
  }

  async getAuthorizationHeader(): Promise<string> {
    if (!this.tokens) {
      throw new OAuthError(
        'No stored Linear OAuth tokens. Run `gaggle init` (or `gaggle auth linear`) to authorize.',
      );
    }
    if (Date.now() >= this.tokens.expires_at - TOKEN_EXPIRY_BUFFER_MS) {
      await this.ensureRefreshed();
    }
    return `Bearer ${this.tokens.access_token}`;
  }

  async refreshOnUnauthorized(): Promise<boolean> {
    if (!this.tokens) return false;
    try {
      await this.ensureRefreshed(/* forceRefresh */ true);
      return true;
    } catch (err) {
      logger.warn('OAuth refresh on 401 failed', { error: (err as Error).message });
      return false;
    }
  }

  private async ensureRefreshed(forceRefresh = false): Promise<void> {
    if (!this.tokens) throw new OAuthError('No tokens to refresh');
    if (!forceRefresh && Date.now() < this.tokens.expires_at - TOKEN_EXPIRY_BUFFER_MS) {
      return; // still fresh
    }
    if (this.refreshInFlight) {
      await this.refreshInFlight;
      return;
    }
    this.refreshInFlight = (async () => {
      const newTokens = await refreshAccessToken({
        http: this.http,
        refresh_token: this.tokens!.refresh_token,
        client_id: this.oauth.client_id,
        client_secret: this.oauth.client_secret,
      });
      this.tokens = newTokens;
      saveStoredTokens(newTokens, this.oauth.configDir);
      logger.debug('OAuth access token refreshed', { expires_at: newTokens.expires_at });
    })();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }
}
