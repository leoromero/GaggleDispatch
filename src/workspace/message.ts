/**
 * Issue message construction (Section 13.2).
 * Becomes `$USER_MESSAGE` inside the workflow.
 */

import type { Issue, IssueAnalysis, RepoTarget } from '../domain/types.ts';

const MAX_LENGTH = 16_000;

export function buildIssueMessage(args: {
  issue: Issue;
  repo_target: RepoTarget;
  analysis: IssueAnalysis;
  attempt: number | null;
  sub_issue_url?: string | null;
}): string {
  const { issue, repo_target, attempt } = args;

  const components = repo_target.components.length > 0 ? repo_target.components.join(', ') : '(none)';
  const attemptStr = attempt === null ? 'first' : String(attempt);

  const { analysis } = args;
  const descriptionBlock = issue.description ? `\n---\n${issue.description}\n` : '';

  return (
    `Issue: ${issue.identifier} — ${issue.title}\n` +
    `URL: ${args.sub_issue_url ?? issue.url ?? ''}\n` +
    `Repo: ${repo_target.repo_alias}\n` +
    `Components: ${components}\n` +
    `Analysis: ${analysis.analysis_summary}\n` +
    `Scope: ${repo_target.rationale}\n` +
    `Attempt: ${attemptStr}` +
    descriptionBlock
  );
}

export function buildGaggleEnv(args: {
  issue: Issue;
  repo_target: RepoTarget;
  analysis: IssueAnalysis;
  attempt: number | null;
  sub_issue_url?: string | null;
}): Record<string, string> {
  const { issue, repo_target, analysis, attempt } = args;
  return {
    GAGGLE_ISSUE_ID: issue.id,
    GAGGLE_ISSUE_IDENTIFIER: issue.identifier,
    GAGGLE_ISSUE_TITLE: issue.title,
    GAGGLE_ISSUE_URL: issue.url ?? '',
    GAGGLE_REPO_ALIAS: repo_target.repo_alias,
    GAGGLE_REPO_URL: repo_target.repo_url,
    GAGGLE_WORKFLOW: repo_target.workflow,
    GAGGLE_ATTEMPT: attempt === null ? 'first' : String(attempt),
    GAGGLE_ANALYSIS_SUMMARY: analysis.analysis_summary,
  };
}
