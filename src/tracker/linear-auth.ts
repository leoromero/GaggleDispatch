/**
 * Auth abstraction for the Linear tracker. {@link LinearClient} reads its
 * Authorization header from an {@link AuthProvider}, so the same client
 * supports both legacy API-key auth and OAuth (added in a follow-up commit).
 */

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
