/**
 * The CLI entry point loads and registers a coherent command tree.
 *
 * This exists because a merge put two `program.command('doctor')` registrations
 * ~100 lines apart in `src/cli/index.ts`. Commander throws on a duplicate at
 * registration time, and registration is module-level, so *every* `gaggle`
 * invocation died at import — `start`, `nest start`, `doctor`, all of it.
 *
 * Nothing caught it. `tsc` cannot: it is a runtime check. `bun build` cannot:
 * bundling does not execute. And the whole suite passed, because no test
 * imported this file — `cli-control.test.ts` reaches for the command modules
 * directly. A thousand green tests and a binary that would not start.
 *
 * So: actually import it, and actually walk the tree.
 */

import { describe, expect, test } from 'bun:test';

describe('the CLI entry point', () => {
  test('imports without throwing', async () => {
    // The import *is* the assertion — a duplicate command, a bad option spec,
    // or a broken import chain all throw here.
    const mod = await import('../cli/index.ts');
    expect(mod).toBeDefined();
  });

  test('registers every command exactly once, at every depth', async () => {
    const { program } = await import('../cli/index.ts');

    /** Full paths, so `db migrate` and `repo add` are checked too. */
    const paths: string[] = [];
    const walk = (cmd: { name(): string; commands: readonly unknown[] }, prefix: string): void => {
      for (const raw of cmd.commands) {
        const sub = raw as { name(): string; commands: readonly unknown[] };
        const path = prefix ? `${prefix} ${sub.name()}` : sub.name();
        paths.push(path);
        walk(sub, path);
      }
    };
    walk(program as never, '');

    const seen = new Set<string>();
    const duplicated = paths.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
    expect(duplicated).toEqual([]);

    // A floor, so a refactor that silently empties the tree fails here rather
    // than passing vacuously.
    expect(paths.length).toBeGreaterThan(10);
  });

  test('the commands an operator is told to run are present', async () => {
    const { program } = await import('../cli/index.ts');
    const top = (program as unknown as { commands: Array<{ name(): string }> }).commands.map((c) =>
      c.name(),
    );
    // The README's first-run sequence, plus the two the docs point at when
    // something is wrong.
    for (const name of ['init', 'setup', 'repo', 'sync', 'status', 'start', 'doctor', 'db']) {
      expect(top, `\`gaggle ${name}\` is documented but not registered`).toContain(name);
    }
  });
});
