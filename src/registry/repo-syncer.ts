/**
 * Repo Syncer (Section 3.1 #4, 6.6, 6.7, 6.8).
 *
 * Maintains `<base_folder>/repos/<slug>/` clones and writes
 * `<base_folder>/registry.synced.yaml` atomically. Validates name uniqueness
 * (repository alias + component names). Per-repo failures are captured as
 * `sync_status` and do NOT abort the pass.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RepoSyncError } from '../domain/errors.ts';
import type {
  ServiceConfig,
  SourceRegistryEntry,
  SyncedRegistry,
  SyncedRegistryRepoEntry,
} from '../domain/types.ts';
import { logger } from '../util/logger.ts';
import { commandExists, run, runOrThrow } from '../util/subprocess.ts';
import { deriveRepoSlug, parseGithubOwnerRepo } from '../util/paths.ts';
import { readSymphonyMdAt } from './symphony-md.ts';
import { loadSyncedRegistry, reposBaseDir, writeSyncedRegistry } from './synced-registry.ts';
import { withLock } from '../util/lock.ts';

export interface SyncOptions {
  /** Sync only the given slug (others are left as-is). */
  onlySlug?: string;
  /** Quiet mode for CLI: suppress per-repo info logs. */
  quiet?: boolean;
}

export interface SyncResult {
  registry: SyncedRegistry;
  ok: number;
  errors: number;
  missing: number;
  per_repo: SyncedRegistryRepoEntry[];
}

export async function ensureGhAvailable(): Promise<void> {
  if (!(await commandExists('gh'))) {
    throw new RepoSyncError("'gh' CLI not found in PATH. Install via https://cli.github.com/.");
  }
}

async function getRemoteSha(url: string, branch: string): Promise<string> {
  const { owner, repo } = parseGithubOwnerRepo(url);
  const r = await run(['gh', 'api', `repos/${owner}/${repo}/commits/${branch}`, '--jq', '.sha']);
  if (r.exitCode !== 0) {
    throw new RepoSyncError(`gh api failed for ${url}@${branch}: ${r.stderr.trim().slice(0, 500)}`);
  }
  const sha = r.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new RepoSyncError(`gh api returned invalid SHA '${sha}' for ${url}@${branch}`);
  }
  return sha;
}

async function gitClone(url: string, branch: string, dest: string): Promise<void> {
  // Use `gh repo clone` so private repositories work with the user's existing
  // gh auth (SSH or HTTPS, whichever they configured). Falls back to plain
  // `git clone` when gh is unavailable (e.g. inside test sandboxes that shim
  // gh to satisfy `gh api` only).
  const { owner, repo } = parseGithubOwnerRepo(url);
  const ghAvailable = await commandExists('gh');
  if (ghAvailable) {
    const result = await run(['gh', 'repo', 'clone', `${owner}/${repo}`, dest, '--', '--branch', branch]);
    if (result.exitCode === 0) return;
    // gh shim or unsupported invocation → fall through to git clone
  }
  await runOrThrow(['git', 'clone', '--branch', branch, url, dest]);
}

async function gitPullFf(checkout: string, branch: string): Promise<void> {
  await runOrThrow(['git', '-C', checkout, 'pull', '--ff-only', 'origin', branch]);
}

async function gitCurrentSha(checkout: string): Promise<string | null> {
  const r = await run(['git', '-C', checkout, 'rev-parse', 'HEAD']);
  if (r.exitCode !== 0) return null;
  return r.stdout.trim();
}

interface ProcessResult {
  entry: SyncedRegistryRepoEntry;
}

