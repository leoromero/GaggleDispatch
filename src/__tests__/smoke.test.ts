import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowDefinition, splitFrontMatter } from '../config/loader.ts';
import { buildServiceConfig } from '../config/service-config.ts';
import { parseSymphonyMd } from '../registry/symphony-md.ts';
import { applyNameCollisions } from '../registry/repo-syncer.ts';
import { isBlockerSatisfied, repoTargetReady } from '../orchestrator/readiness.ts';
import { createInitialState } from '../orchestrator/state.ts';
import { sanitizeId, deriveRepoSlug, parseGithubOwnerRepo, isInside } from '../util/paths.ts';
import { buildIssueMessage } from '../workspace/message.ts';
import type { Issue, IssueAnalysis, RepoTarget, ServiceConfig, SyncedRegistryRepoEntry } from '../domain/types.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gaggle-test-'));
}

describe('config loader', () => {
  test('parses front matter and prompt body', () => {
    const dir = tmp();
    const baseFolder = tmp(); // outside dir
    const wf = `---
tracker:
  kind: linear
  api_key: literal-key
  project_slug: SYM
workflow_templates:
  path: workflow_templates/
registry:
  base_folder: ${baseFolder.replace(/\\/g, '\\\\')}
repositories:
  - url: https://github.com/foo/bar
    default_branch: main
---

# Body
`;
    writeFileSync(join(dir, 'WORKFLOW.md'), wf);
    const def = loadWorkflowDefinition({ cwd: dir });
    expect(def.prompt_template.startsWith('# Body')).toBe(true);
    const cfg = buildServiceConfig(def);
    expect(cfg.tracker.kind).toBe('linear');
    expect(cfg.tracker.api_key).toBe('literal-key');
    expect(cfg.repositories.length).toBe(1);
    expect(cfg.repositories[0]!.default_branch).toBe('main');
  });

  test('parses front matter when preceded by an HTML comment banner', () => {
    const dir = tmp();
    const baseFolder = tmp();
    const wf = `<!--
  Bootstrapped by gaggle init. Edit freely.
-->
---
tracker:
  kind: linear
  api_key: literal-key
  project_slug: SYM
workflow_templates:
  path: workflow_templates/
registry:
  base_folder: ${baseFolder.replace(/\\/g, '\\\\')}
repositories: []
---

# Body
`;
    writeFileSync(join(dir, 'WORKFLOW.md'), wf);
    const def = loadWorkflowDefinition({ cwd: dir });
    const cfg = buildServiceConfig(def);
    expect(cfg.tracker.project_slug).toBe('SYM');
    expect(cfg.repositories.length).toBe(0);
  });

  test('splitFrontMatter ignores leading preamble before ---', () => {
    const r = splitFrontMatter(`<!-- preamble -->\n---\nfoo: bar\n---\n\nbody\n`);
    expect((r.config as { foo: string }).foo).toBe('bar');
    expect(r.prompt_template.trim()).toBe('body');
  });

  test('rejects base_folder inside project dir', () => {
    const dir = tmp();
    const wf = `---
tracker:
  kind: linear
  api_key: x
  project_slug: SYM
workflow_templates:
  path: workflow_templates/
registry:
  base_folder: ${dir.replace(/\\/g, '\\\\')}/inside
repositories: []
---
`;
    writeFileSync(join(dir, 'WORKFLOW.md'), wf);
    const def = loadWorkflowDefinition({ cwd: dir });
    expect(() => buildServiceConfig(def)).toThrow();
  });

  test('splitFrontMatter handles missing front matter', () => {
    const r = splitFrontMatter('hello');
    expect(r.config).toEqual({});
    expect(r.prompt_template).toBe('hello');
  });
});

describe('symphony.md parser', () => {
  test('parses valid file', () => {
    const text = `---
name: my-svc
description: Does things.
default_workflow: symphony/symphony-fix-issue
components:
  - name: my-svc-api
    description: REST surface
    component_type: ecs_service
---

Body text here.
`;
    const r = parseSymphonyMd(text, 'test');
    expect(r.frontmatter.name).toBe('my-svc');
    expect(r.frontmatter.components.length).toBe(1);
    expect(r.narrative).toContain('Body text here');
  });

  test('rejects missing name', () => {
    const text = `---
description: x
default_workflow: y
components:
  - name: c
    description: d
---
`;
    expect(() => parseSymphonyMd(text, 'test')).toThrow(/'name' is required/);
  });

  test('rejects bad name pattern', () => {
    const text = `---
name: BadName
description: x
default_workflow: y
components:
  - name: c
    description: d
---
`;
    expect(() => parseSymphonyMd(text, 'test')).toThrow(/match/);
  });
});

