/**
 * Command resolution and the bundled library.
 *
 * The last block is the one that matters: it asserts every `command:` node in
 * the shipped templates resolves. That is the exact dependency the Archon
 * integration had on someone else's command library, and the thing most likely
 * to be discovered missing at node 14 of 22.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommandResolver, BUNDLED_SOURCE } from '../executor/engine/commands.ts';
import { BUNDLED_COMMANDS, BUNDLED_COMMAND_NAMES } from '../executor/engine/bundled-commands.ts';
import { parseWorkflow } from '../executor/engine/loader.ts';
import { validateWorkflow } from '../executor/engine/validate.ts';
import { TEMPLATES } from '../cli/templates-default.ts';

let repo: string;
let commandsDir: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gaggle-cmd-'));
  commandsDir = join(repo, '.gaggle', 'commands');
  mkdirSync(commandsDir, { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const resolver = () => new CommandResolver({ searchDirs: CommandResolver.searchDirsFor(repo) });

describe('CommandResolver', () => {
  test('falls back to the bundled library when the repo has no override', () => {
    const hit = resolver().resolve('code-review-agent');
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe(BUNDLED_SOURCE);
    expect(hit!.prompt.length).toBeGreaterThan(100);
  });

  test('a repo-local file overrides the bundled command', () => {
    writeFileSync(join(commandsDir, 'code-review-agent.md'), '# our own rules');
    const hit = resolver().resolve('code-review-agent');
    expect(hit!.prompt).toBe('# our own rules');
    expect(hit!.source).toContain('.gaggle');
  });

  test('an override can introduce a command the bundle does not have', () => {
    writeFileSync(join(commandsDir, 'house-style.md'), '# house style');
    expect(resolver().resolve('house-style')!.prompt).toBe('# house style');
  });

  test('an unknown command resolves to null rather than throwing', () => {
    expect(resolver().resolve('no-such-command')).toBeNull();
  });

  test('searchDirsFor points at the checkout', () => {
    expect(CommandResolver.searchDirsFor('/repo')[0]).toContain('.gaggle');
  });

  test('a custom bundle can be injected, for tests', () => {
    const r = new CommandResolver({ searchDirs: [], bundled: { only: 'x' } });
    expect(r.resolve('only')!.prompt).toBe('x');
    expect(r.resolve('code-review-agent')).toBeNull();
  });
});

describe('the bundled library', () => {
  test('ships the full review phase', () => {
    expect(BUNDLED_COMMAND_NAMES.sort()).toEqual(
      [
        'code-review-agent',
        'comment-quality-agent',
        'docs-impact-agent',
        'error-handling-agent',
        'issue-completion-report',
        'pr-review-scope',
        'self-fix-all',
        'simplify-changes',
        'synthesize-review',
        'test-coverage-agent',
      ].sort(),
    );
  });

  test('every command has substantive content', () => {
    for (const [name, prompt] of Object.entries(BUNDLED_COMMANDS)) {
      expect(prompt.trim().length, `${name} is too short`).toBeGreaterThan(200);
      expect(prompt.startsWith('#'), `${name} should open with a heading`).toBe(true);
    }
  });

  test('the review agents each write to a distinct artifact file', () => {
    const agents = [
      'code-review-agent',
      'error-handling-agent',
      'test-coverage-agent',
      'comment-quality-agent',
      'docs-impact-agent',
    ];
    const targets = agents.map((a) => {
      const m = BUNDLED_COMMANDS[a]!.match(/review-([a-z-]+)\.md/);
      return m?.[1];
    });
    // Distinct filenames are what lets the agents run concurrently and lets
    // synthesis glob them back up.
    expect(new Set(targets).size).toBe(agents.length);
    expect(targets.every(Boolean)).toBe(true);
  });

  test('synthesis reads the artifacts the agents write', () => {
    const synth = BUNDLED_COMMANDS['synthesize-review']!;
    expect(synth).toContain('$ARTIFACTS_DIR/review-*.md');
    expect(synth).toContain('review-synthesis.md');
  });

  test('self-fix reads what synthesis wrote', () => {
    expect(BUNDLED_COMMANDS['self-fix-all']).toContain('review-synthesis.md');
  });

  test('every variable reference is one the engine actually substitutes', () => {
    // A typo like $ARTIFACT_DIR would silently pass through as literal text.
    const known = new Set([
      'ARGUMENTS', 'USER_MESSAGE', 'WORKFLOW_ID', 'ARTIFACTS_DIR', 'BASE_BRANCH',
      'CONTEXT', 'EXTERNAL_CONTEXT', 'ISSUE_CONTEXT', 'LOOP_USER_INPUT', 'REJECTION_REASON',
    ]);
    for (const [name, prompt] of Object.entries(BUNDLED_COMMANDS)) {
      for (const m of prompt.matchAll(/\$([A-Z][A-Z0-9_]{2,})/g)) {
        expect(known.has(m[1]!), `${name} references unknown variable $${m[1]}`).toBe(true);
      }
    }
  });
});

describe('the shipped templates resolve every command they reference', () => {
  for (const [filename, content] of Object.entries(TEMPLATES)) {
    test(`${filename}`, () => {
      const { workflow } = parseWorkflow(content, `/templates/${filename}`);
      const resolve = (name: string) => resolver().resolve(name)?.source ?? null;

      const res = validateWorkflow(workflow, { resolveCommand: resolve });
      const missing = res.errors.filter((e) => e.message.includes('was not found'));
      expect(missing.map((m) => m.message)).toEqual([]);
      expect(res.ok).toBe(true);
    });
  }

  test('no template still points at an archon- prefixed command', () => {
    for (const [filename, content] of Object.entries(TEMPLATES)) {
      expect(content.includes('command: archon-'), `${filename} still references archon-`).toBe(false);
    }
  });

  test('outward-facing nodes are marked at_most_once', () => {
    // These reach outside the run — a duplicate PR or a duplicate Linear
    // comment is visible to humans and cannot be undone by a retry.
    const expectations: Record<string, string[]> = {
      'gaggle-fix-issue.yaml': ['create-pr', 'report'],
      'gaggle-supervised.yaml': ['create-pr', 'report', 'post-summary'],
    };
    for (const [filename, nodeIds] of Object.entries(expectations)) {
      const { workflow } = parseWorkflow(TEMPLATES[filename]!, `/t/${filename}`);
      for (const id of nodeIds) {
        const node = workflow.nodes.find((n) => n.id === id);
        expect(node, `${filename} has no node '${id}'`).toBeDefined();
        expect(node!.side_effects, `${filename}:${id}`).toBe('at_most_once');
      }
    }
  });
});

// ── worker identity round-trip ──────────────────────────────────────────────

describe('the worker key reaches the run row', () => {
  test('startRun stamps external_key and worker metadata, and allRunLinks reads them back', async () => {
    // This is the seam that replaced gaggle-runs.json. If the worker stops
    // passing the key, recovery silently finds nothing — tests that seed the
    // store directly would still pass, so this asserts the real path.
    const { MemoryStore } = await import('../executor/store/memory.ts');
    const { GaggleExecutor } = await import('../executor/engine/index.ts');
    const { allRunLinks, readRunLink } = await import('../registry/run-registry.ts');

    const dir = mkdtempSync(join(tmpdir(), 'gaggle-link-'));
    try {
      mkdirSync(join(dir, '.gaggle', 'workflows'), { recursive: true });
      writeFileSync(
        join(dir, '.gaggle', 'workflows', 'noop.yaml'),
        'name: noop\ndescription: d\nnodes:\n  - id: a\n    prompt: "x"\n',
      );

      const store = new MemoryStore();
      const executor = new GaggleExecutor({
        store,
        artifactsRoot: join(dir, '.artifacts'),
        ai: async () =>
          ({ text: 'ok', sessionId: null, inputTokens: 0, outputTokens: 0, timedOut: false, cancelled: false }) as never,
      });

      const handle = await executor.startRun(
        {
          workflow: 'noop',
          cwd: dir,
          message: 'm',
          repo_slug: 'trialmatch-be',
          external_key: 'p1__trialmatch-be',
          metadata: {
            worker: { parent_issue_id: 'p1', sub_issue_id: 'sub-be', repo_alias: 'trialmatch-be' },
          },
        },
        () => {},
      );

      // Readable while the run is live.
      const link = await readRunLink(store, 'p1__trialmatch-be');
      expect(link?.run_id).toBe(handle.run_id);
      expect(link?.sub_issue_id).toBe('sub-be');
      expect((await allRunLinks(store))['p1__trialmatch-be']?.parent_issue_id).toBe('p1');

      await handle.done;

      // Once the run finishes the link is gone — the run's own status is the
      // truth, so there is no stale entry to prune.
      expect(await readRunLink(store, 'p1__trialmatch-be')).toBeNull();
      expect(await allRunLinks(store)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
