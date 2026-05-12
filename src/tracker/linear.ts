/**
 * Linear tracker adapter (Section 12.1).
 *
 * Implements all 10 REQUIRED operations. Uses Linear's GraphQL API directly
 * via fetch (no SDK dependency).
 */

import { logger } from '../util/logger.ts';
import type { BlockerRef, Issue, ServiceConfig } from '../domain/types.ts';

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: string[] }>;
}

export interface IssueCommentRecord {
  id: string;
  body: string;
  author: { id: string | null; name: string | null; email: string | null };
  created_at: string;
}

export class LinearError extends Error {
  override name = 'LinearError';
  constructor(message: string, public payload?: unknown) {
    super(message);
  }
}

export interface LinearLabel {
  id: string;
  name: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export class LinearClient {
  private viewerId: string | null = null;
  private teamCache: LinearTeam | null = null;
  private labelIdCache = new Map<string, string>(); // name -> id (per team)
  private stateIdCache = new Map<string, string>(); // name -> id (per team)

  constructor(private cfg: ServiceConfig) {
    if (!cfg.tracker.api_key) {
      throw new LinearError('LINEAR_API_KEY is missing or empty');
    }
  }

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.cfg.tracker.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.cfg.tracker.api_key,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LinearError(`Linear HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as GqlResponse<T>;
    if (json.errors && json.errors.length > 0) {
      throw new LinearError(`Linear GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`, json.errors);
    }
    if (!json.data) throw new LinearError('Linear response missing data');
    return json.data;
  }

  async resolveViewerId(): Promise<string> {
    if (this.viewerId) return this.viewerId;
    const data = await this.query<{ viewer: { id: string; name: string; email: string } }>(
      `query { viewer { id name email } }`,
    );
    this.viewerId = data.viewer.id;
    logger.info('Resolved Linear viewer', { viewer_id: data.viewer.id, name: data.viewer.name });
    return this.viewerId;
  }

  async resolveTeam(): Promise<LinearTeam> {
    if (this.teamCache) return this.teamCache;
    const slug = this.cfg.tracker.project_slug;
    if (!slug) throw new LinearError('tracker.project_slug is not configured');

    // Try team key match first (most common: short uppercase key like "SYM").
    const data = await this.query<{ teams: { nodes: LinearTeam[] } }>(
      `query($filter: TeamFilter) { teams(filter: $filter, first: 5) { nodes { id key name } } }`,
      { filter: { key: { eqIgnoreCase: slug } } },
    );
    let team = data.teams.nodes[0];
    if (!team) {
      // Fallback: name match.
      const byName = await this.query<{ teams: { nodes: LinearTeam[] } }>(
        `query($filter: TeamFilter) { teams(filter: $filter, first: 5) { nodes { id key name } } }`,
        { filter: { name: { eqIgnoreCase: slug } } },
      );
      team = byName.teams.nodes[0];
    }
    if (!team) {
      throw new LinearError(`No Linear team matched project_slug='${slug}' (tried key and name)`);
    }
    this.teamCache = team;
    return team;
  }

  // ── 12.1 #1: fetch_candidate_issues ───────────────────────────────────────
  async fetchCandidateIssues(): Promise<Issue[]> {
    const team = await this.resolveTeam();
    const filter: Record<string, unknown> = {
      team: { id: { eq: team.id } },
      state: { name: { in: this.cfg.tracker.active_states } },
    };
    if (this.cfg.tracker.assigned_to_me) {
      const viewerId = await this.resolveViewerId();
      filter.assignee = { id: { eq: viewerId } };
    }
    const data = await this.query<{ issues: { nodes: RawLinearIssue[] } }>(
      ISSUES_QUERY,
      { filter, first: 100 },
    );
    return data.issues.nodes.map(normalizeIssue);
  }

  // ── 12.1 #2: fetch_issues_by_states ───────────────────────────────────────
  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const team = await this.resolveTeam();
    const data = await this.query<{ issues: { nodes: RawLinearIssue[] } }>(
      ISSUES_QUERY,
      {
        filter: { team: { id: { eq: team.id } }, state: { name: { in: stateNames } } },
        first: 250,
      },
    );
    return data.issues.nodes.map(normalizeIssue);
  }

  // ── 12.1 #3: fetch_issue_states_by_ids ────────────────────────────────────
  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    const data = await this.query<{ issues: { nodes: RawLinearIssue[] } }>(
      ISSUES_QUERY,
      { filter: { id: { in: ids } }, first: ids.length },
    );
    return data.issues.nodes.map(normalizeIssue);
  }

  // ── 12.1 #4: create_sub_issue ─────────────────────────────────────────────
  async createSubIssue(args: {
    parent_id: string;
    title: string;
    description?: string;
    assignee_id: string | null;
    state_name: string;
  }): Promise<{ id: string; identifier: string }> {
    const team = await this.resolveTeam();
    const stateId = await this.resolveStateId(team.id, args.state_name);
    const data = await this.query<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string } | null };
    }>(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier }
        }
      }`,
      {
        input: {
          parentId: args.parent_id,
          title: args.title,
          description: args.description ?? undefined,
          teamId: team.id,
          assigneeId: args.assignee_id ?? undefined,
          stateId,
        },
      },
    );
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new LinearError(`Failed to create sub-issue under ${args.parent_id}`);
    }
    return data.issueCreate.issue;
  }

  // ── create_issue: top-level issue with optional priority + assignee ─────────
  async createIssue(args: {
    title: string;
    description?: string;
    priority?: number | null;
    assignee_id?: string | null;
    state_name: string;
  }): Promise<{ id: string; identifier: string; url: string | null }> {
    const team = await this.resolveTeam();
    const stateId = await this.resolveStateId(team.id, args.state_name);
    const data = await this.query<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string | null } | null };
    }>(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }`,
      {
        input: {
          title: args.title,
          description: args.description ?? undefined,
          teamId: team.id,
          stateId,
          priority: args.priority ?? undefined,
          assigneeId: args.assignee_id ?? undefined,
        },
      },
    );
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new LinearError(`Failed to create issue: ${args.title}`);
    }
    return data.issueCreate.issue;
  }

  // ── create_blocker_relation: upstreamId BLOCKS downstreamId ───────────────
  async createBlockerRelation(upstreamId: string, downstreamId: string): Promise<void> {
    await this.query<{ issueRelationCreate: { success: boolean } }>(
      `mutation($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) { success }
      }`,
      { input: { issueId: upstreamId, relatedIssueId: downstreamId, type: 'blocks' } },
    );
  }

  // ── 12.1 #5: update_issue_state ───────────────────────────────────────────
  async updateIssueState(issue_id: string, state_name: string): Promise<void> {
    const team = await this.resolveTeam();
    const stateId = await this.resolveStateId(team.id, state_name);
    await this.query<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id: issue_id, input: { stateId } },
    );
  }

  // ── 12.1 #6: post_comment ─────────────────────────────────────────────────
  async postComment(issue_id: string, body: string): Promise<{ id: string }> {
    const data = await this.query<{
      commentCreate: { success: boolean; comment: { id: string } | null };
    }>(
      `mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id } }
      }`,
      { input: { issueId: issue_id, body } },
    );
    if (!data.commentCreate.success || !data.commentCreate.comment) {
      throw new LinearError(`Failed to post comment on ${issue_id}`);
    }
    return data.commentCreate.comment;
  }

  // ── 12.1 #7: apply_label ──────────────────────────────────────────────────
  async applyLabel(issue_id: string, label_name: string): Promise<void> {
    const team = await this.resolveTeam();
    const labelId = await this.ensureLabelExists(team.id, label_name);
    await this.query<{ issueAddLabel: { success: boolean } }>(
      `mutation($id: String!, $labelId: String!) {
        issueAddLabel(id: $id, labelId: $labelId) { success }
      }`,
      { id: issue_id, labelId },
    );
  }

  // ── 12.1 #8: remove_label ─────────────────────────────────────────────────
  async removeLabel(issue_id: string, label_name: string): Promise<void> {
    const team = await this.resolveTeam();
    const labelId = await this.ensureLabelExists(team.id, label_name);
    await this.query<{ issueRemoveLabel: { success: boolean } }>(
      `mutation($id: String!, $labelId: String!) {
        issueRemoveLabel(id: $id, labelId: $labelId) { success }
      }`,
      { id: issue_id, labelId },
    );
  }

  // ── 12.1 #9: fetch_issues_by_label ────────────────────────────────────────
  async fetchIssuesByLabel(label_name: string): Promise<Issue[]> {
    const team = await this.resolveTeam();
    const data = await this.query<{ issues: { nodes: RawLinearIssue[] } }>(
      ISSUES_QUERY,
      {
        filter: {
          team: { id: { eq: team.id } },
          labels: { name: { eqIgnoreCase: label_name } },
        },
        first: 250,
      },
    );
    return data.issues.nodes.map(normalizeIssue);
  }

  // ── 12.1 #10: fetch_issue_comments ────────────────────────────────────────
  async fetchIssueComments(issue_id: string): Promise<IssueCommentRecord[]> {
    const data = await this.query<{
      issue: { comments: { nodes: Array<{ id: string; body: string; createdAt: string; user: { id: string | null; name: string | null; email: string | null } | null }> } } | null;
    }>(
      `query($id: String!) {
        issue(id: $id) {
          comments(first: 100) {
            nodes { id body createdAt user { id name email } }
          }
        }
      }`,
      { id: issue_id },
    );
    if (!data.issue) return [];
    return data.issue.comments.nodes.map((c) => ({
      id: c.id,
      body: c.body,
      author: {
        id: c.user?.id ?? null,
        name: c.user?.name ?? null,
        email: c.user?.email ?? null,
      },
      created_at: c.createdAt,
    }));
  }

  // ── pr link attachments ───────────────────────────────────────────────────
  async fetchIssuePRLinks(issue_id: string): Promise<string[]> {
    const data = await this.query<{
      issue: { attachments: { nodes: Array<{ url: string | null }> } } | null;
    }>(
      `query($id: String!) {
        issue(id: $id) {
          attachments(first: 50) {
            nodes { url }
          }
        }
      }`,
      { id: issue_id },
    );
    if (!data.issue) return [];
    return data.issue.attachments.nodes
      .map((a) => a.url ?? '')
      .filter((url) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url));
  }

  // ── label and state caching ───────────────────────────────────────────────
  async ensureLabelExists(teamId: string, name: string): Promise<string> {
    const cacheKey = `${teamId}:${name}`;
    const cached = this.labelIdCache.get(cacheKey);
    if (cached) return cached;

    const data = await this.query<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
      `query($filter: IssueLabelFilter) {
        issueLabels(filter: $filter, first: 5) { nodes { id name } }
      }`,
      { filter: { team: { id: { eq: teamId } }, name: { eq: name } } },
    );
    let id = data.issueLabels.nodes[0]?.id;
    if (!id) {
      const created = await this.query<{
        issueLabelCreate: { success: boolean; issueLabel: { id: string } | null };
      }>(
        `mutation($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) { success issueLabel { id } }
        }`,
        { input: { name, teamId, color: '#9CA3AF' } },
      );
      if (!created.issueLabelCreate.success || !created.issueLabelCreate.issueLabel) {
        throw new LinearError(`Failed to create label '${name}' on team ${teamId}`);
      }
      id = created.issueLabelCreate.issueLabel.id;
      logger.info('Created Linear label', { name, team_id: teamId });
    }
    this.labelIdCache.set(cacheKey, id);
    return id;
  }

  async resolveStateId(teamId: string, name: string): Promise<string> {
    const cacheKey = `${teamId}:${name}`;
    const cached = this.stateIdCache.get(cacheKey);
    if (cached) return cached;
    const data = await this.query<{ workflowStates: { nodes: LinearWorkflowState[] } }>(
      `query($filter: WorkflowStateFilter) {
        workflowStates(filter: $filter, first: 10) { nodes { id name type } }
      }`,
      { filter: { team: { id: { eq: teamId } }, name: { eqIgnoreCase: name } } },
    );
    const id = data.workflowStates.nodes[0]?.id;
    if (!id) {
      throw new LinearError(`No Linear workflow state named '${name}' on team ${teamId}`);
    }
    this.stateIdCache.set(cacheKey, id);
    return id;
  }

  /** Eagerly create the four state-machine labels (Section 12.4). */
  async ensureGaggleLabels(): Promise<void> {
    const team = await this.resolveTeam();
    for (const label of [
      this.cfg.tracker.gaggle_labels.claimed,
      this.cfg.tracker.gaggle_labels.queued,
      this.cfg.tracker.gaggle_labels.running,
      this.cfg.tracker.gaggle_labels.waiting_human,
    ]) {
      await this.ensureLabelExists(team.id, label);
    }
  }
}

// ─── normalization ──────────────────────────────────────────────────────────
interface RawLinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  url: string | null;
  branchName?: string | null;
  state: { name: string } | null;
  labels: { nodes: Array<{ name: string }> } | null;
  parent: { id: string } | null;
  createdAt: string | null;
  updatedAt: string | null;
  inverseRelations?: { nodes: Array<{ type: string; issue: { id: string; identifier: string; state: { name: string } | null; labels: { nodes: Array<{ name: string }> } | null } }> } | null;
}

const ISSUES_QUERY = `
  query($filter: IssueFilter, $first: Int) {
    issues(filter: $filter, first: $first) {
      nodes {
        id
        identifier
        title
        description
        priority
        url
        branchName
        state { name }
        labels { nodes { name } }
        parent { id }
        createdAt
        updatedAt
        inverseRelations {
          nodes {
            type
            issue {
              id
              identifier
              state { name }
              labels { nodes { name } }
            }
          }
        }
      }
    }
  }
`;

function normalizeIssue(raw: RawLinearIssue): Issue {
  const labels = (raw.labels?.nodes ?? []).map((l) => l.name.toLowerCase());
  const blocked_by: BlockerRef[] = (raw.inverseRelations?.nodes ?? [])
    .filter((r) => (r.type ?? '').toLowerCase() === 'blocks')
    .map((r) => ({
      id: r.issue?.id ?? null,
      identifier: r.issue?.identifier ?? null,
      state: r.issue?.state?.name ?? null,
      labels: (r.issue?.labels?.nodes ?? []).map((l) => l.name.toLowerCase()),
    }));

  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description ?? null,
    priority: raw.priority ?? null,
    state: raw.state?.name ?? '',
    branch_name: raw.branchName ?? null,
    url: raw.url ?? null,
    labels,
    blocked_by,
    created_at: raw.createdAt,
    updated_at: raw.updatedAt,
    parent_id: raw.parent?.id ?? null,
  };
}