async function processRepository(
  cfg: ServiceConfig,
  src: SourceRegistryEntry,
  prior: SyncedRegistryRepoEntry | undefined,
  quiet: boolean,
): Promise<ProcessResult> {
  const slug = deriveRepoSlug(src.url);
  const local_path = join(reposBaseDir(cfg.registry.base_folder), slug);

  const baseEntry: SyncedRegistryRepoEntry = {
    url: src.url,
    default_branch: src.default_branch,
    slug,
    local_path,
    last_synced_at: prior?.last_synced_at ?? null,
    last_commit_sha: prior?.last_commit_sha ?? null,
    sync_status: 'pending',
    sync_error: null,
    frontmatter: prior?.frontmatter ?? null,
    narrative: prior?.narrative ?? null,
  };

  try {
    let remoteSha: string;
    try {
      remoteSha = await getRemoteSha(src.url, src.default_branch);
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn('Remote SHA fetch failed; keeping last-known-good entry', { url: src.url, error: msg });
      return {
        entry: { ...baseEntry, sync_status: 'error', sync_error: msg },
      };
    }

    if (!existsSync(local_path)) {
      mkdirSync(reposBaseDir(cfg.registry.base_folder), { recursive: true });
      if (!quiet) logger.info('Cloning repository', { url: src.url, branch: src.default_branch, dest: local_path });
      await gitClone(src.url, src.default_branch, local_path);
    } else if (prior?.last_commit_sha !== remoteSha) {
      if (!quiet) logger.info('Pulling repository', { url: src.url, branch: src.default_branch });
      try {
        await gitPullFf(local_path, src.default_branch);
      } catch (err) {
        const msg = (err as Error).message;
        return { entry: { ...baseEntry, sync_status: 'error', sync_error: `git pull --ff-only failed: ${msg}` } };
      }
    } else if (!quiet) {
      logger.debug('Repository up-to-date', { url: src.url, sha: remoteSha });
    }

    const headSha = (await gitCurrentSha(local_path)) ?? remoteSha;

    const sympPath = join(local_path, 'symphony.md');
    if (!existsSync(sympPath)) {
      return {
        entry: {
          ...baseEntry,
          last_synced_at: new Date().toISOString(),
          last_commit_sha: headSha,
          sync_status: 'missing_symphony_md',
          sync_error: 'No symphony.md found at repository root.',
          frontmatter: null,
          narrative: null,
        },
      };
    }

    let parsed;
    try {
      parsed = readSymphonyMdAt(sympPath);
    } catch (err) {
      const msg = (err as Error).message;
      return {
        entry: {
          ...baseEntry,
          last_synced_at: new Date().toISOString(),
          last_commit_sha: headSha,
          sync_status: 'error',
          sync_error: msg,
        },
      };
    }
    if (!parsed) {
      return {
        entry: {
          ...baseEntry,
          last_synced_at: new Date().toISOString(),
          last_commit_sha: headSha,
          sync_status: 'missing_symphony_md',
          sync_error: 'symphony.md present but unreadable',
        },
      };
    }

    return {
      entry: {
        ...baseEntry,
        last_synced_at: new Date().toISOString(),
        last_commit_sha: headSha,
        sync_status: 'ok',
        sync_error: null,
        frontmatter: parsed.frontmatter,
        narrative: parsed.narrative,
      },
    };
  } catch (err) {
    return {
      entry: {
        ...baseEntry,
        sync_status: 'error',
        sync_error: (err as Error).message,
      },
    };
  }
}

/** Validate uniqueness of repo `name` and component `name` across the merged set. */
export function applyNameCollisions(entries: SyncedRegistryRepoEntry[]): SyncedRegistryRepoEntry[] {
  const seenRepoName = new Map<string, string>(); // name -> winner URL
  const seenComponent = new Map<string, string>(); // component name -> winner URL

  return entries.map((e) => {
    if (e.sync_status !== 'ok' || !e.frontmatter) return e;

    const repoName = e.frontmatter.name;
    if (seenRepoName.has(repoName)) {
      const winner = seenRepoName.get(repoName)!;
      const msg =
        `Repository name collision: "${repoName}" is already used by ${winner} (winner). ` +
        `Resolution: rename the 'name' field in this repository's symphony.md.`;
      logger.error(msg, { url: e.url });
      return { ...e, sync_status: 'error', sync_error: msg };
    }
    seenRepoName.set(repoName, e.url);

    for (const c of e.frontmatter.components) {
      if (seenComponent.has(c.name)) {
        const winner = seenComponent.get(c.name)!;
        const msg =
          `Component name collision: "${c.name}" is declared by both "${winner}" (winner) and ` +
          `"${e.frontmatter.name}" (this repository, ${e.url}). ` +
          `Resolution: rename the component in this repository's symphony.md to a unique name.`;
        logger.error(msg, { url: e.url });
        return { ...e, sync_status: 'error', sync_error: msg };
      }
    }
    for (const c of e.frontmatter.components) {
      seenComponent.set(c.name, e.url);
    }
    return e;
  });
}

