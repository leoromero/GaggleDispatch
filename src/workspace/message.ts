/**
 * Issue message construction (Section 13.2).
 * Becomes `$USER_MESSAGE` inside Archon workflows.
 */

import type { Issue, IssueAnalysis, RepoTarget } from '../domain/types.ts';

const MAX_LENGTH = 16_000;

export function buildIssueMessage(args: {
  issue: Issue;
  repo_target: RepoTarget;
  analysis: IssueAnalysis;
  attempt: number | null;
}): string {
  const { issue, repo_target, analysis, attempt } = args;

  const labels = issue.labels.length > 0 ? issue.labels.join(', ') : '(none)';
  const components = repo_target.components.length > 0 ? repo_target.components.join(', ') : '(none)';
  const attemptStr = attempt === null ? 'first' : String(attempt);

  const header =
    `Issue: ${issue.identifier} — ${issue.title}\n` +
    `URL: ${issue.url ?? ''}\n` +
    `Labels: ${labels}\n` +
    `Repo: ${repo_target.repo_alias} — ${repo_target.rationale}\n` +
    `Components: ${components}\n` +
    `Analysis: ${analysis.analysis_summary}\n` +
    `Attempt: ${attemptStr}\n\n`;

  const description = issue.description ?? '';
  let combined = header + description;

  if (combined.length > MAX_LENGTH) {
    const cut = MAX_LENGTH - header.length - 80;
    const truncated = description.slice(0, Math.max(cut, 0));
    const omitted = description.length - truncated.length;
    combined = header + truncated + `\n\n[description truncated — ${omitted} chars omitted]`;
  }

  return combined;
}

export function buildSymphonyEnv(args: {
  issue: Issue;
  repo_target: RepoTarget;
  analysis: IssueAnalysis;
  attempt: number | null;
}): Record<string, string> {
  const { issue, repo_target, analysis, attempt } = args;
  return {
    SYMPHONY_ISSUE_ID: issue.id,
    SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
    SYMPHONY_ISSUE_TITLE: issue.title,
    SYMPHONY_ISSUE_URL: issue.url ?? '',
    SYMPHONY_REPO_ALIAS: repo_target.repo_alias,
    SYMPHONY_REPO_URL: repo_target.repo_url,
    SYMPHONY_ARCHON_WORKFLOW: repo_target.archon_workflow,
    SYMPHONY_ATTEMPT: attempt === null ? 'first' : String(attempt),
    SYMPHONY_ANALYSIS_SUMMARY: analysis.analysis_summary,
    GAGGLE_REPO_ALIAS: repo_target.repo_alias,
    GAGGLE_ISSUE_IDENTIFIER: issue.identifier,
  };
}
