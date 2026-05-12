/**
 * `gaggle repo add <url>` (Section 21.3).
 * Single canonical entry point for mutating WORKFLOW.md `repositories` list.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import * as YAML from 'yaml';
import chalk from 'chalk';
import { resolveWorkflowPath, splitFrontMatter } from '../config/loader.ts';
import { withLock } from '../util/lock.ts';
import { run } from '../util/subprocess.ts';
import { deriveRepoSlug, parseGithubOwnerRepo } from '../util/paths.ts';
import { fatal, info, success } from './common.ts';

export interface RepoAddOptions {
  url: string;
  defaultBranch?: string;
  noProbe?: boolean;
  cwd?: string;
}

async function probeDefaultBranch(url: string): Promise<string | null> {
  try {
    const { owner, repo } = parseGithubOwnerRepo(url);
    const r = await run([
      'gh',
      'repo',
      'view',
      `${owner}/${repo}`,
      '--json',
      'defaultBranchRef',
      '--jq',
      '.defaultBranchRef.name',
    ]);
    if (r.exitCode !== 0) return null;
    const branch = r.stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

export async function runRepoAdd(opts: RepoAddOptions): Promise<void> {
  const cwd = opts.cwd ? resolvePath(opts.cwd) : process.cwd();
  const wfPath = resolveWorkflowPath({ cwd });
  if (!existsSync(wfPath)) fatal(`WORKFLOW.md not found at ${wfPath}`);

  const isHttps = /^https?:\/\/(?:www\.)?github\.com\//i.test(opts.url);
  const isSsh = /^git@[^:]+:[^/]+\//i.test(opts.url);
  if (!isHttps && !isSsh) {
    fatal(`URL must be a GitHub HTTPS URL or SSH URL (git@<host>:owner/repo) — got '${opts.url}'`);
  }
  const slug = deriveRepoSlug(opts.url);
  if (!slug) fatal(`Could not derive a slug from URL '${opts.url}'`);

  // Determine base folder for the lock; we have to read config minimally first.
  const text = readFileSync(wfPath, 'utf8');
  const { config } = splitFrontMatter(text);
  const reg = (config as { registry?: { base_folder?: string } }).registry ?? {};
  if (!reg.base_folder) fatal(`registry.base_folder must be set in WORKFLOW.md`);
  const baseFolder = reg.base_folder.replace(/^~/, process.env.HOME ?? process.env.USERPROFILE ?? '~');

  await withLock(join(baseFolder, '.gaggle.lock'), 'gaggle repo add', async () => {
    // Re-read inside lock to avoid races
    const fresh = readFileSync(wfPath, 'utf8');
    const { config: cfg, prompt_template } = splitFrontMatter(fresh);
    const cfgObj = cfg as Record<string, unknown>;
    const repos = Array.isArray(cfgObj.repositories) ? [...(cfgObj.repositories as Array<{ url: string; default_branch: string }>)] : [];

    if (repos.find((r) => r.url === opts.url)) {
      fatal(`Repository ${opts.url} is already registered.`);
    }
    if (repos.find((r) => deriveRepoSlug(r.url) === slug)) {
      fatal(`A repository with slug '${slug}' is already registered.`);
    }

    let branch = opts.defaultBranch ?? '';
    if (!branch && !opts.noProbe) {
      const probed = await probeDefaultBranch(opts.url);
      if (probed) {
        info(`Detected default branch: ${probed}`);
        branch = probed;
      }
    }
    if (!branch) branch = 'main';

    repos.push({ url: opts.url, default_branch: branch });
    cfgObj.repositories = repos;

    const fmStr = YAML.stringify(cfgObj, { lineWidth: 0 });
    const banner = '<!--\n  Managed by GaggleDispatch (gaggle repo add / gaggle repo remove).\n-->';
    writeFileSync(wfPath, `${banner}\n---\n${fmStr}---\n\n${prompt_template}\n`);

    success(`Added ${opts.url} (default branch: ${branch}) to Source Registry.`);
    console.log(chalk.gray('Next:'));
    console.log(chalk.gray(`  gaggle sync                        # clone and parse gaggle.md`));
    console.log(chalk.gray(`  gaggle repo scaffold ${opts.url}   # if no gaggle.md exists yet`));
  });
}
