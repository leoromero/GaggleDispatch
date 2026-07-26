/**
 * `gaggle repo scaffold <url>` (Section 21.6) and `gaggle scaffold status` (Section 21.7).
 */

import chalk from 'chalk';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { loadConfig, fatal, info, success, withStore } from './common.ts';
import { withLock } from '../util/lock.ts';
import { run } from '../util/subprocess.ts';
import { deriveRepoSlug, parseGithubOwnerRepo } from '../util/paths.ts';
import { runSyncPass } from '../registry/repo-syncer.ts';
import { resolveReposDir } from '../registry/synced-registry.ts';
import {
  findScaffoldJob,
  loadScaffoldJobs,
  removeScaffoldJob,
  saveScaffoldJob,
} from '../registry/scaffold-jobs.ts';
import type { ScaffoldJob } from '../domain/types.ts';
import { PostgresStore } from '../executor/store/postgres.ts';
import { GaggleExecutor } from '../executor/engine/index.ts';
import { syncWorkflowTemplates } from '../workspace/templates.ts';

const DEFAULT_SCAFFOLD_WORKFLOW = 'gaggle/gaggle-scaffold';

const DEFAULT_PROMPT = `You are bootstrapping a new repository for the GaggleDispatch AI routing system.
Your goal is to produce a concise self-description so an AI orchestrator can decide which repos to involve when an issue arrives.

STEP 1 — Inspect ONLY files that belong to this repo:
- README.md and top-level directory layout.
- Build/package file (package.json, pyproject.toml, Cargo.toml, go.mod, *.csproj/sln).
- CI/CD workflows (.github/workflows/).
- Infrastructure files (Dockerfile, docker-compose, ecs/, cdk/).
- List external service names from config/env files (do NOT read external service source code).

Answer: (a) what deployable artifacts THIS repo produces, (b) what external services it calls (names only), (c) deployment target and trigger, (d) what kinds of changes land here.

STEP 2 — Produce \`gaggle.md\` at the repo root with:

YAML front matter:
- name: lowercase-with-hyphens slug (REQUIRED)
- description: 2-3 sentences on what this repo does and why (REQUIRED)
- default_workflow: gaggle/gaggle-fix-issue (REQUIRED)
- available_workflows: [gaggle/gaggle-fix-issue, gaggle/gaggle-supervised]
- components: one entry per deployable artifact THIS REPO PRODUCES (REQUIRED)

CRITICAL components ownership rule:
- A component entry belongs here ONLY if its code lives in and is deployed from THIS REPO.
- External services, databases, cloud APIs, and other repos are NOT components — even if this repo talks to them constantly.
- Reference every external dependency ONLY as a plain string inside that component's \`communicates_with\` list.
- WRONG: adding a \`postgresql\` or \`trialmatch-api\` component block.
- RIGHT: \`communicates_with: [postgresql, trialmatch-api]\` inside the component that calls them.

Narrative body (Markdown after the front matter):
- Focus on THIS repo only: how it is built, tested, and deployed.
- Describe external dependencies from THIS repo's perspective (e.g. "calls the TrialMatch API at NEXT_PUBLIC_API_URL") — do NOT describe how those external systems work internally.
- Include: source layout, deployment pipeline, and a table of typical change classes.
- Keep it concise — this is routing context, not a tutorial.

Open a pull request titled "Add gaggle.md (GaggleDispatch self-description)". Do NOT commit directly to the default branch.`;

export interface ScaffoldArgs {
  url: string;
  cwd?: string;
  async?: boolean;
  branch?: string;
  message?: string;
  fromBranch?: string;
}

