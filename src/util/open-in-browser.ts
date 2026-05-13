/**
 * Cross-platform "open this URL in the user's default browser" helper.
 *
 * Best-effort: if the OS shell-out fails (no GUI, headless environment,
 * binary not on PATH), prints the URL to stdout so the user can copy-paste
 * it. Never throws — callers should treat the printed-URL fallback as
 * acceptable.
 */

import { logger } from './logger.ts';

export async function openInBrowser(url: string): Promise<void> {
  // Windows quirk: `cmd /c start <url>` treats & in the URL as a command
  // separator, mangling OAuth URLs (the query string drops everything after
  // the first param). Pass the full `start "" "<url>"` invocation as a
  // single string after /c so cmd's own parser handles the quoting and
  // preserves & inside the quoted URL.
  //
  // macOS/Linux pass the URL directly to `open`/`xdg-open` which spawn
  // without a shell — no escaping needed.
  let cmd: string[];
  if (process.platform === 'win32') {
    // Escape any embedded quotes in the URL (unlikely for OAuth URLs but
    // defensive). The outer quotes around ${url} are what tell cmd to keep
    // the URL as a single token.
    const escaped = url.replace(/"/g, '\\"');
    cmd = ['cmd', '/c', `start "" "${escaped}"`];
  } else if (process.platform === 'darwin') {
    cmd = ['open', url];
  } else {
    cmd = ['xdg-open', url];
  }

  try {
    const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
    // Don't await — the browser launch is fire-and-forget. We just want to
    // know the spawn itself didn't blow up.
    proc.unref?.();
    logger.debug('Opened URL in browser', { url, platform: process.platform });
  } catch (err) {
    logger.warn('Could not open browser automatically; please open the URL manually', {
      url,
      error: (err as Error).message,
    });
    console.log(`\nOpen this URL in your browser:\n  ${url}\n`);
  }
}
