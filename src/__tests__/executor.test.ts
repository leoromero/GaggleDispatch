/**
 * Archon executor unit tests — covers the pure helpers (regex parsing,
 * argv tokenization) without spawning real subprocesses.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildArchonRunArgv,
  detectGatePause,
  PAUSE_REGEX,
  RUN_ID_REGEX,
  tokenizeArchonCommand,
} from '../executor/archon.ts';

describe('RUN_ID_REGEX', () => {
  test('matches a UUID anywhere in a line', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(`hello ${id} world`.match(RUN_ID_REGEX)?.[1]).toBe(id);
  });

  test('does not match malformed UUIDs', () => {
    expect('11111111-2222-3333-4444-55555555555X'.match(RUN_ID_REGEX)).toBeNull();
    expect('11111111-2222-3333-4444-55555555'.match(RUN_ID_REGEX)).toBeNull();
  });
});

describe('PAUSE_REGEX', () => {
  test.each([
    ['Run paused at gate'],
    ['Workflow has approval-gate'],
    ['Now waiting for approval...'],
    ['Reached loop-interactive node'],
    ['LOOP INTERACTIVE waiting'],
  ])('matches "%s"', (line: string) => {
    expect(PAUSE_REGEX.test(line)).toBe(true);
  });

  test.each([
    ['Run completed successfully'],
    ['Tool call failed'],
    ['Connecting to provider'],
  ])('does NOT match "%s"', (line: string) => {
    expect(PAUSE_REGEX.test(line)).toBe(false);
  });
});

describe('detectGatePause', () => {
  test('returns run_id when both pause keyword and UUID are present', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(detectGatePause(`Paused run ${id}`)).toEqual({ run_id: id });
  });

  test('returns null when pause keyword present but no UUID', () => {
    expect(detectGatePause('Paused at gate')).toBeNull();
  });

  test('returns null when UUID present but no pause keyword', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(detectGatePause(`Started run ${id}`)).toBeNull();
  });
});

describe('tokenizeArchonCommand', () => {
  test('splits a simple command', () => {
    expect(tokenizeArchonCommand('archon workflow run')).toEqual(['archon', 'workflow', 'run']);
  });

  test('preserves "double-quoted" tokens as a single argument', () => {
    expect(tokenizeArchonCommand('archon "workflow run"')).toEqual(['archon', 'workflow run']);
  });

  test("preserves 'single-quoted' tokens as a single argument", () => {
    expect(tokenizeArchonCommand("archon 'workflow run'")).toEqual(['archon', 'workflow run']);
  });

  test('handles multiple spaces and trailing whitespace', () => {
    expect(tokenizeArchonCommand('  archon   workflow   run  ')).toEqual(['archon', 'workflow', 'run']);
  });

  test('returns [] for empty string', () => {
    expect(tokenizeArchonCommand('')).toEqual([]);
  });
});

describe('buildArchonRunArgv', () => {
  test('appends workflow + --cwd + message in the correct order', () => {
    const argv = buildArchonRunArgv('archon workflow run', 'symphony/symphony-fix-issue', '/repos/x', 'msg');
    expect(argv).toEqual([
      'archon',
      'workflow',
      'run',
      'symphony/symphony-fix-issue',
      '--cwd',
      '/repos/x',
      'msg',
    ]);
  });

  test('keeps a multi-line message intact as a single argv element', () => {
    const msg = 'line one\nline two';
    const argv = buildArchonRunArgv('archon workflow run', 'wf', '/cwd', msg);
    expect(argv[argv.length - 1]).toBe(msg);
  });
});
