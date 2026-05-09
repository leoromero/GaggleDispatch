/**
 * `gaggle init` — bootstrap WORKFLOW.md (Section 21.2).
 */

import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import * as YAML from 'yaml';
import { isInside, expandPath } from '../util/paths.ts';
import { runRepoAdd } from './repo-add.ts';
import { fatal, info, success } from './common.ts';

/**
 * Two input modes:
 *   • TTY (interactive): one shared readline interface, asks each prompt live.
 *   • Non-TTY (piped/scripted): slurps stdin upfront, returns one line per
 *     readLine call. When the queue is empty, defaults are used. This makes
 *     `printf 'a\nb\n...' | gaggle init` deterministic on every platform.
 */
let sharedRl: import('node:readline').Interface | null = null;
let pipedQueue: string[] | null = null;
let pipedQueueLoaded = false;

async function loadPipedAnswers(): Promise<void> {
  if (pipedQueueLoaded) return;
  pipedQueueLoaded = true;
  if (process.stdin.isTTY) return;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve());
    process.stdin.on('error', () => resolve());
  });
  const text = Buffer.concat(chunks).toString('utf8');
  pipedQueue = text.split(/\r?\n/);
  if (pipedQueue.length > 0 && pipedQueue[pipedQueue.length - 1] === '') {
    pipedQueue.pop();
  }
}

async function getRl(): Promise<import('node:readline').Interface> {
  if (sharedRl) return sharedRl;
  const readline = await import('node:readline');
  sharedRl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return sharedRl;
}

function closeRl(): void {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
  }
}

async function readLine(prompt: string, def?: string): Promise<string> {
  await loadPipedAnswers();
  const display = def ? `${prompt} [${def}]: ` : `${prompt}: `;

  if (pipedQueue !== null) {
    const raw = pipedQueue.shift();
    const answer = raw === undefined ? '' : raw.trim();
    process.stdout.write(`${display}${answer === '' ? `<default: ${def ?? ''}>` : answer}\n`);
    return answer || def || '';
  }

  const rl = await getRl();
  return new Promise((resolve) => {
    rl.question(display, (a) => {
      resolve((a ?? '').trim() || def || '');
    });
  });
}

async function readBool(prompt: string, def: boolean): Promise<boolean> {
  const ans = await readLine(`${prompt} [${def ? 'Y/n' : 'y/N'}]`);
  if (!ans) return def;
  return /^y(es)?$/i.test(ans);
}