describe('name collision detection', () => {
  test('marks loser as error', () => {
    const a: SyncedRegistryRepoEntry = {
      url: 'a', default_branch: 'main', slug: 'a', local_path: '/a', last_synced_at: null, last_commit_sha: null,
      sync_status: 'ok', sync_error: null,
      frontmatter: { name: 'svc', description: '', default_workflow: 'w', components: [{ name: 'c1', description: 'd' }] },
      narrative: '',
    };
    const b: SyncedRegistryRepoEntry = {
      ...a, url: 'b', slug: 'b', local_path: '/b',
      frontmatter: { name: 'svc', description: '', default_workflow: 'w', components: [{ name: 'c2', description: 'd' }] },
    };
    const out = applyNameCollisions([a, b]);
    expect(out[0]!.sync_status).toBe('ok');
    expect(out[1]!.sync_status).toBe('error');
    expect(out[1]!.sync_error).toContain('Repository name collision');
  });
});

describe('utility helpers', () => {
  test('sanitizeId', () => {
    expect(sanitizeId('a/b c.d')).toBe('a_b_c.d');
  });
  test('deriveRepoSlug', () => {
    expect(deriveRepoSlug('https://github.com/foo/bar.git')).toBe('bar');
    expect(deriveRepoSlug('https://github.com/foo/bar/')).toBe('bar');
  });
  test('parseGithubOwnerRepo', () => {
    expect(parseGithubOwnerRepo('https://github.com/foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
    expect(parseGithubOwnerRepo('https://github.com/foo/bar.git')).toEqual({ owner: 'foo', repo: 'bar' });
  });
  test('isInside', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/x', '/a/b')).toBe(false);
  });
});

describe('readiness predicate', () => {
  const baseCfg = {
    tracker: {
      kind: 'linear' as const,
      endpoint: '', api_key: 'x', project_slug: 'X',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done'],
      assigned_to_me: true, create_sub_issues: true,
      default_ready_env: 'dev',
      deploy_env_labels: { dev: 'deployed:dev', staging: 'deployed:staging', prod: 'deployed:prod' },
      blocker_satisfied_states: [],
      blocker_default_readiness: 'deployed',
      gate_waiting_state: null, gate_resume_state: null,
      symphony_labels: {
        claimed: 'symphony:claimed', queued: 'symphony:queued',
        running: 'symphony:running', waiting_human: 'symphony:waiting-human',
      },
    },
  } as unknown as ServiceConfig;

  test('merged means terminal state', () => {
    expect(isBlockerSatisfied({ state: 'Done', labels: [] }, 'merged', baseCfg)).toBe(true);
    expect(isBlockerSatisfied({ state: 'In Progress', labels: [] }, 'merged', baseCfg)).toBe(false);
  });

  test('deployed checks env label', () => {
    expect(isBlockerSatisfied({ state: 'In Progress', labels: ['deployed:dev'] }, 'deployed', baseCfg)).toBe(true);
    expect(isBlockerSatisfied({ state: 'In Progress', labels: [] }, 'deployed', baseCfg)).toBe(false);
  });

  test('deployed:env checks specific env', () => {
    expect(isBlockerSatisfied({ state: 'X', labels: ['deployed:prod'] }, 'deployed:prod', baseCfg)).toBe(true);
    expect(isBlockerSatisfied({ state: 'X', labels: ['deployed:dev'] }, 'deployed:prod', baseCfg)).toBe(false);
  });
});

describe('issue message construction', () => {
  test('renders required fields', () => {
    const issue: Issue = {
      id: 'iss-1', identifier: 'SYM-1', title: 'A bug', description: 'long body',
      priority: 1, state: 'In Progress', branch_name: null, url: 'https://x', labels: ['bug'],
      blocked_by: [], created_at: null, updated_at: null,
    };
    const target: RepoTarget = {
      repo_url: 'https://github.com/o/r', repo_alias: 'r', local_path: '/r',
      archon_workflow: 'symphony/symphony-fix-issue', rationale: 'why', components: ['c'],
    };
    const analysis: IssueAnalysis = {
      issue_id: 'iss-1', analysis_summary: 'sum', repo_targets: [target],
    };
    const msg = buildIssueMessage({ issue, repo_target: target, analysis, attempt: null });
    expect(msg).toContain('Issue: SYM-1 — A bug');
    expect(msg).toContain('Attempt: first');
    expect(msg).toContain('long body');
  });
});

describe('orchestrator state', () => {
  test('createInitialState produces empty maps/sets', () => {
    const cfg = { polling: { interval_ms: 1 }, agent: { max_concurrent_agents: 2 } } as unknown as ServiceConfig;
    const s = createInitialState(cfg);
    expect(s.running.size).toBe(0);
    expect(s.claimed.size).toBe(0);
    expect(s.poll_interval_ms).toBe(1);
  });
});
