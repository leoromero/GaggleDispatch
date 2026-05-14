/**
 * Hot-reload watcher for WORKFLOW.md (Section 6.2).
 * Uses chokidar; emits debounced reload events.
 */

import chokidar from 'chokidar';
import { logger } from '../util/logger.ts';

export interface WatchHandle {
  close: () => Promise<void>;
}

export function watchFile(path: string, onChange: () => void, debounceMs = 250): WatchHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher = chokidar.watch(path, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  const handler = (event: string) => {
    logger.debug(`watcher event: ${event}`, { path });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        onChange();
      } catch (err) {
        logger.error('Watcher onChange error', { path, error: (err as Error).message });
      }
    }, debounceMs);
  };

  watcher.on('change', () => handler('change'));
  watcher.on('add', () => handler('add'));
  watcher.on('unlink', () => handler('unlink'));

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
