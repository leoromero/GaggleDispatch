/**
 * `command:` node resolution.
 *
 * A command is a reusable prompt kept out of the workflow YAML. The library
 * ships compiled into the binary so a freshly registered repo gets the full
 * review phase with no files on disk, and a repo that wants different
 * behaviour overrides a single prompt by dropping a file in
 * `.gaggle/commands/` — rather than forking a 550-line workflow.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_COMMANDS } from './bundled-commands.ts';

export interface ResolvedCommand {
  name: string;
  prompt: string;
  /** File path, or `<bundled>` when it came from the compiled-in library. */
  source: string;
}

export interface CommandResolverOptions {
  /** Directories searched before the bundled library, in precedence order. */
  searchDirs: string[];
  /** Override the bundled set. Tests use this. */
  bundled?: Record<string, string>;
}

export const BUNDLED_SOURCE = '<bundled>';

export class CommandResolver {
  private readonly searchDirs: string[];
  private readonly bundled: Record<string, string>;

  constructor(opts: CommandResolverOptions) {
    this.searchDirs = opts.searchDirs;
    this.bundled = opts.bundled ?? BUNDLED_COMMANDS;
  }

  /** Standard search path for a checkout. */
  static searchDirsFor(checkout: string): string[] {
    return [join(checkout, '.gaggle', 'commands')];
  }

  resolve(name: string): ResolvedCommand | null {
    for (const dir of this.searchDirs) {
      // One level of subfolder grouping, so `review/code-review` works.
      const candidate = join(dir, `${name}.md`);
      if (existsSync(candidate)) {
        return { name, prompt: readFileSync(candidate, 'utf8'), source: candidate };
      }
    }
    const bundled = this.bundled[name];
    if (bundled !== undefined) {
      return { name, prompt: bundled, source: BUNDLED_SOURCE };
    }
    return null;
  }

  /** Every command name available, repo overrides included. */
  list(): string[] {
    return [...new Set(Object.keys(this.bundled))].sort();
  }
}

export class CommandNotFoundError extends Error {
  constructor(name: string, searchDirs: string[]) {
    super(
      `command '${name}' was not found. Looked in ${searchDirs
        .map((d) => join(d, `${name}.md`))
        .join(', ')} and the bundled library.`,
    );
    this.name = 'CommandNotFoundError';
  }
}
