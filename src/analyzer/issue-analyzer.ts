/**
 * Issue Analyzer (Section 7.2).
 *
 * Uses the Claude Agent SDK (same runtime as Archon) so Claude can explore the
 * local repo checkouts to inform its routing decision — reading gaggle.md files,
 * directory layouts, package manifests, etc.
 *
 * Authentication mirrors Archon's logic:
 *   1. CLAUDE_API_KEY (or ANTHROPIC_API_KEY as alias) — explicit API key
 *   2. CLAUDE_CODE_OAUTH_TOKEN — explicit OAuth token
 *   3. CLAUDE_USE_GLOBAL_AUTH=true — piggyback on `claude /login` session (default)
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { IssueAnalysisError, IssueAnalysisNoTargets } from '../domain/errors.ts';
import type {
  Issue,
  IssueAnalysis,
  RegistryContext,
  RegistryRepo,
  RepoTarget,
  ServiceConfig,
} from '../domain/types.ts';
import { logger } from '../util/logger.ts';
import { sanitizeId } from '../util/paths.ts';

/**
 * Injectable runner — defaults to the Claude subprocess; tests supply a fake.
 * Receives the prompt, the repos directory as cwd, and the service config.
 * Returns the raw text output from Claude.
 */
export type ClaudeRunner = (
  prompt: string,
  reposDir: string,
  cfg: ServiceConfig,
) => Promise<string>;

export class IssueAnalyzer {
  private runner: ClaudeRunner;

  constructor(
    private cfg: ServiceConfig,
    runner?: ClaudeRunner,
  ) {
    this.runner = runner ?? runClaudeQuery;
  }

  async analyze(issue: Issue, ctx: RegistryContext): Promise<IssueAnalysis> {
    if (ctx.repositories.length === 0) {
      throw new IssueAnalysisError('RegistryContext has no repositories with sync_status=ok');
    }

    const reposDir = ctx.repos_dir;
    const prompt = buildPrompt(issue, ctx);

    logger.info('Running Claude analyzer subprocess', {
      issue_id: issue.id,
      repos_dir: reposDir,
      model: this.cfg.claude.analyzer_model,
    });

    let raw: string;
    try {
      raw = await this.runner(prompt, reposDir, this.cfg);
    } catch (err) {
      throw new IssueAnalysisError(
        `Claude analyzer failed: ${(err as Error).message}`,
        err,
      );
    }

    const json = extractJsonObject(raw ?? '');
    if (!json) {
      throw new IssueAnalysisError(
        `Claude analyzer did not return parseable JSON. Raw output: ${raw.slice(0, 500)}`,
      );
    }

    let parsed: { analysis_summary?: unknown; repo_targets?: unknown };
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new IssueAnalysisError(`Claude JSON failed to parse: ${(err as Error).message}`, err);
    }

    const analysis_summary =
      typeof parsed.analysis_summary === 'string' ? parsed.analysis_summary : '';

    const reposByName = new Map<string, RegistryRepo>(ctx.repositories.map((r) => [r.name, r]));
    const reposByUrl = new Map<string, RegistryRepo>(ctx.repositories.map((r) => [r.url, r]));

    const targetsRaw = Array.isArray(parsed.repo_targets) ? parsed.repo_targets : [];
    const repo_targets: RepoTarget[] = [];

    for (const t of targetsRaw) {
      if (!t || typeof t !== 'object') continue;
      const obj = t as Record<string, unknown>;
      const url = typeof obj.repo_url === 'string' ? obj.repo_url : '';
      const aliasFromClaude = typeof obj.repo_alias === 'string' ? obj.repo_alias : '';

      let matched: RegistryRepo | undefined;
      if (url) matched = reposByUrl.get(url);
      if (!matched && aliasFromClaude) matched = reposByName.get(aliasFromClaude);

      if (!matched) {
        logger.warn('Analyzer returned target with no registry match — skipping', {
          issue_id: issue.id,
          repo_url: url,
          repo_alias: aliasFromClaude,
        });
        continue;
      }

      const archonWf =
        typeof obj.archon_workflow === 'string' && obj.archon_workflow
          ? obj.archon_workflow
          : matched.default_workflow || this.cfg.archon.default_workflow;

      const target: RepoTarget = {
        repo_url: matched.url,
        repo_alias: sanitizeId(matched.name),
        local_path: matched.local_path,
        archon_workflow: archonWf,
        rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
        components: Array.isArray(obj.components)
          ? (obj.components as unknown[]).filter((c): c is string => typeof c === 'string')
          : [],
      };
      if (Array.isArray(obj.depends_on)) {
        target.depends_on = (obj.depends_on as unknown[]).filter(
          (c): c is string => typeof c === 'string',
        );
      }
      if (typeof obj.ready_when === 'string') {
        target.ready_when = obj.ready_when;
      }

      repo_targets.push(target);
    }

    if (repo_targets.length === 0) {
      throw new IssueAnalysisNoTargets(issue.id);
    }

