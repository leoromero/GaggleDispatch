/**
 * The CLI surfaces that read the control plane: `gaggle doctor`, `gaggle ps`, and
 * the nest's control-plane wiring.
 *
 * These are what an operator reaches for when something is wrong, so what matters
 * is that they diagnose rather than act — neither doctor nor `ps` migrates, which
 * is what makes them safe to point at a production database — and that every way
 * the database can be missing degrades instead of taking the process down.
 *
 * All three are driven through their real entry points over a temporary
 * WORKFLOW.md. The JSON mode exists precisely so this is possible without scraping
 * colour codes out of a terminal.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../cli/doctor.ts';
import { openHubControlPlane } from '../cli/hub.ts';
import { runPs } from '../cli/status.ts';
import type { HubProcessManager } from '../hub/process-manager.ts';
import { PostgresControlStore } from '../control/store/postgres.ts';

const PG_URL = process.env.TEST_DATABASE_URL ?? '';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gaggle-cli-'));
}

/** A minimal but real project. `databaseUrl` empty means "none configured". */
function project(databaseUrl: string): string {
  const dir = tmp();
  const base = tmp();
  writeFileSync(
    join(dir, 'WORKFLOW.md'),
    `---
tracker:
  kind: linear
  api_key: literal-key
  project_slug: SYM
workflow_templates:
  path: workflow_templates/
${databaseUrl ? `database:\n  url: ${databaseUrl}\n` : ''}registry:
  base_folder: ${base.replace(/\\/g, '\\\\')}
repositories:
  - url: https://github.com/acme/api
    default_branch: main
---

# Body
`,
  );
  return dir;
}

interface Check {
  name: string;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

/** Run `fn` with console.log captured, and return what it printed. */
async function captured(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  const priorExit = process.exitCode;
  try {
    await fn();
    return lines.join('\n');
  } finally {
    console.log = real;
    // Doctor sets this to signal failure to a shell. Restoring it keeps one test
    // from failing the whole `bun test` process.
    process.exitCode = priorExit;
  }
}

async function doctorChecks(cwd: string): Promise<Record<string, Check>> {
  const out = await captured(() => runDoctor({ cwd, json: true }));
  const parsed = JSON.parse(out) as { checks: Check[] };
  return Object.fromEntries(parsed.checks.map((c) => [c.name, c]));
}

describe('gaggle doctor', () => {
  test('a missing database is a failure with the command that fixes it', async () => {
    const checks = await doctorChecks(project(''));

    expect(checks.config!.level).toBe('ok');
    expect(checks.database!.level).toBe('fail');
    expect(checks.database!.detail).toContain('no connection string');
    expect(checks.database!.fix).toContain('docker compose up -d');
    // No database means no schema to report on, rather than a confusing second
    // failure about migrations.
    expect(checks.migrations).toBeUndefined();
  });

  test('an unreachable database is a failure, not a crash', async () => {
    // Port 1 is reserved and nothing listens there.
    const checks = await doctorChecks(project('postgres://nobody@127.0.0.1:1/nothing'));

    expect(checks.database!.level).toBe('fail');
    expect(checks.database!.fix).toContain('docker compose up -d');
    // The rest of the report still arrives — a dead database must not cut it short.
    expect(checks.tracker!.level).toBe('ok');
    expect(checks.dashboard).toBeTruthy();
  });

  test('a tracker with no credentials is called out', async () => {
    const dir = tmp();
    const base = tmp();
    writeFileSync(
      join(dir, 'WORKFLOW.md'),
      `---
tracker:
  kind: linear
  project_slug: SYM
workflow_templates:
  path: workflow_templates/
registry:
  base_folder: ${base.replace(/\\/g, '\\\\')}
repositories: []
---
`,
    );

    // `tracker.api_key` defaults to `$LINEAR_API_KEY`, so a developer machine with
    // that exported would pass this check for the wrong reason.
    const priorKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      const checks = await doctorChecks(dir);
      expect(checks.tracker!.level).toBe('fail');
      expect(checks.tracker!.fix).toContain('gaggle auth linear');
    } finally {
      if (priorKey !== undefined) process.env.LINEAR_API_KEY = priorKey;
    }
  });

  if (PG_URL) {
    test('a reachable, migrated database reports both as current', async () => {
      // Migrate out of band: doctor reports on the schema, it does not move it.
      const store = new PostgresControlStore(PG_URL, { maxConnections: 2 });
      try {
        await store.migrate();
      } finally {
        await store.close();
      }

      const checks = await doctorChecks(project(PG_URL));
      expect(checks.database!.level).toBe('ok');
      expect(checks.database!.detail).toContain('connected to');
      expect(checks.migrations!.level).toBe('ok');
      expect(checks.migrations!.detail).toContain('current');
    });
  } else {
    test.skip('set TEST_DATABASE_URL to check a live database', () => {});
  }
});