export async function runRepoScaffold(args: ScaffoldArgs): Promise<void> {
  const cfg = loadConfig({ cwd: args.cwd });
  const slug = deriveRepoSlug(args.url);
  if (!cfg.repositories.find((r) => r.url === args.url)) {
    fatal(`Repository ${args.url} is not registered. Run 'gaggle repo add ${args.url}' first.`);
  }

  // Ensure local checkout exists; if not, sync this single repo.
  const checkout = join(resolveReposDir(cfg), slug);
  if (!existsSync(checkout)) {
    info(`Local checkout for ${slug} not found; syncing this repo first.`);
    await runSyncPass(cfg, { onlySlug: slug, quiet: true });
    if (!existsSync(checkout)) fatal(`Sync did not produce a local checkout at ${checkout}.`);
  }

  // Check for in-flight job.
  const jobsBefore = await withStore(cfg, (st) => loadScaffoldJobs(st));
  const existing = jobsBefore.jobs.find((j) => j.slug === slug);
  if (args.async && existing && (existing.last_status === 'running' || existing.last_status === 'paused' || existing.last_status === 'pending')) {
    fatal(
      `A scaffold job is already running for ${slug} (status: ${existing.last_status}, run-id ${existing.run_id ?? '?'}).\n  Run 'gaggle scaffold status' to inspect, or 'gaggle scaffold cancel ${slug}' to clear it.`,
    );
  }

  const branch = args.branch ?? `gaggle/scaffold-${Math.floor(Date.now() / 1000)}`;
  const message = args.message ?? DEFAULT_PROMPT;

  // Sync workflow templates into the checkout so the engine can resolve
  // gaggle/gaggle-scaffold from .gaggle/workflows/.
  const { copied, targetDir } = syncWorkflowTemplates(cfg, checkout);
  if (copied > 0) {
    info(`Synced ${copied} workflow template(s) to ${targetDir}`);
  }

  const store = new PostgresStore(cfg.executor.database_url, { maxConnections: 3 });
  await store.migrate();
  const executor = new GaggleExecutor({
    store,
    artifactsRoot: join(cfg.registry.base_folder, 'artifacts'),
  });

  const job: ScaffoldJob = {
    slug,
    url: args.url,
    checkout_path: checkout,
    run_id: null,
    workflow_name: DEFAULT_SCAFFOLD_WORKFLOW,
    branch,
    started_at: new Date().toISOString(),
    last_polled_at: null,
    last_status: 'pending',
    pr_url: null,
    last_error: null,
  };

  try {
    const handle = await executor.startRun(
      {
        workflow: DEFAULT_SCAFFOLD_WORKFLOW,
        cwd: checkout,
        message,
        repo_slug: slug,
        base_branch: args.fromBranch,
      },
      args.async ? () => {} : (e) => {
        // Blocking mode mirrors the run to the terminal.
        if (e.type === 'node_started') console.log(chalk.cyan(`▸ ${e.node_id}`));
        else if (e.type === 'node_output') console.log(chalk.gray(`  ${e.line}`));
        else if (e.type === 'node_failed') console.log(chalk.red(`✗ ${e.node_id}: ${e.error}`));
      },
    );

    // The run id is known immediately now, so the job record no longer has to
    // be reconciled later by matching working paths and start times.
    job.run_id = handle.run_id;
    job.last_status = 'running';
    // A single upsert — no lock needed now that this is not a whole-file
    // read-modify-write.
    await saveScaffoldJob(store, job);

    if (args.async) {
      success(`Launched scaffold for ${slug} (run ${handle.run_id.slice(0, 8)}, branch ${branch}).`);
      info(`Run 'gaggle scaffold status' to check progress.`);
      // Detach: the run keeps going, and `scaffold status` follows it.
      return;
    }

    console.log(chalk.cyan(`Running scaffold for ${slug} (blocking; Ctrl-C to cancel)...`));
    await handle.done;

    const final = await executor.getRun(handle.run_id);
    if (final?.status === 'completed') {
      success(`Scaffold completed for ${slug}.`);
      const prUrl = await resolvePrUrl(args.url, branch);
      if (prUrl) console.log(chalk.gray(`  PR: ${prUrl}`));
      else console.log(chalk.yellow('  Could not resolve PR URL via gh; check the workflow output.'));
    } else {
      fatal(`Scaffold run ${final?.status ?? 'failed'}.`);
    }
  } finally {
    if (!args.async) await store.close();
  }
}

