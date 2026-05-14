/**
 * `gaggle auth linear` — run the Linear OAuth authorization flow.
 *
 * Reads `tracker.auth.{client_id, client_secret, redirect_uri, scopes}` from
 * the active WORKFLOW.md, launches a one-shot local callback server, opens
 * the Linear authorize URL in the user's browser, captures the redirect,
 * exchanges the code for tokens, and writes them to `<config_dir>/auth.json`.
 *
 * On success the orchestrator can be started; refresh tokens keep it
 * authenticated indefinitely without further user interaction.
 */

import chalk from 'chalk';
import { loadConfig, fatal } from './common.ts';
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  generateState,
  runLocalCallbackServer,
} from '../tracker/linear-oauth.ts';
import { FetchHttpClient } from '../tracker/http-client.ts';
import { saveStoredTokens } from '../tracker/auth-store.ts';
import { openInBrowser } from '../util/open-in-browser.ts';

export async function runAuthLinear(opts: { cwd?: string }): Promise<void> {
  const cfg = loadConfig({ cwd: opts.cwd });

  if (cfg.tracker.auth.mode !== 'oauth') {
    fatal(
      `tracker.auth.mode is '${cfg.tracker.auth.mode}', not 'oauth'. ` +
      `Set tracker.auth.mode: oauth in WORKFLOW.md, then re-run this command.`,
    );
  }
  const { client_id, client_secret, redirect_uri, scopes } = cfg.tracker.auth;
  if (!client_id) fatal('tracker.auth.client_id is empty.');
  if (!client_secret) fatal('tracker.auth.client_secret is empty (set LINEAR_OAUTH_CLIENT_SECRET).');

  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl({
    client_id,
    redirect_uri,
    scopes,
    state,
    actor: 'app',
  });

  console.log(chalk.cyan('Starting OAuth authorization for Linear…'));
  console.log(chalk.dim(`  Redirect URI: ${redirect_uri}`));
  console.log(chalk.dim(`  Scopes: ${scopes.join(', ')}`));
  console.log(chalk.dim('  Actor: app (comments will be attributed to the OAuth application)'));
  console.log('');

  // Start the callback server FIRST so it's ready when the browser arrives.
  const serverPromise = runLocalCallbackServer({
    redirect_uri,
    expected_state: state,
    timeout_ms: 5 * 60_000,
  });

  console.log(chalk.cyan('Opening authorization URL in your default browser…'));
  console.log(chalk.dim(`  If it doesn't open, visit this URL manually:\n  ${authorizeUrl}\n`));
  await openInBrowser(authorizeUrl);

  let result;
  try {
    result = await serverPromise;
  } catch (err) {
    fatal(`OAuth authorization failed: ${(err as Error).message}`);
  }

  const http = new FetchHttpClient();
  let tokens;
  try {
    tokens = await exchangeCodeForTokens({
      http,
      code: result.code,
      client_id,
      client_secret,
      redirect_uri,
    });
  } catch (err) {
    fatal(`Token exchange failed: ${(err as Error).message}`);
  }

  saveStoredTokens({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
    scope: tokens.scope,
  });

  console.log(chalk.green('✓ Linear authorization complete.'));
  console.log(chalk.dim(`  Scopes granted: ${tokens.scope}`));
  console.log(chalk.dim(`  Tokens stored. The orchestrator will refresh them automatically.`));
}
