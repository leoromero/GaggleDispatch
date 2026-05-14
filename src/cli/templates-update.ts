/**
 * `gaggle templates update` — overwrite workflow templates with the bundled defaults.
 */

import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './common.ts';
import { writeDefaultTemplates, TEMPLATE_NAMES } from './templates-default.ts';

export async function runTemplatesUpdate(opts: { cwd?: string; dry?: boolean }): Promise<void> {
  const cfg = loadConfig({ cwd: opts.cwd });
  const dir = cfg.workflow_templates.path;

  if (opts.dry) {
    console.log(chalk.bold('Dry run — no files written:'));
    for (const name of TEMPLATE_NAMES) {
      const exists = existsSync(join(dir, name));
      console.log(exists
        ? chalk.yellow(`  ~ ${name}  (would overwrite)`)
        : chalk.green(`  + ${name}  (new)`),
      );
    }
    return;
  }

  const { written } = writeDefaultTemplates(dir, true);

  for (const name of written) {
    console.log(chalk.green(`  ✓ updated  ${name}`));
  }

  console.log('');
  console.log(chalk.bold(`Updated ${written.length} template(s) in ${dir}`));
  console.log(chalk.dim('Templates will be pushed to all repos automatically on the next dispatch.'));
}
