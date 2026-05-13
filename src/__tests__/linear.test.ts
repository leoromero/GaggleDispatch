/**
 * Linear adapter tests — stubs `globalThis.fetch` so we can exercise all 10
 * required operations from Section 12.1 without hitting the real API.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { LinearClient } from '../tracker/linear.ts';
import { makeServiceConfig } from './helpers/fixtures.ts';

interface FetchCall {
  url: string;
  body: { query: string; variables?: Record<string, unknown> };
}

let fetchCalls: FetchCall[] = [];
let responses: Array<unknown | ((body: FetchCall['body']) => unknown)> = [];
let originalFetch: typeof fetch;

function stubFetch() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    fetchCalls.push({ url, body });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error(`No stubbed response for fetch to ${url}: ${body.query?.slice(0, 80)}`);
    }
    const data = typeof next === 'function' ? (next as (b: FetchCall['body']) => unknown)(body) : next;
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function enqueue(...payloads: Array<unknown | ((b: FetchCall['body']) => unknown)>) {
  responses.push(...payloads);
}

function teamResolution(teamId = 't1', key = 'SYM') {
  // Two team queries (key first, name fallback). Return team on first.
  return [{ data: { teams: { nodes: [{ id: teamId, key, name: 'Symphony' }] } } }];
}

beforeEach(() => {
  fetchCalls = [];
  responses = [];
  stubFetch();
});

afterEach(() => {
  restoreFetch();
});

describe('LinearClient.query', () => {
  test('throws LinearError on non-OK HTTP status', async () => {
    const c = new LinearClient(makeServiceConfig());
    // Override stubFetch to return a 401
    globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch;
    await expect(c.resolveViewerId()).rejects.toThrow('Linear HTTP 401');
  });

  test('throws LinearError on GraphQL errors array', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({ errors: [{ message: 'Field not found' }] });
    await expect(c.resolveViewerId()).rejects.toThrow('Linear GraphQL errors: Field not found');
  });

  test('throws LinearError when response has no data field', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({ });
    await expect(c.resolveViewerId()).rejects.toThrow('Linear response missing data');
  });
});

describe('LinearClient constructor', () => {
  test('throws when api_key is empty', () => {
    const cfg = makeServiceConfig();
    cfg.tracker.api_key = '';
    expect(() => new LinearClient(cfg)).toThrow('LINEAR_API_KEY is missing or empty');
  });
});

describe('LinearClient.resolveTeam', () => {
  test('falls back to name match when key query returns empty', async () => {
    const c = new LinearClient(makeServiceConfig());
    // First query (key match) returns empty nodes
    enqueue({ data: { teams: { nodes: [] } } });
    // Second query (name match) returns the team
    enqueue({ data: { teams: { nodes: [{ id: 'team-1', key: 'SYM', name: 'Symphony' }] } } });
    const team = await c.resolveTeam();
    expect(team.id).toBe('team-1');
    expect(fetchCalls.length).toBe(2);
  });

  test('throws when both key and name queries return empty', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({ data: { teams: { nodes: [] } } });
    enqueue({ data: { teams: { nodes: [] } } });
    await expect(c.resolveTeam()).rejects.toThrow("No Linear team matched project_slug='SYM'");
  });
});

describe('LinearClient.resolveStateId', () => {
  test('throws LinearError when state name is not found', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({ data: { workflowStates: { nodes: [] } } });
    await expect(
      (c as unknown as { resolveStateId(t: string, n: string): Promise<string> }).resolveStateId('team-1', 'UnknownState'),
    ).rejects.toThrow("No Linear workflow state named 'UnknownState'");
  });

  test('caches state id on second call (no second fetch)', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({ data: { workflowStates: { nodes: [{ id: 'ws-1', name: 'Done', type: 'completed' }] } } });
    const id1 = await (c as unknown as { resolveStateId(t: string, n: string): Promise<string> }).resolveStateId('team-1', 'Done');
    const id2 = await (c as unknown as { resolveStateId(t: string, n: string): Promise<string> }).resolveStateId('team-1', 'Done');
    expect(id1).toBe('ws-1');
    expect(id2).toBe('ws-1');
    expect(fetchCalls.length).toBe(1); // second call served from cache
  });
});

describe('LinearClient.resolveViewerId', () => {
  test('returns viewer.id and caches', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({ data: { viewer: { id: 'u1', name: 'Jane', email: 'jane@x' } } });
    const id = await c.resolveViewerId();
    expect(id).toBe('u1');
    // No second call expected on cache hit
    const id2 = await c.resolveViewerId();
    expect(id2).toBe('u1');
    expect(fetchCalls.length).toBe(1);
  });
});

describe('LinearClient.fetchCandidateIssues', () => {
  test('passes assignee filter when assigned_to_me is true', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue(...teamResolution());
    enqueue({ data: { viewer: { id: 'u1', name: 'Jane', email: 'jane@x' } } });
    enqueue({
      data: {
        issues: {
          nodes: [
            {
              id: 'i1',
              identifier: 'SYM-1',
              title: 'A',
              description: 'd',
              priority: 1,
              url: 'https://x/SYM-1',
              branchName: 'sym-1',
              state: { name: 'In Progress' },
              labels: { nodes: [{ name: 'BUG' }] },
              parent: null,
              createdAt: '2026-05-09T00:00:00Z',
              updatedAt: '2026-05-09T00:00:00Z',
              inverseRelations: {
                nodes: [
                  {
                    type: 'blocks',
                    issue: {
                      id: 'b1',
                      identifier: 'SYM-2',
                      state: { name: 'In Progress' },
                      labels: { nodes: [{ name: 'deployed:dev' }] },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    });

    const issues = await c.fetchCandidateIssues();
    expect(issues.length).toBe(1);
    expect(issues[0]!.identifier).toBe('SYM-1');
    expect(issues[0]!.labels).toEqual(['bug']);
    expect(issues[0]!.blocked_by.length).toBe(1);
    expect(issues[0]!.blocked_by[0]!.labels).toEqual(['deployed:dev']);

    const issuesQuery = fetchCalls[2]!.body.variables as { filter: { assignee?: { id: { eq: string } } } };
    expect(issuesQuery.filter.assignee?.id.eq).toBe('u1');
  });

  test('omits assignee filter when assigned_to_me is false', async () => {
    const cfg = makeServiceConfig();
    cfg.tracker.assigned_to_me = false;
    const c = new LinearClient(cfg);
    enqueue(...teamResolution());
    enqueue({ data: { issues: { nodes: [] } } });
    await c.fetchCandidateIssues();
    const variables = fetchCalls[1]!.body.variables as { filter: Record<string, unknown> };
    expect(variables.filter).not.toHaveProperty('assignee');
  });
});

describe('LinearClient.fetchIssueStatesByIds', () => {
  test('returns empty for empty input without calling API', async () => {
    const c = new LinearClient(makeServiceConfig());
    const r = await c.fetchIssueStatesByIds([]);
    expect(r).toEqual([]);
    expect(fetchCalls.length).toBe(0);
  });

  test('queries by id filter', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({
      data: {
        issues: {
          nodes: [
            {
              id: 'i1',
              identifier: 'SYM-1',
              title: 'T',
              description: null,
              priority: null,
              url: null,
              state: { name: 'Done' },
              labels: { nodes: [] },
              parent: null,
              createdAt: null,
              updatedAt: null,
              inverseRelations: { nodes: [] },
            },
          ],
        },
      },
    });
    const r = await c.fetchIssueStatesByIds(['i1']);
    expect(r[0]!.state).toBe('Done');
  });
});

describe('LinearClient sub-issue + state + comment + label ops', () => {
  test('createSubIssue resolves team and state then mutates', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue(...teamResolution()); // team
    enqueue({ data: { workflowStates: { nodes: [{ id: 'st1', name: 'In Progress', type: 'started' }] } } }); // state
    enqueue({ data: { issueCreate: { success: true, issue: { id: 'i2', identifier: 'SYM-2' } } } });
    const result = await c.createSubIssue({
      parent_id: 'i1',
      title: '[repo-a] X',
      assignee_id: 'u1',
      state_name: 'In Progress',
    });
    expect(result.id).toBe('i2');

    const mutationVars = fetchCalls[2]!.body.variables as { input: Record<string, unknown> };
    expect(mutationVars.input.parentId).toBe('i1');
    expect(mutationVars.input.assigneeId).toBe('u1');
    expect(mutationVars.input.stateId).toBe('st1');
  });

  test('updateIssueState resolves state id then calls issueUpdate', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue(...teamResolution());
    enqueue({ data: { workflowStates: { nodes: [{ id: 'st-done', name: 'Done', type: 'completed' }] } } });
    enqueue({ data: { issueUpdate: { success: true } } });
    await c.updateIssueState('i1', 'Done');
    expect(fetchCalls[2]!.body.query).toContain('issueUpdate');
  });

  test('postComment returns created comment id', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({ data: { commentCreate: { success: true, comment: { id: 'c1' } } } });
    const r = await c.postComment('i1', 'hello');
    expect(r.id).toBe('c1');
  });

  test('postComment throws on success=false', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({ data: { commentCreate: { success: false, comment: null } } });
    await expect(c.postComment('i1', 'x')).rejects.toThrow();
  });

  test('applyLabel creates label when missing then attaches it', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue(...teamResolution());
    enqueue({ data: { issueLabels: { nodes: [] } } }); // no existing label
    enqueue({ data: { issueLabelCreate: { success: true, issueLabel: { id: 'lbl1' } } } });
    enqueue({ data: { issueAddLabel: { success: true } } });
    await c.applyLabel('i1', 'gaggle:running');
    expect(fetchCalls[fetchCalls.length - 1]!.body.query).toContain('issueAddLabel');
  });

  test('applyLabel uses cached label id on second call', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue(...teamResolution());
    enqueue({ data: { issueLabels: { nodes: [{ id: 'lbl1', name: 'gaggle:claimed' }] } } });
    enqueue({ data: { issueAddLabel: { success: true } } });
    await c.applyLabel('i1', 'gaggle:claimed');
    enqueue({ data: { issueAddLabel: { success: true } } }); // no additional label fetch
    await c.applyLabel('i2', 'gaggle:claimed');
    // 4 calls total: team, label fetch, add, add
    expect(fetchCalls.length).toBe(4);
  });

  test('removeLabel issues issueRemoveLabel', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue(...teamResolution());
    enqueue({ data: { issueLabels: { nodes: [{ id: 'lbl1', name: 'gaggle:running' }] } } });
    enqueue({ data: { issueRemoveLabel: { success: true } } });
    await c.removeLabel('i1', 'gaggle:running');
    expect(fetchCalls[2]!.body.query).toContain('issueRemoveLabel');
  });
});

describe('LinearClient.fetchIssueComments', () => {
  test('returns normalized records sorted by API order', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({
      data: {
        issue: {
          comments: {
            nodes: [
              { id: 'c1', body: 'first', createdAt: '2026-05-09T00:00:00Z', user: { id: 'u2', name: 'Bob', email: 'b@x' } },
              { id: 'c2', body: 'second', createdAt: '2026-05-09T00:01:00Z', user: null },
            ],
          },
        },
      },
    });
    const r = await c.fetchIssueComments('i1');
    expect(r.length).toBe(2);
    expect(r[1]!.body).toBe('second');
    expect(r[1]!.author.id).toBe(null);
  });

  test('returns [] when issue is null', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({ data: { issue: null } });
    const r = await c.fetchIssueComments('i1');
    expect(r).toEqual([]);
  });
});

describe('LinearClient error handling', () => {
  test('throws on GraphQL errors', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({ errors: [{ message: 'bad token' }] });
    await expect(c.resolveViewerId()).rejects.toThrow(/bad token/);
  });

  test('throws on missing api_key', () => {
    const cfg = makeServiceConfig();
    cfg.tracker.api_key = '';
    expect(() => new LinearClient(cfg)).toThrow(/missing/i);
  });
});

describe('LinearClient.fetchIssuesByLabel', () => {
  test('queries labels filter and normalizes', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue(...teamResolution());
    enqueue({
      data: {
        issues: {
          nodes: [
            {
              id: 'i1',
              identifier: 'SYM-1',
              title: '[repo-a] X',
              description: null,
              priority: null,
              url: null,
              state: { name: 'In Progress' },
              labels: { nodes: [{ name: 'gaggle:running' }] },
              parent: { id: 'parent-1' },
              createdAt: null,
              updatedAt: null,
              inverseRelations: { nodes: [] },
            },
          ],
        },
      },
    });
    const r = await c.fetchIssuesByLabel('gaggle:running');
    expect(r.length).toBe(1);
    expect(r[0]!.parent_id).toBe('parent-1');
  });
});

describe('LinearClient.ensureGaggleLabels', () => {
  test('creates all eight labels when none exist', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue(...teamResolution()); // team
    // 8 labels (claimed/queued/running/waiting-human + analyzing/dispatching/retrying/failed)
    // × (fetch + create) = 16 calls
    for (let i = 0; i < 8; i++) {
      enqueue({ data: { issueLabels: { nodes: [] } } });
      enqueue({ data: { issueLabelCreate: { success: true, issueLabel: { id: `lbl${i}` } } } });
    }
    await c.ensureGaggleLabels();
    expect(fetchCalls.length).toBe(17); // 1 team + 16 label
  });
});

describe('LinearClient.createBlockerRelation', () => {
  test('calls issueRelationCreate with type=blocks', async () => {
    const c = new LinearClient(makeServiceConfig());
    enqueue({ data: { issueRelationCreate: { success: true } } });
    await c.createBlockerRelation('upstream-id', 'downstream-id');
    expect(fetchCalls.length).toBe(1);
    const q = fetchCalls[0]!.body.query;
    expect(q).toContain('issueRelationCreate');
    const vars = fetchCalls[0]!.body.variables as { input: { issueId: string; relatedIssueId: string; type: string } };
    expect(vars.input.issueId).toBe('upstream-id');
    expect(vars.input.relatedIssueId).toBe('downstream-id');
    expect(vars.input.type).toBe('blocks');
  });
});
