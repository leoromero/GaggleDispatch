/**
 * `gaggle setup` — interactive API key wizard (Section 20).
 */

import chalk from 'chalk';
import { appendFileSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../util/subprocess.ts';

interface KeyDef {
  envVar: string;
  label: string;
  source: string;
  validate: (key: string) => Promise<{ ok: boolean; detail?: string }>;
}

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
        const data = (await res.json()) as { data?: { viewer?: { name?: string; email?: string } }; errors?: unknown[] };
        if (data.errors) return { ok: false };
        const v = data.data?.viewer;
        if (!v) return { ok: false };
        return { ok: true, detail: `Authenticated as ${v.name ?? '?'} (${v.email ?? '?'})` };
      } catch {
        return { ok: false };
      }
    },
  },
  {
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API key',
    source: 'console.anthropic.com → API Keys',
    validate: async (key) => {
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          }),
        });
        if (res.status === 401 || res.status === 403) return { ok: false };
        if (res.status === 400) {
          // Model name might be unavailable; key still likely valid.
          return { ok: true, detail: 'API key accepted (model name not verified)' };
        }
        if (!res.ok) return { ok: false };
        return { ok: true, detail: 'API key accepted (model: claude-sonnet-4-5)' };
      } catch {
        return { ok: false };
      }
    },
  },
];

async function readPasswordHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  // Bun.stdin doesn't have a clean tty raw mode helper at the level we need;
  // use Node's readline with output muted. This works on Win32, macOS, Linux.
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
      // Echo only newlines/carriage returns; replace others with bullet
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

function persistEnvVarUnix(envVar: string, value: string): string {
  const shell = process.env.SHELL ?? '';
  let profile = '';
  if (shell.includes('zsh') && existsSync(join(homedir(), '.zshrc'))) profile = join(homedir(), '.zshrc');
  else if (shell.includes('bash') && existsSync(join(homedir(), '.bashrc'))) profile = join(homedir(), '.bashrc');
  else profile = join(homedir(), '.profile');

  const line = `\nexport ${envVar}="${value.replace(/"/g, '\\"')}"\n`;
  appendFileSync(profile, line, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(profile, 0o600);
  } catch {
    /* ignore */
  }
  return profile;
}

async function persistEnvVarWindows(envVar: string, value: string): Promise<void> {
  // Use PowerShell to set HKCU\Environment user-scoped variable WITHOUT echoing it.
  const escaped = value.replace(/'/g, "''");
  const ps = `[Environment]::SetEnvironmentVariable('${envVar}', '${escaped}', 'User') | Out-Null`;
  const r = await run(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps]);
  if (r.exitCode !== 0) {
    throw new Error(`Failed to persist ${envVar}: ${r.stderr.slice(0, 300)}`);
  }
}

export async function runSetup(opts: { reset?: boolean } = {}): Promise<void> {
  console.log(chalk.bold('\nGaggleDispatch Setup — API Key Configuration'));
  console.log('Keys are stored as user environment variables. They are never logged or displayed.\n');

  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i]!;
    console.log(chalk.cyan(`[${i + 1}/${KEYS.length}] ${k.label}`));
    console.log(chalk.gray(`  Source: ${k.source}`));

    const existing = process.env[k.envVar];
    if (existing && !opts.reset) {
      const ans = await readLine(`  ${k.envVar} is already set. Overwrite? [y/N]: `);
      if (!/^y(es)?$/i.test(ans.trim())) {
        console.log(chalk.gray('  Skipping (kept existing value).\n'));
        continue;
      }
    }

    let success = false;
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
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
      try {
        if (process.platform === 'win32') {
          await persistEnvVarWindows(k.envVar, key);
          console.log(chalk.gray(`  Saved to user environment via [Environment]::SetEnvironmentVariable.`));
        } else {
          const profile = persistEnvVarUnix(k.envVar, key);
          console.log(chalk.gray(`  Appended to ${profile} (chmod 600).`));
        }
        process.env[k.envVar] = key;
        success = true;
      } catch (err) {
        console.log(chalk.red(`  ✗ Persist failed: ${(err as Error).message}`));
      }
    }
    if (!success) {
      console.log(chalk.yellow(`  Skipping ${k.envVar} — you can re-run 'gaggle setup' later.\n`));
    } else {
      console.log('');
    }
  }

  console.log(chalk.bold('Setup complete.'));
  console.log('Restart your terminal (or current shell) for the variables to take effect, then run:\n  gaggle init   (if WORKFLOW.md does not yet exist)\n  gaggle sync\n  gaggle start\n');
}
