/**
 * Move a tracker issue to Done once every PR attached to it has merged.
 *
 * This is not part of the control plane and deliberately does not touch it: it
 * observes GitHub and writes the tracker, with no reference to tickets, targets,
 * or runs. It exists because the tracker's own integration marks an issue "in
 * review" but never closes it, which leaves a permanent backlog of merged work.
 *
 * Extracted from the orchestrator's poll loop unchanged in behaviour. Disabled
 * unless `tracker.pr_ready_state` is configured, which is what makes it opt-in.
 */

import { logger } from '../util/logger.ts';
import { run } from '../util/subprocess.ts';
import type { Issue } from '../domain/types.ts';

/** The tracker operations this watcher needs — reads and one write. */
export interface PrMergeTracker {
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;
  fetchIssuePRLinks(issueId: string): Promise<string[]>;
  updateIssueState(issueId: string, state: string): Promise<void>;
}

export interface PrMergeWatcherConfig {
  /** The state to watch. Null disables the watcher entirely. */
  pr_ready_state: string | null;
  /** Where a fully-merged issue lands. */
  done_state: string;
}

export interface PrMergeWatcherDeps {
  tracker: PrMergeTracker;
  cfg: PrMergeWatcherConfig;
  /** Injected so tests never shell out to `gh`. */
  isMerged?: (prUrl: string) => Promise<boolean>;
}

export class PrMergeWatcher {
  private readonly isMerged: (prUrl: string) => Promise<boolean>;

  constructor(private readonly deps: PrMergeWatcherDeps) {
    this.isMerged = deps.isMerged ?? checkGitHubPRMerged;
  }

  /** One pass. Returns how many issues were closed. */
  async poll(): Promise<number> {
    const watched = this.deps.cfg.pr_ready_state;
    if (!watched) return 0;

    let issues: Issue[];
    try {
      issues = await this.deps.tracker.fetchIssuesByStates([watched]);
    } catch (err) {
      logger.debug('PR merge watcher: could not fetch issues', { error: (err as Error).message });
      return 0;
    }

    let closed = 0;
    for (const issue of issues) {
      let prUrls: string[];
      try {
        prUrls = await this.deps.tracker.fetchIssuePRLinks(issue.id);
      } catch (err) {
        logger.debug('PR merge watcher: could not fetch PR links', {
          issue_id: issue.id,
          error: (err as Error).message,
        });
        continue;
      }
      // No PRs means nothing to conclude — an issue can sit in review for
      // reasons that have nothing to do with a pull request.
      if (prUrls.length === 0) continue;

      let allMerged = true;
      for (const url of prUrls) {
        if (!(await this.isMerged(url))) {
          allMerged = false;
          break;
        }
      }
      if (!allMerged) continue;

      try {
        await this.deps.tracker.updateIssueState(issue.id, this.deps.cfg.done_state);
        closed++;
        logger.info('All PRs merged — closing the issue', {
          issue_identifier: issue.identifier,
          pr_count: prUrls.length,
          state: this.deps.cfg.done_state,
        });
      } catch (err) {
        logger.warn('PR merge watcher: could not update the issue state', {
          issue_id: issue.id,
          error: (err as Error).message,
        });
      }
    }
    return closed;
  }
}

/**
 * Ask GitHub whether a PR is merged.
 *
 * Unparseable URL or a failed call both answer "not merged", because the only
 * action gated on a true answer is closing an issue — and wrongly closing one is
 * worse than checking again next tick.
 */
export async function checkGitHubPRMerged(prUrl: string): Promise<boolean> {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return false;
  const [, owner, repo, number] = m;
  try {
    const res = await run(['gh', 'api', `repos/${owner}/${repo}/pulls/${number}`, '--jq', '.merged']);
    return res.exitCode === 0 && res.stdout.trim() === 'true';
  } catch {
    return false;
  }
}
