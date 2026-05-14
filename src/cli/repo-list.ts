/**
 * `gaggle repo list` (Section 21.5).
 */

import { loadConfig } from './common.ts';
import { loadSyncedRegistry } from '../registry/synced-registry.ts';
import chalk from 'chalk';

export async function runRepoList(opts: { cwd?: string; json?: boolean }): Promise<void> {
  const cfg = loadConfig({ cwd: opts.cwd });
  const synced = loadSyncedRegistry(cfg.registry.base_folder);
  const bySlug = new Map<string, ReturnType<typeof loadSyncedRegistry> extends infer R ? (R extends null ? never : R) : never>();
  if (synced) for (const e of synced.repositories) bySlug.set(e.slug, e as never);

  const rows = cfg.repositories.map((r) => {
    const slug = r.url.split('/').pop()?.replace(/\.git$/i, '') ?? '';
    const s = synced?.repositories.find((x) => x.url === r.url);
    return {
      url: r.url,
      slug,
      default_branch: r.default_branch,
      status: s?.sync_status ?? '(not synced)',
      last_synced_at: s?.last_synced_at ?? '',
    };
  });

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const widths = {
    url: Math.max(3, ...rows.map((r) => r.url.length)),
    branch: Math.max(7, ...rows.map((r) => r.default_branch.length)),
    status: Math.max(6, ...rows.map((r) => String(r.status).length)),
  };

  const head =
    'URL'.padEnd(widths.url) +
    '  ' + 'BRANCH'.padEnd(widths.branch) +
    '  ' + 'STATUS'.padEnd(widths.status) +
    '  LAST SYNCED';
  console.log(chalk.bold(head));

  for (const r of rows) {
    const statusColor =
      r.status === 'ok' ? chalk.green :
      r.status === 'missing_gaggle_md' ? chalk.yellow :
      r.status === 'error' ? chalk.red :
      chalk.gray;
    console.log(
      r.url.padEnd(widths.url) +
      '  ' + r.default_branch.padEnd(widths.branch) +
      '  ' + statusColor(String(r.status).padEnd(widths.status)) +
      '  ' + r.last_synced_at,
    );
  }
  if (!synced) console.log(chalk.gray('\n  (No registry.synced.yaml — run `gaggle sync`.)'));
}