describe('gaggle ps', () => {
  test('with no database configured it says so and exits non-zero', async () => {
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    const realExit = process.exit;
    let exitCode: number | undefined;
    // runPs calls process.exit, which would take the test runner with it.
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('exit');
    }) as typeof process.exit;

    try {
      await expect(runPs({ cwd: project(''), json: true })).rejects.toThrow('exit');
      expect(exitCode).toBe(1);
      expect(errors.join('\n')).toContain('No database configured');
    } finally {
      console.error = realError;
      process.exit = realExit;
    }
  });

  if (PG_URL) {
    test('it reads the board without migrating, and stays quiet when idle', async () => {
      const store = new PostgresControlStore(PG_URL, { maxConnections: 2 });
      try {
        await store.migrate();
        await store.truncateAllForTests();
      } finally {
        await store.close();
      }

      const out = await captured(() => runPs({ cwd: project(PG_URL), json: true }));
      expect(JSON.parse(out)).toEqual({ tickets: [] });
    });

    test('it shows what is in flight, ticket and targets together', async () => {
      const store = new PostgresControlStore(PG_URL, { maxConnections: 2 });
      try {
        await store.migrate();
        await store.truncateAllForTests();
        const ticket = await store.upsertTicket({
          workspace: 'acme',
          external_id: 'lin-1',
          identifier: 'GAG-1',
          title: 'Fix the widget',
          external_state: 'Todo',
        });
        await store.replaceTargets(ticket.id, [
          {
            repo_alias: 'api',
            repo_url: 'https://github.com/acme/api',
            local_path: '/repos/api',
            workflow: 'gaggle/gaggle-fix-issue',
            components: [],
            depends_on: [],
          },
        ]);
        await store.updateTicket(ticket.id, { status: 'running' });
      } finally {
        await store.close();
      }

      const out = await captured(() => runPs({ cwd: project(PG_URL), json: true }));
      const body = JSON.parse(out) as {
        tickets: Array<{
          ticket: { identifier: string; status: string };
          targets: Array<{ repo_alias: string }>;
        }>;
      };
      expect(body.tickets).toHaveLength(1);
      expect(body.tickets[0]!.ticket.identifier).toBe('GAG-1');
      expect(body.tickets[0]!.targets.map((t) => t.repo_alias)).toEqual(['api']);
    });
  } else {
    test.skip('set TEST_DATABASE_URL to read a live board', () => {});
  }
});

// ─── the nest's control plane ───────────────────────────────────────────────

describe('openHubControlPlane', () => {
  /** Only `list()` and `get()` are reached; the rest of the manager is irrelevant. */
  function fakeManager(workspaces: Array<{ name: string; path: string }>): HubProcessManager {
    const managed = workspaces.map((w) => ({
      entry: { name: w.name, path: w.path },
      process: null,
      api_url: null,
      api_port: null,
      pid: null,
      started_at: null,
      last_exit_code: null,
      last_exit_at: null,
      restart_count: 0,
      status: 'stopped' as const,
      manualStopped: false,
    }));
    return {
      list: () => managed,
      get: (name: string) => managed.find((m) => m.entry.name === name),
    } as unknown as HubProcessManager;
  }

  test('no workspaces means no board, and no exception', async () => {
    expect(await openHubControlPlane(fakeManager([]))).toBeNull();
  });

  test('a workspace with no WORKFLOW.md degrades instead of exiting', async () => {
    // loadConfig calls process.exit on a missing WORKFLOW.md, which would take the
    // whole nest down with it. This is the check that stops that happening.
    expect(await openHubControlPlane(fakeManager([{ name: 'acme', path: tmp() }]))).toBeNull();
  });

  test('a workspace with no database configured degrades too', async () => {
    const dir = project('');
    expect(await openHubControlPlane(fakeManager([{ name: 'acme', path: dir }]))).toBeNull();
  });

  test('an unreachable database degrades rather than throwing', async () => {
    const dir = project('postgres://nobody@127.0.0.1:1/nothing');
    expect(await openHubControlPlane(fakeManager([{ name: 'acme', path: dir }]))).toBeNull();
  });

  if (PG_URL) {
    test('a reachable database yields a board and a history store', async () => {
      const control = await openHubControlPlane(fakeManager([{ name: 'acme', path: project(PG_URL) }]));
      expect(control).not.toBeNull();
      try {
        expect(control!.api).toBeTruthy();
        expect(control!.history).toBeTruthy();
        // And it is really wired: the board answers.
        const res = await control!.api.handle({ method: 'GET', path: '/board', query: {} });
        expect(res.status).toBe(200);
      } finally {
        await control!.close();
      }
    });
  } else {
    test.skip('set TEST_DATABASE_URL to open a real board', () => {});
  }
});
