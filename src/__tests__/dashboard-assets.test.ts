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
      'detached_archon_runs',
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