export async function runInit(opts: { cwd?: string }): Promise<void> {
  const cwd = opts.cwd ? resolvePath(opts.cwd) : process.cwd();
  const workflowPath = join(cwd, 'WORKFLOW.md');

  if (existsSync(workflowPath)) {
    fatal(`WORKFLOW.md already exists at ${workflowPath}. Edit it manually rather than overwriting.`);
  }

  console.log(chalk.bold('\nGaggleDispatch Init — bootstrap a new deployment\n'));

  const projectSlug = await readLine('Linear team key (e.g. SYM)', '');
  if (!projectSlug) fatal('tracker.project_slug is required');

  const activeStatesStr = await readLine(
    'Active states (comma-separated)',
    'Todo, In Progress',
  );
  const terminalStatesStr = await readLine(
    'Terminal states (comma-separated)',
    'Done, Cancelled, Closed',
  );
  const gateWaitingState = await readLine('Gate waiting state (parked lane name; blank to disable)', '');
  const gateResumeState = await readLine('Gate resume state', 'In Progress');

  const defaultBaseFolder =
    process.platform === 'win32'
      ? join(process.env.USERPROFILE ?? 'C:\\', 'gaggle')
      : '~/gaggle';
  let baseFolderInput = '';
  let baseFolderResolved = '';
  while (true) {
    baseFolderInput = await readLine('Base folder (clones + synced registry)', defaultBaseFolder);
    baseFolderResolved = expandPath(baseFolderInput, cwd);
    if (!isAbsolute(baseFolderResolved)) {
      console.log(chalk.red('  Base folder must resolve to an absolute path.'));
      continue;
    }
    if (isInside(baseFolderResolved, cwd)) {
      console.log(chalk.red('  Base folder MUST NOT be inside the GaggleDispatch project directory.'));
      continue;
    }
    break;
  }

  const defaultWorkflow = await readLine('Default Archon workflow', 'symphony/symphony-fix-issue');
  const analyzerModel = await readLine('Claude analyzer model', 'claude-sonnet-4-5');

  const config: Record<string, unknown> = {
    tracker: {
      kind: 'linear',
      api_key: '$LINEAR_API_KEY',
      project_slug: projectSlug,
      active_states: activeStatesStr.split(',').map((s) => s.trim()).filter(Boolean),
      terminal_states: terminalStatesStr.split(',').map((s) => s.trim()).filter(Boolean),
      assigned_to_me: true,
      create_sub_issues: true,
      ...(gateWaitingState ? { gate_waiting_state: gateWaitingState } : {}),
      ...(gateResumeState ? { gate_resume_state: gateResumeState } : {}),
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: '~/gaggle_workspaces' },
    hooks: {
      after_run: 'archon isolation cleanup --merged --cwd . || true',
    },
    agent: {
      max_concurrent_agents: 8,
      max_turns: 30,
      max_retry_backoff_ms: 600_000,
    },
    archon: {
      command: 'archon workflow run',
      turn_timeout_ms: 7_200_000,
      stall_timeout_ms: 600_000,
      default_workflow: defaultWorkflow,
      gate_timeout_ms: 86_400_000,
    },
    workflow_templates: {
      path: 'workflow_templates/',
      target_subdir: 'symphony',
      sync_on_dispatch: true,
      reload_on_change: true,
    },
    claude: {
      api_key: '$ANTHROPIC_API_KEY',
      analyzer_model: analyzerModel,
      analyzer_max_tokens: 2048,
      analyzer_timeout_ms: 45_000,
    },
    registry: {
      base_folder: baseFolderInput,
      sync_interval_ms: 900_000,
      sync_on_startup: true,
      analysis_cache_ttl_ms: 600_000,
    },
    repositories: [],
  };

  // Write the file with empty repositories first (gives the operator a valid file to add to via CLI).
  const banner = '<!--\n  Bootstrapped by `gaggle init`. Edit freely; the `repositories` list is\n  managed by `gaggle repo add` / `gaggle repo remove`.\n-->';
  const fmStr = YAML.stringify(config, { lineWidth: 0 });
  const body =
    `# GaggleDispatch — Issue Analyzer Prompt Body\n\n` +
    `This Markdown body is currently used as documentation only. The Issue Analyzer\n` +
    `assembles its own prompt from the federated registry (RegistryContext + issue).\n`;
  mkdirSync(dirname(workflowPath), { recursive: true });
  writeFileSync(workflowPath, `${banner}\n---\n${fmStr}---\n\n${body}`);
  success(`Created ${workflowPath}`);

  // Prompt for repos and call repo add for each.
  while (true) {
    const url = await readLine('Add a repository? Enter URL or press Enter to finish', '');
    if (!url) break;
    try {
      await runRepoAdd({ url, cwd });
    } catch (err) {
      console.log(chalk.red(`  ✗ ${(err as Error).message}`));
    }
  }

  // Ensure workflow_templates directory exists with examples.
  await ensureDefaultTemplates(join(cwd, 'workflow_templates'));

  console.log('');
  info('Next steps:');
  console.log('  1. gaggle setup     # configure LINEAR_API_KEY and ANTHROPIC_API_KEY');
  console.log('  2. gaggle sync      # clone repos and parse symphony.md files');
  console.log('  3. gaggle start     # start the orchestrator');

  closeRl();
}

async function ensureDefaultTemplates(dir: string): Promise<void> {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  const { writeDefaultTemplates } = await import('./templates-default.ts');
  writeDefaultTemplates(dir);
  info(`Created default workflow templates at ${dir}`);
}