    return { issue_id: issue.id, analysis_summary, repo_targets };
  }
}

// ─── Claude subprocess runner ────────────────────────────────────────────────

async function runClaudeQuery(
  prompt: string,
  cwd: string,
  cfg: ServiceConfig,
): Promise<string> {
  const env = buildSubprocessEnv();

  const options: Options = {
    cwd,
    model: cfg.claude.analyzer_model,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    env,
  };

  const events = query({ prompt, options });

  let lastText = '';
  let isError = false;
  const errorMessages: string[] = [];

  try {
    for await (const msg of events) {
      const event = msg as { type: string };

      if (event.type === 'assistant') {
        const message = msg as { message: { content: Array<{ type: string; text?: string }> } };
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text) {
            lastText = block.text;
          }
        }
      } else if (event.type === 'result') {
        const result = msg as {
          is_error?: boolean;
          subtype?: string;
          errors?: string[];
        };
        if (result.is_error) {
          isError = true;
          errorMessages.push(
            ...(result.errors ?? [result.subtype ?? 'unknown error']),
          );
        }
      }
    }
  } catch (err) {
    throw new IssueAnalysisError(
      `Claude analyzer subprocess failed: ${(err as Error).message}`,
      err,
    );
  }

  if (isError) {
    throw new IssueAnalysisError(
      `Claude analyzer returned an error: ${errorMessages.join('; ')}`,
    );
  }

  return lastText;
}

/**
 * Build the subprocess env with Claude auth.
 * Mirrors Archon's buildSubprocessEnv / server startup logic:
 *   - Honour CLAUDE_API_KEY or CLAUDE_CODE_OAUTH_TOKEN if present.
 *   - Accept ANTHROPIC_API_KEY as an alias for CLAUDE_API_KEY.
 *   - Default to CLAUDE_USE_GLOBAL_AUTH=true (piggyback on `claude /login`).
 */
function buildSubprocessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  // Allow ANTHROPIC_API_KEY as an alias so users don't need two separate keys.
  if (!env.CLAUDE_API_KEY && env.ANTHROPIC_API_KEY) {
    env.CLAUDE_API_KEY = env.ANTHROPIC_API_KEY;
  }

  // Default to global auth if no explicit credentials are present.
  if (!env.CLAUDE_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN && env.CLAUDE_USE_GLOBAL_AUTH === undefined) {
    env.CLAUDE_USE_GLOBAL_AUTH = 'true';
  }

  return env;
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

function buildPrompt(issue: Issue, ctx: RegistryContext): string {
  const repoList = ctx.repositories
    .map((r) => `- ${r.name}  (url: ${r.url}, local checkout: ${r.local_path})`)
    .join('\n');

  const blockerLines =
    issue.blocked_by.length > 0
      ? issue.blocked_by.map((b) => `- ${b.identifier ?? b.id} [${b.state ?? '?'}]`).join('\n')
      : '(none)';

  return `You are GaggleDispatch's Issue Analyzer. Your job is to decide which repositories need changes to resolve the issue below, and produce a JSON routing decision.

## Registered repositories

${repoList}

For each repo a local checkout is available at the path shown. Read its \`gaggle.md\` (at the repo root) to understand what it owns and what it communicates with. You may also read other files (package.json, directory layout, key source files) if the issue is ambiguous.

## Issue

Identifier : ${issue.identifier}
Title      : ${issue.title}
State      : ${issue.state}
Priority   : ${issue.priority ?? 'none'}
Labels     : ${issue.labels.join(', ') || '(none)'}
URL        : ${issue.url ?? ''}
Blockers:
${blockerLines}

Description:
${issue.description ?? '(no description)'}

## Instructions

1. Read the \`gaggle.md\` of each relevant repo (and any other files that help).
2. Decide which repos need changes. Err on the side of FEWER, higher-confidence targets.
3. Output ONLY the following JSON — no prose, no markdown fences:

{
  "analysis_summary": "Short paragraph (2-4 sentences) explaining which services/components are affected and why.",
  "repo_targets": [
    {
      "repo_url": "<exact url from the repo list above>",
      "repo_alias": "<name field from that repo's gaggle.md>",
      "archon_workflow": "<workflow from gaggle.md available_workflows, or its default_workflow>",
      "rationale": "One sentence on why this repo is included.",
      "components": ["component-name-from-gaggle-md"],
      "depends_on": ["alias-of-upstream-repo-if-this-one-depends-on-it"],
      "ready_when": "merged"
    }
  ]
}

Rules:
- repo_alias must match the \`name\` field in that repo's gaggle.md front matter exactly.
- components must be names from that repo's gaggle.md \`components\` list.
- For depends_on + ready_when: use "merged" when this repo's changes depend on another repo's PR being merged first (e.g. FE consuming a new BE endpoint, shared library consumer waiting for the library PR). Omit depends_on entirely when repos can be worked on in parallel — when unsure, omit it.
- Output JSON only.`;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function extractJsonObject(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1]! : text;

  const start = candidate.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}
