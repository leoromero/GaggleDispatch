/**
 * IssueAnalyzer → AnalyzerPort, and slot accounting.
 *
 * The analyzer's prompt and parsing are untouched — this only translates its
 * `IssueAnalysis` into the control plane's `TargetSpec[]`, and resolves each
 * target's local checkout against the live registry rather than trusting whatever
 * path the analyzer reported.
 */

import type { IssueAnalysis, RegistryContext, ServiceConfig } from '../../domain/types.ts';
import { logger } from '../../util/logger.ts';
import { issueFromTicket } from './archon.ts';
import type { AnalysisResult, AnalyzerPort, SlotPort } from '../ports.ts';
import type { TicketRow } from '../types.ts';

/** The slice of `IssueAnalyzer` this adapter uses. */
export interface AnalyzerLike {
  analyze(issue: ReturnType<typeof issueFromTicket>, ctx: RegistryContext): Promise<IssueAnalysis>;
}

export interface ControlAnalyzerDeps {
  cfg: ServiceConfig;
  analyzer: AnalyzerLike;
  /** Read fresh each call: the repo syncer hot-reloads it. */
  registry: () => RegistryContext;
}

export class ControlAnalyzerAdapter implements AnalyzerPort {
  constructor(private readonly deps: ControlAnalyzerDeps) {}

  async analyze(ticket: TicketRow): Promise<AnalysisResult> {
    const ctx = this.deps.registry();
    const analysis = await this.deps.analyzer.analyze(issueFromTicket(ticket), ctx);

    const targets: AnalysisResult['targets'] = [];
    for (const t of analysis.repo_targets) {
      // The registry is authoritative for where a repo lives and what workflows
      // it offers. An analyzer that names a repo the registry does not know is a
      // hallucination, not a target — dropping it is better than dispatching a
      // run against a path that does not exist.
      const repo = ctx.repositories.find((r) => r.name === t.repo_alias);
      if (!repo) {
        logger.warn('Analysis named a repo the registry does not know; dropping the target', {
          identifier: ticket.identifier,
          repo_alias: t.repo_alias,
        });
        continue;
      }
      targets.push({
        repo_alias: repo.name,
        repo_url: repo.url,
        local_path: repo.local_path,
        workflow: resolveWorkflow(t.workflow, repo, this.deps.cfg, ticket.identifier),
        rationale: t.rationale ?? null,
        components: t.components ?? [],
        depends_on: t.depends_on ?? [],
        ready_when: t.ready_when ?? null,
      });
    }

    return {
      summary: analysis.analysis_summary,
      complexity: analysis.complexity ?? null,
      targets,
    };
  }
}

/**
 * Pick the workflow, preferring the analyzer's choice when the repo allows it.
 *
 * The analyzer routes by complexity, which is the point of the routing — but a
 * workflow the repo does not offer would fail at dispatch, so it falls back to
 * the repo's default with a warning rather than failing later.
 */
function resolveWorkflow(
  chosen: string,
  repo: { default_workflow: string; available_workflows: string[] },
  cfg: ServiceConfig,
  identifier: string,
): string {
  const fallback = repo.default_workflow || cfg.executor.default_workflow;
  if (!chosen) return fallback;
  if (repo.available_workflows.length === 0) return chosen;
  if (repo.available_workflows.includes(chosen)) return chosen;
  logger.warn('Analysis chose a workflow the repo does not offer; using its default', {
    identifier,
    chosen,
    using: fallback,
  });
  return fallback;
}

/**
 * How many more runs this process may start.
 *
 * Counts what the database says is live rather than what this process remembers,
 * so the ceiling holds across a restart and across two daemons sharing a
 * database. `gate_waiting` counts: a paused run still owns its worktree, and
 * treating it as free would let concurrency drift above the configured limit
 * every time a supervised workflow stops for a human.
 */
export class MaxConcurrentSlots implements SlotPort {
  constructor(private readonly max: number) {}

  availableSlots(liveCount: number): number {
    return Math.max(0, this.max - liveCount);
  }
}