export async function runScaffoldStatus(opts: { cwd?: string; json?: boolean; refreshPr?: boolean }): Promise<void> {
  const cfg = loadConfig({ cwd: opts.cwd });
  const baseFolder = cfg.registry.base_folder;
  let jobs = await withStore(cfg, (st) => loadScaffoldJobs(st));
  if (jobs.jobs.length === 0) {
    if (!opts.json) console.log(chalk.gray('No scaffold jobs.'));
    else console.log('[]');
    return;
  }

  // Run ids are recorded at launch, so status is a direct lookup rather than
  // the working-path-and-timestamp matching the CLI used to need.
  const store = new PostgresStore(cfg.executor.database_url, { maxConnections: 2 });
  const executor = new GaggleExecutor({
    store,
    artifactsRoot: join(baseFolder, 'artifacts'),
  });

  await withStore(cfg, async (store) => {
    const executor = new GaggleExecutor({
      store,
      artifactsRoot: join(baseFolder, 'artifacts'),
    });
    const fresh = await loadScaffoldJobs(store);
    const updated: typeof fresh.jobs = [];

    for (const job of fresh.jobs) {
      const next = { ...job };
      next.last_polled_at = new Date().toISOString();

      if (next.run_id === null) {
        // A job with no run id never got off the ground — the launch threw
        // before the row was written. Previously this was the normal case,
        // because the run id had to be discovered after the fact.
        if (Date.now() - Date.parse(job.started_at) > 30_000) {
          next.last_status = 'unknown';
        }
      } else {
        const live = await executor.getRun(next.run_id);
        if (live) {
          next.last_status = live.status as ScaffoldJob['last_status'];
          if (live.status === 'failed') {
            next.last_error = String(live.metadata.cancel_reason ?? 'run failed');
          }
        } else {
          // The row is gone (pruned, or a different database) — do not leave
          // the job claiming to be running forever.
          next.last_status = 'unknown';
        }
      }

      if ((next.last_status === 'completed' && next.pr_url === null) || opts.refreshPr) {
        const url = await resolvePrUrl(job.url, job.branch);
        next.pr_url = url;
      }

      updated.push(next);
    }
    for (const j of updated) await saveScaffoldJob(store, j);
    jobs = { jobs: updated };
  });

  if (opts.json) {
    console.log(JSON.stringify(jobs.jobs, null, 2));
    return;
  }

  console.log(chalk.bold('SLUG'.padEnd(30) + 'STATUS'.padEnd(12) + 'RUN ID'.padEnd(14) + 'AGE'.padEnd(8) + 'PR URL'));
  for (const j of jobs.jobs) {
    const age = ageFromIso(j.started_at);
    const runId = j.run_id ? j.run_id.slice(0, 8) : '—';
    console.log(j.slug.padEnd(30) + j.last_status.padEnd(12) + runId.padEnd(14) + age.padEnd(8) + (j.pr_url ?? '—'));
  }
}

export async function runScaffoldCancel(args: { slug: string; cwd?: string }): Promise<void> {
  const cfg = loadConfig({ cwd: args.cwd });
  const baseFolder = cfg.registry.base_folder;

  await withStore(cfg, async (store) => {
    const job = await findScaffoldJob(store, args.slug);
    if (!job) fatal(`No scaffold job for slug '${args.slug}'.`);
    if (job!.run_id) {
      try {
        await new GaggleExecutor({
          store,
          artifactsRoot: join(cfg.registry.base_folder, 'artifacts'),
        }).abandon(job!.run_id);
        info(`Abandoned run ${job!.run_id}.`);
      } catch (err) {
        console.log(chalk.yellow(`  Could not abandon run: ${(err as Error).message}`));
      }
    }
    await removeScaffoldJob(store, args.slug);
    success(`Removed scaffold job '${args.slug}'.`);
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────
async function resolvePrUrl(url: string, branch: string): Promise<string | null> {
  try {
    const { owner, repo } = parseGithubOwnerRepo(url);
    const r = await run([
      'gh',
      'pr',
      'list',
      '--head',
      branch,
      '--repo',
      `${owner}/${repo}`,
      '--state',
      'all',
      '--json',
      'url,createdAt',
    ]);
    if (r.exitCode !== 0) return null;
    const arr = JSON.parse(r.stdout || '[]') as Array<{ url: string; createdAt: string }>;
    if (arr.length === 0) return null;
    arr.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return arr[0]!.url;
  } catch {
    return null;
  }
}

function ageFromIso(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '?';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

// Used by scaffold to ensure the dir exists if we ever need it; not currently called.
export function _ensureBaseFolder(cfg: ReturnType<typeof loadConfig>): void {
  mkdirSync(cfg.registry.base_folder, { recursive: true });
  resolvePath(cfg.registry.base_folder); // touch to silence unused
}
