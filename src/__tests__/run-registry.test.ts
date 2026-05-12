/**
 * run-registry unit tests — verifies that workerKey→runId entries are
 * written, read, and deleted correctly from gaggle-runs.json.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeRunEntry,
  readRunEntry,
  deleteRunEntry,
  allRunEntries,
} from '../registry/run-registry.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `gaggle-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('run-registry', () => {
  test('returns null for an unknown worker key', () => {
    expect(readRunEntry(tmpDir, 'SYM-1__myrepo')).toBeNull();
  });

  test('allRunEntries returns empty object when file does not exist', () => {
    expect(allRunEntries(tmpDir)).toEqual({});
  });

  test('writeRunEntry creates gaggle-runs.json', () => {
    writeRunEntry(tmpDir, 'SYM-1__myrepo', {
      archon_run_id: 'abc123def456abc123def456abc123de',
      parent_issue_id: 'pid1',
      sub_issue_id: 'sid1',
      repo_alias: 'myrepo',
    });
    expect(existsSync(join(tmpDir, 'gaggle-runs.json'))).toBe(true);
  });

  test('readRunEntry retrieves a written entry', () => {
    const entry = {
      archon_run_id: 'abc123def456abc123def456abc123de',
      parent_issue_id: 'pid1',
      sub_issue_id: 'sid1',
      repo_alias: 'myrepo',
    };
    writeRunEntry(tmpDir, 'SYM-1__myrepo', entry);
    const result = readRunEntry(tmpDir, 'SYM-1__myrepo');
    expect(result?.archon_run_id).toBe(entry.archon_run_id);
    expect(result?.parent_issue_id).toBe(entry.parent_issue_id);
    expect(result?.sub_issue_id).toBe(entry.sub_issue_id);
    expect(result?.repo_alias).toBe(entry.repo_alias);
    expect(result?.started_at).toBeDefined();
  });

  test('writeRunEntry stores null sub_issue_id correctly', () => {
    writeRunEntry(tmpDir, 'SYM-2__other', {
      archon_run_id: 'deadbeefdeadbeefdeadbeefdeadbeef',
      parent_issue_id: 'pid2',
      sub_issue_id: null,
      repo_alias: 'other',
    });
    expect(readRunEntry(tmpDir, 'SYM-2__other')?.sub_issue_id).toBeNull();
  });

  test('allRunEntries returns all written entries', () => {
    writeRunEntry(tmpDir, 'SYM-1__repo-a', { archon_run_id: 'aaa', parent_issue_id: 'p1', sub_issue_id: null, repo_alias: 'repo-a' });
    writeRunEntry(tmpDir, 'SYM-2__repo-b', { archon_run_id: 'bbb', parent_issue_id: 'p2', sub_issue_id: 's2', repo_alias: 'repo-b' });
    const all = allRunEntries(tmpDir);
    expect(Object.keys(all)).toHaveLength(2);
    expect(all['SYM-1__repo-a'].archon_run_id).toBe('aaa');
    expect(all['SYM-2__repo-b'].archon_run_id).toBe('bbb');
  });

  test('deleteRunEntry removes the entry', () => {
    writeRunEntry(tmpDir, 'SYM-1__myrepo', { archon_run_id: 'x', parent_issue_id: 'p', sub_issue_id: null, repo_alias: 'myrepo' });
    expect(readRunEntry(tmpDir, 'SYM-1__myrepo')).not.toBeNull();
    deleteRunEntry(tmpDir, 'SYM-1__myrepo');
    expect(readRunEntry(tmpDir, 'SYM-1__myrepo')).toBeNull();
  });

  test('deleteRunEntry is a no-op for an unknown key', () => {
    expect(() => deleteRunEntry(tmpDir, 'nonexistent')).not.toThrow();
  });

  test('deleteRunEntry preserves other entries', () => {
    writeRunEntry(tmpDir, 'SYM-1__a', { archon_run_id: 'a', parent_issue_id: 'p1', sub_issue_id: null, repo_alias: 'a' });
    writeRunEntry(tmpDir, 'SYM-2__b', { archon_run_id: 'b', parent_issue_id: 'p2', sub_issue_id: null, repo_alias: 'b' });
    deleteRunEntry(tmpDir, 'SYM-1__a');
    const all = allRunEntries(tmpDir);
    expect(Object.keys(all)).toHaveLength(1);
    expect(all['SYM-2__b'].archon_run_id).toBe('b');
  });

  test('writeRunEntry overwrites an existing entry for the same key', () => {
    writeRunEntry(tmpDir, 'SYM-1__myrepo', { archon_run_id: 'first', parent_issue_id: 'p', sub_issue_id: null, repo_alias: 'myrepo' });
    writeRunEntry(tmpDir, 'SYM-1__myrepo', { archon_run_id: 'second', parent_issue_id: 'p', sub_issue_id: null, repo_alias: 'myrepo' });
    expect(readRunEntry(tmpDir, 'SYM-1__myrepo')?.archon_run_id).toBe('second');
    expect(Object.keys(allRunEntries(tmpDir))).toHaveLength(1);
  });

  test('load() treats corrupt gaggle-runs.json as empty (returns {})', () => {
    const { writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    writeFileSync(join(tmpDir, 'gaggle-runs.json'), 'NOT JSON {{{{', 'utf8');
    // Should not throw; corrupt file silently treated as empty
    expect(allRunEntries(tmpDir)).toEqual({});
    expect(readRunEntry(tmpDir, 'any-key')).toBeNull();
  });

  test('file is valid JSON after multiple writes and deletes', () => {
    writeRunEntry(tmpDir, 'k1', { archon_run_id: 'a', parent_issue_id: 'p', sub_issue_id: null, repo_alias: 'r' });
    writeRunEntry(tmpDir, 'k2', { archon_run_id: 'b', parent_issue_id: 'p', sub_issue_id: null, repo_alias: 'r' });
    deleteRunEntry(tmpDir, 'k1');
    writeRunEntry(tmpDir, 'k3', { archon_run_id: 'c', parent_issue_id: 'p', sub_issue_id: null, repo_alias: 'r' });
    const raw = readFileSync(join(tmpDir, 'gaggle-runs.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw) as { entries: Record<string, unknown> };
    expect(Object.keys(parsed.entries)).toEqual(['k2', 'k3']);
  });
});
