/**
 * `gaggle repo remove <url|slug>` (Section 21.4).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import * as YAML from 'yaml';
import { resolveWorkflowPath, splitFrontMatter } from '../config/loader.ts';
import { withLock } from '../util/lock.ts';
import { deriveRepoSlug } from '../util/paths.ts';
import { fatal, success } from './common.ts';
import { existsSync as fsExists } from 'node:fs';
import { loadScaffoldJobs } from '../registry/scaffold-jobs.ts';
import chalk from 'chalk';

export async function runRepoRemove(args: { target: string; cwd?: string }): Promise<void> {
  const cwd = args.cwd ? resolvePath(args.cwd) : process.cwd();
  const wfPath = resolveWorkflowPath({ cwd });
  if (!existsSync(wfPath)) fatal(`WORKFLOW.md not found at ${wfPath}`);

  const text = readFileSync(wfPath, 'utf8');
  const { config } = splitFrontMatter(text);
  const reg = (config as { registry?: { base_folder?: string } }).registry ?? {};
  if (!reg.base_folder) fatal(`registry.base_folder must be set in WORKFLOW.md`);
  const baseFolder = reg.base_folder.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? '~');

  await withLock(join(baseFolder, '.gaggle.lock'), 'gaggle repo remove', async () => {
    const fresh = readFileSync(wfPath, 'utf8');
    const { config: cfg, prompt_template } = splitFrontMatter(fresh);
    const cfgObj = cfg as Record<string, unknown>;
    const repos = Array.isArray(cfgObj.repositories) ? [...(cfgObj.repositories as Array<{ url: string; default_branch: string }>)] : [];

    const idx = repos.findIndex((r) => r.url === args.target || deriveRepoSlug(r.url) === args.target);
    if (idx === -1) fatal(`No repository matched '${args.target}' (URL or slug).`);
    const removed = repos[idx]!;
    repos.splice(idx, 1);
    cfgObj.repositories = repos;

    const fmStr = YAML.stringify(cfgObj, { lineWidth: 0 });
    const banner = '<!--\n  Managed by GaggleDispatch (gaggle repo add / gaggle repo remove).\n-->';
    writeFileSync(wfPath, `${banner}\n---\n${fmStr}---\n\n${prompt_template}\n`);
    success(`Removed ${removed.url} from Source Registry. Local checkout (if any) is preserved.`);

    if (fsExists(join(baseFolder, 'scaffold_jobs.yaml'))) {
      const jobs = loadScaffoldJobs(baseFolder);
      const slug = deriveRepoSlug(removed.url);
      if (jobs.jobs.find((j) => j.slug === slug)) {
        console.log(chalk.yellow(`  ⚠ A scaffold job for slug '${slug}' is still tracked in scaffold_jobs.yaml.`));
        console.log(chalk.gray(`    Use 'gaggle scaffold cancel ${slug}' to clear it.`));
      }
    }

    console.log(chalk.gray(`  Run 'gaggle sync' to refresh registry.synced.yaml.`));
  });
}
