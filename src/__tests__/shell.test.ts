/**
 * Bash resolution. Pure-ish: `existsSync` is the only side channel, so these
 * drive resolution through synthetic PATHs built in a temp dir.
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { findOnPath, resolveBashPath, requireBash, BashNotFoundError } from '../executor/engine/shell.ts';

let root: string;
let binDir: string;
let otherDir: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gaggle-shell-'));
  binDir = join(root, 'bin');
  otherDir = join(root, 'other');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(binDir, 'bash.exe'), '');
  writeFileSync(join(binDir, 'bash'), '');
  writeFileSync(join(otherDir, 'tool'), '');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findOnPath', () => {
  test('finds a bare executable on a posix PATH', () => {
    const found = findOnPath('bash', { PATH: [otherDir, binDir].join(delimiter) }, 'linux');
    expect(found).toBe(join(binDir, 'bash'));
  });

  test('tries the .exe suffix on Windows', () => {
    const found = findOnPath('bash', { PATH: binDir }, 'win32');
    expect(found).toBe(join(binDir, 'bash.exe'));
  });

  test('returns null when PATH is empty or unset', () => {
    expect(findOnPath('bash', {}, 'linux')).toBeNull();
    expect(findOnPath('bash', { PATH: '' }, 'linux')).toBeNull();
  });

  test('returns null when the command is absent', () => {
    expect(findOnPath('definitely-not-here', { PATH: binDir }, 'linux')).toBeNull();
  });

  test('reads Path as well as PATH, for Windows environments', () => {
    expect(findOnPath('bash', { Path: binDir }, 'win32')).toBe(join(binDir, 'bash.exe'));
  });

  test('skips empty PATH segments', () => {
    const found = findOnPath('bash', { PATH: ['', binDir, ''].join(delimiter) }, 'linux');
    expect(found).toBe(join(binDir, 'bash'));
  });
});

describe('resolveBashPath', () => {
  test('GAGGLE_BASH wins when it points at a real file', () => {
    const override = join(binDir, 'bash');
    expect(resolveBashPath({ GAGGLE_BASH: override, PATH: '' }, 'linux')).toBe(override);
  });

  test('a GAGGLE_BASH pointing nowhere resolves to null rather than falling back', () => {
    // Silently ignoring a bad override would run a different shell than the
    // operator asked for — better to fail the doctor check.
    const bogus = join(root, 'nope', 'bash');
    expect(resolveBashPath({ GAGGLE_BASH: bogus, PATH: binDir }, 'linux')).toBeNull();
  });

  test('an empty GAGGLE_BASH is ignored and PATH is used', () => {
    expect(resolveBashPath({ GAGGLE_BASH: '   ', PATH: binDir }, 'linux')).toBe(join(binDir, 'bash'));
  });

  test('falls back to PATH when no override is set', () => {
    expect(resolveBashPath({ PATH: binDir }, 'win32')).toBe(join(binDir, 'bash.exe'));
  });

  test('returns null when nothing is installed anywhere', () => {
    // A PATH with no bash and no standard install location present.
    expect(resolveBashPath({ PATH: otherDir }, 'linux')).toBeNull();
  });
});

describe('requireBash', () => {
  test('resolves on this host, or throws an actionable error', () => {
    // CI images vary; assert on whichever branch this host takes rather than
    // assuming bash exists.
    if (resolveBashPath()) {
      expect(requireBash()).toBeTruthy();
    } else {
      expect(() => requireBash()).toThrow(BashNotFoundError);
    }
  });

  test('the error names GAGGLE_BASH so the operator has a lever', () => {
    expect(new BashNotFoundError().message).toContain('GAGGLE_BASH');
  });
});
