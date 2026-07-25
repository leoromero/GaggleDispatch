/**
 * `gaggle setup` — interactive API key wizard (Section 20).
 *
 * Keys are stored in <base_folder>/.env (next to the synced registry and repo
 * clones). This file is scoped to one gaggle deployment, loaded automatically
 * at startup by buildServiceConfig, and never touched by the project repo's
 * own .env. Process environment variables always take precedence.
 */

import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import * as YAML from 'yaml';
import { readFileSync } from 'node:fs';
import { mergeEnvFile, parseEnvFile } from '../util/env-file.ts';
import { expandPath } from '../util/paths.ts';
import { splitFrontMatter } from '../config/loader.ts';

interface KeyDef {
  envVar: string;
  label: string;
  source: string;
  validate: (key: string) => Promise<{ ok: boolean; detail?: string }>;
}

// ANTHROPIC_API_KEY is intentionally omitted — Claude Code manages Anthropic
// auth through its own credential store. GaggleDispatch inherits it from the
// Claude Code session.
const KEYS: KeyDef[] = [
  {
    envVar: 'LINEAR_API_KEY',
    label: 'Linear API key',
    source: 'Linear → Settings → API → Personal API keys',
    validate: async (key) => {
      try {
        const res = await fetch('https://api.linear.app/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: key },
          body: JSON.stringify({ query: '{ viewer { id name email } }' }),
        });
        if (!res.ok) return { ok: false };
        const data = (await res.json()) as {
          data?: { viewer?: { name?: string; email?: string } };
          errors?: unknown[];
        };
        if (data.errors) return { ok: false };
        const v = data.data?.viewer;
        if (!v) return { ok: false };
        return { ok: true, detail: `Authenticated as ${v.name ?? '?'} (${v.email ?? '?'})` };
      } catch {
        return { ok: false };
      }
    },
  },
];

async function readPasswordHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return new Promise<string>((resolve) => {
    // @ts-ignore — internal but stable for this purpose
    const orig = rl._writeToOutput?.bind(rl);
    // @ts-ignore
    rl._writeToOutput = (s: string) => {
      if (s === '\n' || s === '\r\n' || s === '\r') {
        orig?.(s);
      } else {
        orig?.('•'.repeat([...s].length));
      }
    };
    rl.question('', (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => rl.question('', (a) => { rl.close(); resolve(a); }));
}

/** Resolve the base_folder path from WORKFLOW.md without full config validation. */
function resolveBaseFolder(cwd: string): string | null {
  const workflowPath = resolvePath(cwd, 'WORKFLOW.md');
  if (!existsSync(workflowPath)) return null;
  try {
    const { config } = splitFrontMatter(readFileSync(workflowPath, 'utf8'));
    const reg = config.registry;
    if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return null;
    const raw = (reg as Record<string, unknown>).base_folder;
    if (typeof raw !== 'string' || !raw) return null;
    return expandPath(raw, cwd);
  } catch {
    return null;
  }
}

export async function runSetup(opts: { reset?: boolean; cwd?: string } = {}): Promise<void> {
  const cwd = opts.cwd ? resolvePath(opts.cwd) : process.cwd();
  const baseFolder = resolveBaseFolder(cwd);
  const envPath = baseFolder ? join(baseFolder, '.env') : null;

  console.log(chalk.bold('\nGaggleDispatch Setup — API Key Configuration'));
  if (envPath) {
    console.log(chalk.gray(`Keys will be stored in: ${envPath}`));
  } else {
    console.log(chalk.yellow(
      'WORKFLOW.md not found in current directory.\n' +
      'Run `gaggle init` first to create it, then re-run `gaggle setup`.\n' +
      'Keys entered now will only apply to this session.',
    ));
  }
  console.log(chalk.gray('Keys are never logged or displayed. Process environment takes precedence.\n'));

  // Load existing .env so we can show "already set" prompts.
  const existingEnv: Record<string, string> = envPath && existsSync(envPath)
    ? parseEnvFile(readFileSync(envPath, 'utf8'))
    : {};

  const collected: Record<string, string> = {};

  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i]!;
    console.log(chalk.cyan(`[${i + 1}/${KEYS.length}] ${k.label}`));
    console.log(chalk.gray(`  Source: ${k.source}`));

    const alreadySet = k.envVar in existingEnv && existingEnv[k.envVar] !== '';
    if (alreadySet && !opts.reset) {
      const ans = await readLine(`  ${k.envVar} is already set in .env. Overwrite? [y/N]: `);
      if (!/^y(es)?$/i.test(ans.trim())) {
        console.log(chalk.gray('  Skipping (kept existing value).\n'));
        continue;
      }
    }

    let saved = false;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      const key = (await readPasswordHidden('  Enter key (input hidden): ')).trim();
      if (!key) {
        console.log(chalk.yellow('  Empty input; aborted.'));
        break;
      }
      process.stdout.write('  Validating... ');
      const result = await k.validate(key);
      if (!result.ok) {
        console.log(chalk.red('✗ Validation failed — check the key and try again.'));
        continue;
      }
      console.log(chalk.green(`✓  ${result.detail ?? 'OK'}`));
      collected[k.envVar] = key;
      process.env[k.envVar] = key;
      saved = true;
    }
    if (!saved && !(k.envVar in collected)) {
      console.log(chalk.yellow(`  Skipping ${k.envVar} — you can re-run 'gaggle setup' later.\n`));
    } else {
      console.log('');
    }
  }

  if (Object.keys(collected).length > 0) {
    if (envPath) {
      mergeEnvFile(envPath, collected);
      console.log(chalk.bold('Setup complete.'));
      console.log(chalk.gray(`Keys saved to ${envPath} (mode 600).`));
      console.log('They are loaded automatically the next time any gaggle command runs.\n');
    } else {
      console.log(chalk.bold('Setup complete (session only).'));
      console.log(chalk.yellow('Keys were NOT persisted — run `gaggle init` then `gaggle setup` again to save them.\n'));
    }
  } else {
    console.log(chalk.bold('No changes made.'));
  }
}
