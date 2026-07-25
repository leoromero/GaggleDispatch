/**
 * `gaggle workflow list` and `gaggle workflow validate`.
 *
 * Validation is the cheap feedback loop for workflow authors: catching a
 * dangling `$node.output` here costs a second, catching it at runtime costs
 * whatever the preceding nodes already spent.
 */

import chalk from 'chalk';
import { resolve } from 'node:path';
import { scanWorkflows, workflowSearchPaths } from '../executor/engine/registry.ts';
import { validateWorkflow } from '../executor/engine/validate.ts';
import type { Diagnostic } from '../executor/engine/schema.ts';

export interface WorkflowCliOptions {
  cwd?: string;
  /** Extra directory to search, on top of `<cwd>/.gaggle/workflows`. */
  dir?: string;
  json?: boolean;
}

function searchPaths(opts: WorkflowCliOptions): string[] {
  const checkout = opts.cwd ? resolve(opts.cwd) : process.cwd();
  return workflowSearchPaths(checkout, opts.dir ? [resolve(opts.dir)] : []);
}

export async function runWorkflowList(opts: WorkflowCliOptions = {}): Promise<void> {
  const { entries, failures } = scanWorkflows(searchPaths(opts));

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          workflows: entries.map((e) => ({
            name: e.name,
            description: e.description,
            path: e.path,
            nodes: e.workflow.nodes.length,
          })),
          errors: failures.map((f) => ({ path: f.path, error: f.error })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (entries.length === 0 && failures.length === 0) {
    console.log(chalk.gray('No workflows found. Looked in:'));
    for (const p of searchPaths(opts)) console.log(chalk.gray(`  ${p}`));
    return;
  }

  console.log(chalk.bold(`${entries.length} workflow(s)\n`));
  for (const e of entries) {
    const firstLine = e.description.split('\n')[0]?.trim() ?? '';
    console.log(`  ${chalk.cyan(e.name.padEnd(30))} ${chalk.gray(`${e.workflow.nodes.length} nodes`)}`);
    if (firstLine) console.log(`  ${' '.repeat(30)} ${chalk.gray(firstLine)}`);
  }
  if (failures.length > 0) {
    console.log(chalk.red(`\n${failures.length} file(s) failed to load:`));
    for (const f of failures) console.log(`  ${chalk.red('✗')} ${f.path}\n    ${chalk.gray(f.error)}`);
  }
  console.log();
}

function printDiagnostics(prefix: string, items: Diagnostic[]): void {
  for (const d of items) {
    const mark = d.level === 'error' ? chalk.red('✗') : chalk.yellow('!');
    const where = d.node_id ? chalk.gray(`[${d.node_id}] `) : '';
    console.log(`  ${mark} ${prefix}${where}${d.message}`);
  }
}

export async function runWorkflowValidate(
  name: string | undefined,
  opts: WorkflowCliOptions = {},
): Promise<void> {
  const { entries, failures } = scanWorkflows(searchPaths(opts));
  const targets = name ? entries.filter((e) => e.name === name) : entries;

  if (name && targets.length === 0 && !failures.some((f) => f.path.includes(name))) {
    console.error(chalk.red(`✗ workflow '${name}' not found`));
    if (entries.length > 0) {
      console.error(chalk.gray(`  Available: ${entries.map((e) => e.name).sort().join(', ')}`));
    }
    process.exit(1);
  }

  let errorCount = 0;
  let warningCount = 0;
  const report: Record<string, unknown>[] = [];

  for (const f of failures) {
    errorCount++;
    if (!opts.json) {
      console.log(chalk.red(`✗ ${f.path}`));
      console.log(chalk.gray(`  ${f.error}`));
      printDiagnostics('', f.diagnostics);
    }
    report.push({ path: f.path, ok: false, error: f.error, diagnostics: f.diagnostics });
  }

  for (const entry of targets) {
    const res = validateWorkflow(entry.workflow);
    const all = [...entry.warnings, ...res.warnings];
    errorCount += res.errors.length;
    warningCount += all.length;

    if (opts.json) {
      report.push({
        name: entry.name,
        path: entry.path,
        ok: res.ok,
        errors: res.errors,
        warnings: all,
      });
      continue;
    }

    const mark = res.ok ? chalk.green('✓') : chalk.red('✗');
    console.log(`${mark} ${chalk.cyan(entry.name)} ${chalk.gray(`(${entry.workflow.nodes.length} nodes)`)}`);
    printDiagnostics('', res.errors);
    printDiagnostics('', all);
  }

  if (opts.json) {
    console.log(JSON.stringify({ results: report, errors: errorCount, warnings: warningCount }, null, 2));
  } else {
    console.log();
    console.log(
      errorCount === 0
        ? chalk.green(`✓ ${targets.length} workflow(s) valid`) +
            (warningCount > 0 ? chalk.yellow(` (${warningCount} warning(s))`) : '')
        : chalk.red(`✗ ${errorCount} error(s) across ${targets.length + failures.length} workflow(s)`),
    );
  }

  if (errorCount > 0) process.exit(1);
}
