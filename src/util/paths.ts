import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve, sep } from 'node:path';

/**
 * Expand `~` and `$VAR_NAME` indirection in a path string.
 * Per Section 6.1: `$VAR_NAME` resolution applies to fields that explicitly contain `$VAR_NAME`.
 */
export function expandPath(value: string, baseDir?: string): string {
  if (!value) return value;
  let v = value;

  if (v.startsWith('~')) {
    v = homedir() + v.slice(1);
  }

  // $VAR_NAME indirection (whole-string form preferred; embedded form supported as a safety net)
  v = v.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => process.env[name] ?? '');

  if (!isAbsolute(v) && baseDir) {
    v = resolve(baseDir, v);
  }

  return normalize(v);
}

/**
 * Resolve a `$VAR_NAME` style env reference inside any string value.
 * If the input is exactly `$VAR`, returns the env var or empty string.
 * If the input embeds `$VAR`, replaces all such tokens.
 * Returns the input unchanged if no `$` found.
 */
export function expandEnvString(value: string): string {
  if (!value || !value.includes('$')) return value;
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => process.env[name] ?? '');
}

/** True if `child` is the same path as, or inside, `parent`. */
export function isInside(child: string, parent: string): boolean {
  const c = resolve(child) + sep;
  const p = resolve(parent) + sep;
  return c === p || c.startsWith(p);
}

/** Sanitize a string to a safe identifier matching `[A-Za-z0-9._-]`. */
export function sanitizeId(value: string): string {
  return (value || '').replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Derive a repo slug from a GitHub HTTPS URL: last path segment minus `.git`. */
export function deriveRepoSlug(url: string): string {
  if (!url) throw new Error('Cannot derive slug from empty URL');
  const trimmed = url.trim().replace(/\/$/, '');
  const last = trimmed.split('/').pop() ?? '';
  return last.replace(/\.git$/i, '');
}

/** Parse owner/repo from a GitHub HTTPS or SSH URL (including custom SSH host aliases). */
export function parseGithubOwnerRepo(url: string): { owner: string; repo: string } {
  // HTTPS: https://github.com/owner/repo[.git]
  const httpsMatch = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  // SSH: git@<host>:owner/repo[.git]  (host may be a custom alias like github-trabajo)
  const sshMatch = url.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  throw new Error(`Invalid GitHub URL (expected HTTPS or SSH git@host:owner/repo): ${url}`);
}