/** Run a single Repo Syncer pass. Holds the file lock for the write step. */
export async function runSyncPass(cfg: ServiceConfig, opts: SyncOptions = {}): Promise<SyncResult> {
  await ensureGhAvailable();
  mkdirSync(cfg.registry.base_folder, { recursive: true });
  mkdirSync(reposBaseDir(cfg.registry.base_folder), { recursive: true });

  const prior = loadSyncedRegistry(cfg.registry.base_folder);
  const priorBySlug = new Map<string, SyncedRegistryRepoEntry>();
  if (prior) for (const r of prior.repositories) priorBySlug.set(r.slug, r);

  // Detect duplicate slugs at sync time (Section 5.3.10 + 6.6 last row).
  const slugs = new Set<string>();
  for (const r of cfg.repositories) {
    const slug = deriveRepoSlug(r.url);
    if (slugs.has(slug)) {
      throw new RepoSyncError(
        `Two registered repositories produce the same slug '${slug}'. Operator must rename one repository's URL.`,
      );
    }
    slugs.add(slug);
  }

  const entries: SyncedRegistryRepoEntry[] = [];
  for (const src of cfg.repositories) {
    const slug = deriveRepoSlug(src.url);
    if (opts.onlySlug && opts.onlySlug !== slug) {
      const carry = priorBySlug.get(slug);
      if (carry) entries.push(carry);
      else
        entries.push({
          url: src.url,
          default_branch: src.default_branch,
          slug,
          local_path: join(reposBaseDir(cfg.registry.base_folder), slug),
          last_synced_at: null,
          last_commit_sha: null,
          sync_status: 'pending',
          sync_error: null,
          frontmatter: null,
          narrative: null,
        });
      continue;
    }

    const { entry } = await processRepository(cfg, src, priorBySlug.get(slug), !!opts.quiet);
    entries.push(entry);
  }

  const finalEntries = applyNameCollisions(entries);

  const registry: SyncedRegistry = {
    synced_at: new Date().toISOString(),
    repositories: finalEntries,
  };

  await withLock(join(cfg.registry.base_folder, '.gaggle.lock'), 'gaggle sync', async () => {
    writeSyncedRegistry(cfg.registry.base_folder, registry);
  });

  const ok = finalEntries.filter((e) => e.sync_status === 'ok').length;
  const errors = finalEntries.filter((e) => e.sync_status === 'error').length;
  const missing = finalEntries.filter((e) => e.sync_status === 'missing_symphony_md').length;

  if (!opts.quiet) {
    logger.info('Sync pass complete', { ok, errors, missing, total: finalEntries.length });
  }

  return { registry, ok, errors, missing, per_repo: finalEntries };
}

/** Long-running periodic syncer. */
export interface SyncerHandle {
  stop: () => void;
  triggerNow: () => Promise<SyncResult | null>;
}

export function startPeriodicSyncer(cfg: ServiceConfig): SyncerHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<SyncResult | null> | null = null;

  const trigger = async (): Promise<SyncResult | null> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        return await runSyncPass(cfg, { quiet: true });
      } catch (err) {
        logger.error('Periodic sync pass failed', { error: (err as Error).message });
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const schedule = () => {
    if (stopped) return;
    if (cfg.registry.sync_interval_ms <= 0) return;
    timer = setTimeout(async () => {
      await trigger();
      schedule();
    }, cfg.registry.sync_interval_ms);
  };

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    triggerNow: trigger,
  };
}
