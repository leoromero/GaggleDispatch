/**
 * `gaggle repo scaffold <url>` (Section 21.6) and `gaggle scaffold status` (Section 21.7).
 */

import chalk from 'chalk';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { loadConfig, fatal, info, success } from './common.ts';
import { withLock } from '../util/lock.ts';
import { run } from '../util/subprocess.ts';
import { deriveRepoSlug, parseGithubOwnerRepo } from '../util/paths.ts';
import { runSyncPass } from '../registry/repo-syncer.ts';
import { resolveReposDir } from '../registry/synced-registry.ts';
import { loadScaffoldJobs, removeJobBySlug, upsertJob, writeScaffoldJobs } from '../registry/scaffold-jobs.ts';
import type { ScaffoldJob } from '../domain/types.ts';
import { ArchonClient } from '../executor/archon-client.ts';
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
  const jobsBefore = loadScaffoldJobs(cfg.registry.base_folder);
  const existing = jobsBefore.jobs.find((j) => j.slug === slug);
  if (args.async && existing && (existing.last_status === 'running' || existing.last_status === 'paused' || existing.last_status === 'pending')) {
    fatal(
      `A scaffold job is already running for ${slug} (status: ${existing.last_status}, run-id ${existing.run_id ?? '?'}).\n  Run 'gaggle scaffold status' to inspect, or 'gaggle scaffold cancel ${slug}' to clear it.`,
    );
  }

  const branch = args.branch ?? `gaggle/scaffold-${Math.floor(Date.now() / 1000)}`;
  const message = args.message ?? DEFAULT_PROMPT;

  // Sync workflow templates into the checkout so Archon can find gaggle/gaggle-scaffold.
  const { copied, targetDir } = syncWorkflowTemplates(cfg, checkout);
  if (copied > 0) {
    info(`Synced ${copied} workflow template(s) to ${targetDir}`);
  }

  const archonArgs = parseArchonCmd(cfg.executor.command, DEFAULT_SCAFFOLD_WORKFLOW, checkout, message);

  if (args.async) {
    const proc = Bun.spawn(archonArgs, {
      cwd: checkout,
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
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
    await withLock(join(cfg.registry.base_folder, '.gaggle.lock'), 'gaggle repo scaffold', async () => {
      const jobs = loadScaffoldJobs(cfg.registry.base_folder);
      writeScaffoldJobs(cfg.registry.base_folder, upsertJob(jobs, job));
    });

    success(`Launched scaffold for ${slug} (pid ${proc.pid}, branch ${branch}).`);
    info(`Run 'gaggle scaffold status' to check progress.`);
    return;
  }

  // Blocking mode: stream Archon's output to the terminal.
  console.log(chalk.cyan(`Running scaffold for ${slug} (blocking; Ctrl-C to cancel)...`));
  const proc = Bun.spawn(archonArgs, {
    cwd: checkout,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const code = await proc.exited;
  if (code === 0) {
    success(`Scaffold completed for ${slug}.`);
    const prUrl = await resolvePrUrl(args.url, branch);
    if (prUrl) console.log(chalk.gray(`  PR: ${prUrl}`));
    else console.log(chalk.yellow('  Could not resolve PR URL via gh; check the workflow output.'));
  } else {
    fatal(`Archon exited with code ${code}.`);
  }
}

export async function runScaffoldStatus(opts: { cwd?: string; json?: boolean; refreshPr?: boolean }): Promise<void> {
  const cfg = loadConfig({ cwd: opts.cwd });
  const baseFolder = cfg.registry.base_folder;
  let jobs = loadScaffoldJobs(baseFolder);
  if (jobs.jobs.length === 0) {
    if (!opts.json) console.log(chalk.gray('No scaffold jobs.'));
    else console.log('[]');
    return;
  }

  // Single global call: archon workflow status --json
  let archonRuns: Array<{ id: string; working_path?: string; workflow_name?: string; status?: string; started_at?: string }> = [];
  try {
    const tokens = tokenizeCmd(cfg.executor.command);
    const argv = [...tokens.slice(0, -1), 'status', '--json'];
    const r = await run(argv);
    if (r.exitCode === 0 && r.stdout.trim()) {
      try {
        const parsed = JSON.parse(r.stdout);
        if (Array.isArray(parsed)) archonRuns = parsed;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  await withLock(join(baseFolder, '.gaggle.lock'), 'gaggle scaffold status', async () => {
    const fresh = loadScaffoldJobs(baseFolder);
    const updated: typeof fresh.jobs = [];

    for (const job of fresh.jobs) {
      const next = { ...job };
      next.last_polled_at = new Date().toISOString();

      if (next.run_id === null) {
        const candidates = archonRuns.filter(
          (r) =>
            r.working_path === job.checkout_path &&
            r.workflow_name === job.workflow_name &&
            (!r.started_at || Date.parse(r.started_at) >= Date.parse(job.started_at) - 5_000),
        );
        if (candidates.length === 1) {
          next.run_id = candidates[0]!.id;
        } else if (candidates.length > 1) {
          const sorted = candidates.sort((a, b) => Date.parse(b.started_at ?? '') - Date.parse(a.started_at ?? ''));
          next.run_id = sorted[0]!.id;
        } else if (Date.now() - Date.parse(job.started_at) > 30_000) {
          next.last_status = 'unknown';
        }
      }

      if (next.run_id) {
        const live = archonRuns.find((r) => r.id === next.run_id);
        if (live) {
          next.last_status = (live.status as ScaffoldJob['last_status']) ?? next.last_status;
        } else {
          if (next.last_status !== 'completed' && next.last_status !== 'failed' && next.last_status !== 'cancelled') {
            next.last_status = 'completed';
          }
        }
      }

      if ((next.last_status === 'completed' && next.pr_url === null) || opts.refreshPr) {
        const url = await resolvePrUrl(job.url, job.branch);
        next.pr_url = url;
      }

      updated.push(next);
    }
    writeScaffoldJobs(baseFolder, { jobs: updated });
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

  await withLock(join(baseFolder, '.gaggle.lock'), 'gaggle scaffold cancel', async () => {
    const jobs = loadScaffoldJobs(baseFolder);
    const job = jobs.jobs.find((j) => j.slug === args.slug);
    if (!job) fatal(`No scaffold job for slug '${args.slug}'.`);
    if (job!.run_id) {
      try {
        await new ArchonClient(cfg.executor.api_url).abandonRun(job!.run_id);
        info(`Sent abandon to Archon run ${job!.run_id}.`);
      } catch (err) {
        console.log(chalk.yellow(`  Could not abandon run: ${(err as Error).message}`));
      }
    }
    writeScaffoldJobs(baseFolder, removeJobBySlug(jobs, args.slug));
    success(`Removed scaffold job '${args.slug}'.`);
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────
function tokenizeCmd(s: string): string[] {
  const out: string[] = [];
  const re = /(?:[^\s"']+|"([^"]*)"|'([^']*)')+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[0]);
  return out;
}

function parseArchonCmd(commandStr: string, workflow: string, cwd: string, message: string): string[] {
  const tokens = tokenizeCmd(commandStr);
  return [...tokens, workflow, '--cwd', cwd, message];
}

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
