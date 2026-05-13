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
  const cmd =
    process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url] :
    process.platform === 'darwin' ? ['open', url] :
    ['xdg-open', url];
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
