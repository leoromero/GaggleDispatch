/**
 * The dashboard has no build step, so nothing catches a syntax error in it until
 * a browser silently refuses to run the file and every panel renders empty.
 *
 * That happened during the control-plane migration and cost a debugging session,
 * so these tests exist: parse the JavaScript, and check that the elements the
 * renderers address actually exist in the HTML. Cheap, and they fail loudly.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DASHBOARD = join(import.meta.dir, '..', '..', 'dashboard');
const read = (f: string) => readFileSync(join(DASHBOARD, f), 'utf8');

describe('dashboard/app.js', () => {
  const source = read('app.js');

  test('parses', () => {
    // Bun's transpiler, not `new vm.Script`. `new Script` does not eagerly parse
    // in Bun — it accepts `function f( {` without complaint — so the earlier
    // version of this test was green while the real file was unloadable, which is
    // precisely the failure it was written to catch.
    expect(() => new Bun.Transpiler({ loader: 'js' }).scan(source)).not.toThrow();
  });

  test('has no half-substituted template literals or empty expressions', () => {
    // The specific corruption that slipped through: a shell ate `${...}` and
    // `$('#id')`, leaving `el('div', {}, )` and `const root = ;`.
    const suspicious = [
      /=\s*;/, // `const root = ;`
      /,\s*\)/, // `el('div', {}, )`
      /\(\s*,/, // `f(, x)`
      /:\s*\}/, // `{ width: }`
      /,\s*,/, // `[a, , b]` in an argument list
    ];
    const lines = source.split('\n');
    const hits: string[] = [];
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      for (const re of suspicious) {
        if (re.test(code)) hits.push(`${i + 1}: ${line.trim()}`);
      }
    });
    expect(hits).toEqual([]);
  });

  test('every element the renderers query exists in index.html', () => {
    const html = read('index.html');
    const ids = [...source.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(10);
    const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  test('nothing still reads the orchestrator state fields that moved to Postgres', () => {
    // These were in-memory authority over durable facts. A renderer still reading
    // them would show zeroes rather than failing, which is worse.
    for (const gone of [
      'supervised_gates',
      'pending_targets',
      'retry_attempts',
      'detached_runs',
      'target_machine_states',
      'renderPipeline',
    ]) {
      expect(source).not.toContain(gone);
    }
  });

  test('every CSS class the renderers use is styled', () => {
    const css = read('styles.css');
    // Only the classes this migration introduced; the pre-existing ones are
    // covered by having shipped.
    for (const cls of [
      'ticket-row',
      'ticket-head',
      'ticket-toggle',
      'ticket-key',
      'ticket-title',
      'ticket-actions',
      'ticket-detail',
      'ticket-badges',
      'status-pill',
      'target-chip',
      'target-line',
      'target-alias',
      'filter-chip',
      'gate-card',
      'gate-message',
      'gate-actions',
      'gate-input',
      'hidden',
    ]) {
      expect(css).toContain(`.${cls}`);
    }
  });
});

// ─── actually run the renderers ─────────────────────────────────────────────

/**
 * Parsing is not enough.
 *
 * A merge deleted `const runUrl = ...` and left one use of `runUrl` behind. The
 * file still parses — an undefined identifier is a *runtime* ReferenceError —
 * so every check above stayed green while `renderWorkers` threw on its first
 * card. It clears the panel before it throws, and it runs before
 * `renderGaggles`, `renderLogs` and `refreshBoard`, so the whole dashboard went
 * blank whenever any worker was running.
 *
 * So: load the real file into a stub DOM and call the renderers. This does not
 * check that anything *looks* right — only that the code executes, which is the
 * class of failure that has now bitten twice.
 */
