/**
 * Utilities for reading and writing .env files stored in the gaggle base folder.
 *
 * Loading order (highest wins):
 *   1. Process environment (system / CI / shell exports)
 *   2. <base_folder>/.env  — written by `gaggle setup`
 *
 * `applyEnvFile` never overwrites an existing process.env value, so system-level
 * overrides always take precedence without any extra configuration.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Parse a .env file into key→value pairs. Ignores comments and blank lines. */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Load a .env file into process.env.
 * Values already present in the environment are NOT overwritten — the process
 * environment (shell exports, CI secrets) always takes precedence.
 */
export function applyEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const entries = parseEnvFile(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(entries)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

/**
 * Merge `updates` into an existing .env file, creating it if absent.
 * Comment lines and unrelated keys are preserved. Written with mode 0600.
 */
export function mergeEnvFile(path: string, updates: Record<string, string>): void {
  let originalLines: string[] = [];
  let existing: Record<string, string> = {};
  if (existsSync(path)) {
    const content = readFileSync(path, 'utf8');
    originalLines = content.split(/\r?\n/);
    existing = parseEnvFile(content);
  }

  const merged = { ...existing, ...updates };
  const renderedKeys = new Set<string>();
  const lines: string[] = [];

  for (const rawLine of originalLines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      lines.push(rawLine);
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      lines.push(rawLine);
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    if (key in merged) {
      lines.push(`${key}=${merged[key]}`);
      renderedKeys.add(key);
    } else {
      lines.push(rawLine);
    }
  }

  // Append keys not already present in the file.
  for (const key of Object.keys(updates)) {
    if (!renderedKeys.has(key)) {
      lines.push(`${key}=${updates[key]}`);
    }
  }

  // Trim trailing blank lines then add one final newline.
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  const output = lines.join('\n') + '\n';

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, output, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod is a no-op on Windows — acceptable.
  }
}

/**
 * Create a .env file with commented stubs if it does not yet exist.
 * Each stub renders as a comment line followed by `KEY=`.
 */
export function stubEnvFile(
  path: string,
  stubs: Array<{ key: string; comment: string }>,
): void {
  if (existsSync(path)) return;
  const lines = [
    '# GaggleDispatch API keys — edit here or run `gaggle setup` to fill them in.',
    '# Values set in your shell environment take precedence over this file.',
    '',
    ...stubs.flatMap(({ key, comment }) => [`# ${comment}`, `${key}=`, '']),
  ];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // no-op on Windows
  }
}
