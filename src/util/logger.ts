/**
 * Structured logger (Section 14.1).
 * Emits stable `key=value` formatted lines with a timestamp and level.
 * Required context fields: issue_id, issue_identifier, repo_alias (when applicable),
 * session_id (for agent session lifecycle).
 *
 * Sinks: stdout (always) and an OPTIONAL log file (LOG_FILE env var).
 */

import chalk from 'chalk';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS: Record<LogLevel, (s: string) => string> = {
  debug: (s) => chalk.gray(s),
  info: (s) => chalk.cyan(s),
  warn: (s) => chalk.yellow(s),
  error: (s) => chalk.red(s),
};

const DEFAULT_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
const LOG_FILE = process.env.LOG_FILE || '';

if (LOG_FILE) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
  } catch {
    /* ignore */
  }
}

export interface LogContext {
  issue_id?: string;
  issue_identifier?: string;
  repo_alias?: string;
  session_id?: string;
  run_id?: string;
  [key: string]: unknown;
}

function formatContext(ctx: LogContext): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined || v === null) continue;
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    // Quote strings containing whitespace.
    if (typeof v === 'string' && /\s/.test(v)) s = `"${s.replace(/"/g, '\\"')}"`;
    parts.push(`${k}=${s}`);
  }
  return parts.join(' ');
}

function now(): string {
  return new Date().toISOString();
}

function emit(level: LogLevel, msg: string, ctx: LogContext): void {
  if (LEVELS[level] < LEVELS[DEFAULT_LEVEL]) return;
  const ts = now();
  const ctxStr = formatContext(ctx);
  const line = `${ts} ${level.toUpperCase()} ${msg}${ctxStr ? ' ' + ctxStr : ''}`;

  const colorize = COLORS[level];
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(colorize(line) + '\n');

  if (LOG_FILE) {
    try {
      appendFileSync(LOG_FILE, line + '\n', 'utf8');
    } catch {
      /* ignore */
    }
  }
}

export const logger = {
  debug: (msg: string, ctx: LogContext = {}) => emit('debug', msg, ctx),
  info: (msg: string, ctx: LogContext = {}) => emit('info', msg, ctx),
  warn: (msg: string, ctx: LogContext = {}) => emit('warn', msg, ctx),
  error: (msg: string, ctx: LogContext = {}) => emit('error', msg, ctx),
  child: (base: LogContext) => ({
    debug: (msg: string, ctx: LogContext = {}) => emit('debug', msg, { ...base, ...ctx }),
    info: (msg: string, ctx: LogContext = {}) => emit('info', msg, { ...base, ...ctx }),
    warn: (msg: string, ctx: LogContext = {}) => emit('warn', msg, { ...base, ...ctx }),
    error: (msg: string, ctx: LogContext = {}) => emit('error', msg, { ...base, ...ctx }),
  }),
};

export type Logger = typeof logger;
