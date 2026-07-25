/**
 * Claude Agent SDK adapter for `prompt:` and `command:` nodes.
 *
 * Exposed as the `AiRunner` function type rather than a class so the engine
 * can be tested end to end with a stub — no API keys, no network, no cost.
 * The real implementation is the only thing in the engine that talks to a
 * model.
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../util/logger.ts';

export interface AiRequest {
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  model?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  /** JSON Schema; when set the model is constrained to produce matching JSON. */
  outputFormat?: Record<string, unknown>;
  /** Continue a prior conversation — how `context: shared` is implemented. */
  resumeSessionId?: string;
  /** Abort if no message arrives for this long. */
  idleTimeoutMs: number;
  maxTurns?: number;
  signal?: AbortSignal;
  /** Streamed assistant text, for live logs. */
  onText?: (chunk: string) => void;
  /**
   * Strip every mutating tool. Used by dry-run mode to exercise the graph
   * without touching the working tree.
   */
  readOnly?: boolean;
}

export interface AiResult {
  text: string;
  /** Parsed output when `outputFormat` was requested and the text is JSON. */
  json?: unknown;
  /** Session id to thread into a later `context: shared` node. */
  sessionId: string | null;
  inputTokens: number;
  outputTokens: number;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the model or SDK reported failure. */
  error?: string;
}

export type AiRunner = (req: AiRequest) => Promise<AiResult>;

/** Tools that can modify the working tree or the outside world. */
const MUTATING_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'Bash', 'KillShell', 'BashOutput'];

/**
 * Claude auth resolution, in the order Archon used so existing setups keep
 * working: explicit key, explicit OAuth token, else piggyback on `claude
 * /login` credentials.
 */
export function buildClaudeEnv(base: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, base);

  const apiKey = env.CLAUDE_API_KEY || env.ANTHROPIC_API_KEY;
  if (apiKey) {
    env.CLAUDE_API_KEY = apiKey;
    env.ANTHROPIC_API_KEY = apiKey;
  } else if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_USE_GLOBAL_AUTH = env.CLAUDE_USE_GLOBAL_AUTH ?? 'true';
  }
  return env;
}

/** Best-effort JSON extraction from model text that may be fenced or padded. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost brace pair, for text with prose around it.
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch {
        /* give up */
      }
    }
    return undefined;
  }
}

interface SdkAssistantMessage {
  type: 'assistant';
  message: { content: Array<{ type: string; text?: string }> };
  session_id?: string;
}

interface SdkResultMessage {
  type: 'result';
  is_error?: boolean;
  subtype?: string;
  errors?: string[];
  session_id?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export const claudeRunner: AiRunner = async (req) => {
  const options: Options = {
    cwd: req.cwd,
    env: buildClaudeEnv(req.env),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  };
  if (req.model) options.model = req.model;
  if (req.maxTurns !== undefined) options.maxTurns = req.maxTurns;
  if (req.resumeSessionId) options.resume = req.resumeSessionId;
  if (req.allowedTools) options.allowedTools = req.allowedTools;

  const denied = [...(req.deniedTools ?? []), ...(req.readOnly ? MUTATING_TOOLS : [])];
  if (denied.length > 0) options.disallowedTools = [...new Set(denied)];

  if (req.outputFormat) {
    // The SDK enforces the schema, so downstream `$node.output.field` access
    // is reliable rather than dependent on the model formatting nicely.
    (options as Options & { outputFormat?: unknown }).outputFormat = {
      type: 'json_schema',
      schema: req.outputFormat,
    };
  }

  const abort = new AbortController();
  options.abortController = abort;

  let timedOut = false;
  let cancelled = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, req.idleTimeoutMs);
  };

  const onExternalAbort = () => {
    cancelled = true;
    abort.abort();
  };
  req.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let text = '';
  let sessionId: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let error: string | undefined;

  resetIdle();
  try {
    for await (const msg of query({ prompt: req.prompt, options })) {
      resetIdle();
      const event = msg as { type: string; session_id?: string };
      if (event.session_id) sessionId = event.session_id;

      if (event.type === 'assistant') {
        for (const block of (msg as SdkAssistantMessage).message.content) {
          if (block.type === 'text' && block.text) {
            // Last text block wins as the node's output, matching how the
            // analyzer already reads results; every chunk is streamed for logs.
            text = block.text;
            req.onText?.(block.text);
          }
        }
      } else if (event.type === 'result') {
        const result = msg as SdkResultMessage;
        inputTokens = result.usage?.input_tokens ?? 0;
        outputTokens = result.usage?.output_tokens ?? 0;
        if (result.is_error) {
          error = (result.errors ?? [result.subtype ?? 'unknown error']).join('; ');
        }
      }
    }
  } catch (err) {
    // An abort we caused is not a failure to report as one.
    if (!timedOut && !cancelled) error = (err as Error).message;
    logger.debug('Claude query ended with an exception', {
      error: (err as Error).message,
      timed_out: timedOut,
      cancelled,
    });
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    req.signal?.removeEventListener('abort', onExternalAbort);
  }

  return {
    text,
    json: req.outputFormat ? extractJson(text) : undefined,
    sessionId,
    inputTokens,
    outputTokens,
    timedOut,
    cancelled,
    error,
  };
};
