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
  WORKFLOW_RUN_ID_REGEX,
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

describe('WORKFLOW_RUN_ID_REGEX', () => {
  const SAMPLE_LINE =
    '{"level":30,"time":1778375493895,"pid":8104,"hostname":"Leo-Fligo","module":"workflow.executor",' +
    '"workflowName":"gaggle/gaggle-fix-issue","workflowRunId":"9136a16135d082cb9f0ac75523b3b56e",' +
    '"hasIssueContext":false,"issueContextLength":0,"msg":"workflow_starting"}';

  test('extracts the 32-char hex run id from a workflow_starting log line', () => {
    expect(SAMPLE_LINE.match(WORKFLOW_RUN_ID_REGEX)?.[1]).toBe('9136a16135d082cb9f0ac75523b3b56e');
  });

  test('does not match lines that have no workflowRunId field', () => {
    expect('{"level":30,"msg":"db.sqlite_schema_initialized"}'.match(WORKFLOW_RUN_ID_REGEX)).toBeNull();
  });

  test('does not match a UUID-format gate run id (dashes not supported)', () => {
    const uuidLine = '{"workflowRunId":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}';
    expect(uuidLine.match(WORKFLOW_RUN_ID_REGEX)).toBeNull();
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
    const argv = buildArchonRunArgv('archon workflow run', 'gaggle/gaggle-fix-issue', '/repos/x', 'msg');
    expect(argv).toEqual([
      'archon',
      'workflow',
      'run',
      'gaggle/gaggle-fix-issue',
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