function loadDashboard(): Record<string, unknown> {
  const source = readFileSync(join(DASHBOARD, 'app.js'), 'utf8');

  const node = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      children: [] as unknown[],
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      dataset: {},
      appendChild(c: unknown) {
        (self.children as unknown[]).push(c);
        return c;
      },
      append(...c: unknown[]) {
        (self.children as unknown[]).push(...c);
      },
      remove() {},
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      replaceWith() {},
      cloneNode: () => node(),
      querySelector: () => node(),
      querySelectorAll: () => [],
      closest: () => node(),
      insertAdjacentHTML() {},
      focus() {},
      scrollTo() {},
      textContent: '',
      innerHTML: '',
      value: '',
      checked: false,
      scrollHeight: 0,
      scrollTop: 0,
    };
    return self;
  };

  const doc = {
    createElement: () => node(),
    createTextNode: () => node(),
    getElementById: () => node(),
    querySelector: () => node(),
    querySelectorAll: () => [],
    addEventListener() {},
    body: node(),
    documentElement: node(),
  };

  const exported: Record<string, unknown> = {};
  const globals = {
    document: doc,
    window: {
      addEventListener() {},
      location: { host: 'localhost:8787', protocol: 'http:', href: 'http://localhost:8787/' },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    },
    WebSocket: class {
      addEventListener() {}
      send() {}
      close() {}
    },
    // The file uses bare globals (`location`, not `window.location`) and calls
    // bootstrap() at load, so these have to exist before the source runs.
    location: { host: 'localhost:8787', protocol: 'http:', href: 'http://localhost:8787/' },
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    alert() {},
    confirm: () => true,
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval() {},
    clearTimeout() {},
    requestAnimationFrame: () => 0,
    console,
    // The renderers are top-level `function` declarations, so hand them back
    // through an explicit capture rather than guessing at module semantics.
    __capture: (name: string, fn: unknown) => {
      exported[name] = fn;
    },
  };

  const RENDERERS = ['renderWorkers', 'renderGaggles', 'renderLogs', 'renderGates', 'renderAll'];
  const capture = RENDERERS.map(
    (n) => `try { __capture('${n}', ${n}); } catch (e) { /* not defined */ }`,
  ).join('\n');

  const fn = new Function(...Object.keys(globals), `${source}\n${capture}\nreturn __state();`);
  const withState = new Function(
    ...Object.keys(globals),
    `${source}\n${capture}\nreturn typeof state !== 'undefined' ? state : {};`,
  );
  void fn;
  const state = withState(...Object.values(globals)) as Record<string, unknown>;
  return { ...exported, state };
}

describe('the renderers execute', () => {
  const worker = (over: Record<string, unknown> = {}) => ({
    issue: { identifier: 'GAG-1', title: 'Fix it' },
    repo_alias: 'api',
    run_id: '9136a161-35d0-82cb-9f0a-c75523b3b56e',
    turn_count: 3,
    started_at: new Date().toISOString(),
    claude_total_tokens: 1234,
    last_message: 'working',
    ...over,
  });

  test('renderWorkers survives a running worker', () => {
    // The exact shape that threw: one live worker with a run id.
    const dash = loadDashboard();
    const render = dash.renderWorkers as ((...a: unknown[]) => void) | undefined;
    const state = dash.state as Record<string, unknown>;
    if (!render) throw new Error('renderWorkers was not found — did it get renamed?');

    state.gaggles = [{ name: 'acme', status: 'running' }];
    state.states = { acme: { running: [worker()] } };

    expect(() => render()).not.toThrow();
  });

  test('renderWorkers survives a worker whose run has not started', () => {
    const dash = loadDashboard();
    const render = dash.renderWorkers as ((...a: unknown[]) => void) | undefined;
    const state = dash.state as Record<string, unknown>;
    if (!render) throw new Error('renderWorkers was not found — did it get renamed?');

    state.gaggles = [{ name: 'acme', status: 'running' }];
    state.states = { acme: { running: [worker({ run_id: null, last_message: null })] } };

    expect(() => render()).not.toThrow();
  });

  test('renderWorkers survives having nothing to show', () => {
    const dash = loadDashboard();
    const render = dash.renderWorkers as ((...a: unknown[]) => void) | undefined;
    const state = dash.state as Record<string, unknown>;
    if (!render) throw new Error('renderWorkers was not found — did it get renamed?');

    state.gaggles = [];
    state.states = {};

    expect(() => render()).not.toThrow();
  });
});
