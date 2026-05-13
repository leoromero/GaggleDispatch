/**
 * AuthProvider tests. PR 1 only ships {@link ApiKeyAuth}; the OAuth
 * implementation arrives in a follow-up commit.
 */

import { describe, expect, test } from 'bun:test';
import { ApiKeyAuth } from '../tracker/linear-auth.ts';

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
