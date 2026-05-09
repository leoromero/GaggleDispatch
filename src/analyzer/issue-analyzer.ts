/**
 * Issue Analyzer (Section 7.2).
 *
 * Calls Claude (Anthropic SDK) with the full RegistryContext and the normalized
 * Issue. Returns a strict `IssueAnalysis` object. The local_path on each
 * RepoTarget is reconciled from the matched RegistryRepo (Section 10.1).
 */

import Anthropic from '@anthropic-ai/sdk';
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
 * Minimal interface the analyzer needs from the Anthropic client.
 * Lets tests inject a fake without depending on the SDK.
 */
export interface AnalyzerClient {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: 'user'; content: string }>;
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

export class IssueAnalyzer {
  private client: AnalyzerClient;

  constructor(private cfg: ServiceConfig, client?: AnalyzerClient) {
    if (client) {
      this.client = client;
      return;
    }
    if (!cfg.claude.api_key) {
      throw new IssueAnalysisError('claude.api_key (ANTHROPIC_API_KEY) is missing');
    }
    this.client = new Anthropic({
      apiKey: cfg.claude.api_key,
      timeout: cfg.claude.analyzer_timeout_ms,
    }) as unknown as AnalyzerClient;
  }

  async analyze(issue: Issue, ctx: RegistryContext): Promise<IssueAnalysis> {
    if (ctx.repositories.length === 0) {
      throw new IssueAnalysisError('RegistryContext has no repositories with sync_status=ok');
    }

    const system = buildSystemPrompt();
    const user = buildUserPrompt(issue, ctx);

    let raw: string;
    try {
      const resp = await this.client.messages.create({
        model: this.cfg.claude.analyzer_model,
        max_tokens: this.cfg.claude.analyzer_max_tokens,
        system,
        messages: [{ role: 'user', content: user }],
      });
      raw = (resp.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text?: string }).text ?? '')
        .join('\n')
        .trim();
    } catch (err) {
      throw new IssueAnalysisError(
        `Claude analyzer call failed: ${(err as Error).message}`,
        err,
      );
    }

    const json = extractJsonObject(raw);
    if (!json) {
      throw new IssueAnalysisError(`Claude analyzer did not return parseable JSON. Raw output: ${raw.slice(0, 500)}`);
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
        target.depends_on = (obj.depends_on as unknown[]).filter((c): c is string => typeof c === 'string');
      }
      if (typeof obj.ready_when === 'string') {
        target.ready_when = obj.ready_when;
      }

      repo_targets.push(target);
    }

    if (repo_targets.length === 0) {
      throw new IssueAnalysisNoTargets(issue.id);
    }

    return {
      issue_id: issue.id,
      analysis_summary,
      repo_targets,
    };
  }
}

function buildSystemPrompt(): string {
  return `You are GaggleDispatch's Issue Analyzer. You read a federated registry of repositories and a normalized issue, then produce a strict JSON routing decision.

Your output MUST be valid JSON with this exact shape:
{
  "analysis_summary": "Short paragraph (2-4 sentences) explaining which services/components are affected and why.",
  "repo_targets": [
    {
      "repo_url": "https://github.com/org/repo-name",
      "repo_alias": "repo-alias-from-symphony-md-name",
      "archon_workflow": "symphony/symphony-fix-issue",
      "rationale": "One sentence on why this repo is included.",
      "components": ["component-name-1", "component-name-2"],
      "depends_on": ["upstream-repo-alias"],
      "ready_when": "deployed"
    }
  ]
}

Rules:
- Use the repo_alias values exactly as they appear in the registry's repository "name" fields.
- Pick archon_workflow from the repository's available_workflows; fall back to its default_workflow when unsure.
- Err on the side of FEWER, higher-confidence targets. Do not include a repo unless the issue clearly requires changes to it.
- For build/deploy ordering between fan-out targets, set depends_on + ready_when:
  - "ready_when": "deployed" — target consumes upstream's deploy artifact (frontend consuming new BE endpoint, service consuming new shared lib). USE THIS BY DEFAULT when there is a dependency.
  - "ready_when": "merged" — only when the dependent change literally just needs the upstream PR closed (rare, e.g. docs).
  - "ready_when": "deployed:prod" — only for hotfix follow-ups.
- Omit depends_on entirely when targets can run in parallel.
- Output JSON only. No prose, no markdown fences, no extra commentary.`;
}

function buildUserPrompt(issue: Issue, ctx: RegistryContext): string {
  const reposBlock = ctx.repositories
    .map((r) => {
      const compsBlock = r.components
        .map((c) => {
          const commLines = (c.communicates_with ?? [])
            .map((cw) => `      - ${cw.direction} ${cw.method} ${cw.component}`)
            .join('\n');
          return `  - name: ${c.name}\n    type: ${c.component_type ?? 'unspecified'}\n    description: ${c.description}${commLines ? '\n    communicates_with:\n' + commLines : ''}`;
        })
        .join('\n');

      const wfBlock =
        (r.available_workflows ?? [])
          .map((w) => `  - ${w}`)
          .join('\n') || `  - ${r.default_workflow}`;

      return `### Repository: ${r.name}
URL: ${r.url}
Description: ${r.description}
Default workflow: ${r.default_workflow}
Available workflows:
${wfBlock}
Components:
${compsBlock}

Narrative:
${r.narrative || '(no narrative)'}
`;
    })
    .join('\n---\n');

  const blockerLines =
    issue.blocked_by.length > 0
      ? issue.blocked_by.map((b) => `- ${b.identifier ?? b.id} [${b.state ?? '?'}]`).join('\n')
      : '(none)';

  return `# Federated Registry

${reposBlock}

# Issue

Identifier: ${issue.identifier}
Title: ${issue.title}
State: ${issue.state}
Priority: ${issue.priority ?? 'none'}
Labels: ${issue.labels.join(', ') || '(none)'}
URL: ${issue.url ?? ''}
Blockers:
${blockerLines}

Description:
${issue.description ?? '(no description)'}

Produce the JSON routing decision now.`;
}

function extractJsonObject(text: string): string | null {
  // Strip ```json fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1]! : text;

  // Find the first balanced top-level {...}
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (escape) {
      escape = false;
      continue;
    }
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
