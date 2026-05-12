import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowDefinition, splitFrontMatter } from '../config/loader.ts';
import { buildServiceConfig } from '../config/service-config.ts';
import { parseGaggleMd } from '../registry/gaggle-md.ts';
import { applyNameCollisions } from '../registry/repo-syncer.ts';
import { blockersSatisfied, isBlockerSatisfied, repoTargetReady } from '../orchestrator/readiness.ts';
import {
  availableSlots,
  buildSessionId,
  createInitialState,
  noRetryEntriesFor,
  noRunningWorkersFor,
  workerKey,
} from '../orchestrator/state.ts';
import { buildGaggleEnv } from '../workspace/message.ts';
import { sanitizeId, deriveRepoSlug, parseGithubOwnerRepo, isInside, expandPath, expandEnvString } from '../util/paths.ts';
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

describe('gaggle.md parser', () => {
  test('parses valid file', () => {
    const text = `---
name: my-svc
description: Does things.
default_workflow: gaggle/gaggle-fix-issue
components:
  - name: my-svc-api
    description: REST surface
    component_type: ecs_service
---

Body text here.
`;
    const r = parseGaggleMd(text, 'test');
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
    expect(() => parseGaggleMd(text, 'test')).toThrow(/'name' is required/);
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
    expect(() => parseGaggleMd(text, 'test')).toThrow(/match/);
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

  describe('deriveRepoSlug', () => {
    test('strips .git suffix', () => {
      expect(deriveRepoSlug('https://github.com/foo/bar.git')).toBe('bar');
    });
    test('handles trailing slash', () => {
      expect(deriveRepoSlug('https://github.com/foo/bar/')).toBe('bar');
    });
    test('throws on empty string', () => {
      expect(() => deriveRepoSlug('')).toThrow('Cannot derive slug from empty URL');
    });
  });

  describe('parseGithubOwnerRepo', () => {
    test('parses HTTPS URL', () => {
      expect(parseGithubOwnerRepo('https://github.com/foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
      expect(parseGithubOwnerRepo('https://github.com/foo/bar.git')).toEqual({ owner: 'foo', repo: 'bar' });
    });
    test('parses standard SSH URL', () => {
      expect(parseGithubOwnerRepo('git@github.com:foo/bar.git')).toEqual({ owner: 'foo', repo: 'bar' });
    });
    test('parses SSH URL with custom host alias', () => {
      expect(parseGithubOwnerRepo('git@github-trabajo:Third-Opinion/TrialMatch-BE.git')).toEqual({
        owner: 'Third-Opinion', repo: 'TrialMatch-BE',
      });
    });
    test('throws on invalid URL', () => {
      expect(() => parseGithubOwnerRepo('not-a-url')).toThrow('Invalid GitHub URL');
      expect(() => parseGithubOwnerRepo('https://gitlab.com/foo/bar')).toThrow('Invalid GitHub URL');
    });
  });

  describe('expandPath', () => {
    test('replaces ~ with home dir', () => {
      const { homedir } = require('node:os');
      expect(expandPath('~/foo/bar')).toContain(homedir());
      expect(expandPath('~/foo/bar')).not.toContain('~');
    });
    test('resolves $VAR references', () => {
      process.env.__GAGGLE_TEST_VAR__ = '/injected';
      expect(expandPath('$__GAGGLE_TEST_VAR__/sub')).toContain('injected');
      delete process.env.__GAGGLE_TEST_VAR__;
    });
    test('resolves relative paths against baseDir', () => {
      const result = expandPath('sub/dir', '/base');
      // On POSIX: /base/sub/dir; on Windows: \base\sub\dir — just check containment
      expect(result).toContain('base');
      expect(result).toContain('sub');
    });
    test('returns empty string unchanged', () => {
      expect(expandPath('')).toBe('');
    });
  });

  describe('expandEnvString', () => {
    test('expands $VAR in a string', () => {
      process.env.__GAGGLE_STR_TEST__ = 'hello';
      expect(expandEnvString('$__GAGGLE_STR_TEST__')).toBe('hello');
      delete process.env.__GAGGLE_STR_TEST__;
    });
    test('replaces missing var with empty string', () => {
      expect(expandEnvString('$__DEFINITELY_NOT_SET_12345__')).toBe('');
    });
    test('returns input unchanged when no $ present', () => {
      expect(expandEnvString('no-vars-here')).toBe('no-vars-here');
    });
    test('returns empty string unchanged', () => {
      expect(expandEnvString('')).toBe('');
    });
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
      gaggle_labels: {
        claimed: 'gaggle:claimed', queued: 'gaggle:queued',
        running: 'gaggle:running', waiting_human: 'gaggle:waiting-human',
      },
    },
  } as unknown as ServiceConfig;

  const mergedCfg = {
    ...baseCfg,
    tracker: { ...baseCfg.tracker, blocker_default_readiness: 'merged' },
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

  test('blocker_satisfied_states acts as fallback when env tracking present but no label', () => {
    const cfgWithSatisfied = {
      ...baseCfg,
      tracker: { ...baseCfg.tracker, blocker_satisfied_states: ['In Review'] },
    } as unknown as ServiceConfig;
    // No env label, not terminal, but state IS in blocker_satisfied_states → satisfied
    expect(isBlockerSatisfied({ state: 'In Review', labels: [] }, 'deployed', cfgWithSatisfied)).toBe(true);
    // State NOT in blocker_satisfied_states and no env label → not satisfied
    expect(isBlockerSatisfied({ state: 'In Progress', labels: [] }, 'deployed', cfgWithSatisfied)).toBe(false);
  });

  test('deployed readiness falls back to terminal_states when no env tracking configured', () => {
    const cfgNoEnv = {
      ...baseCfg,
      tracker: { ...baseCfg.tracker, deploy_env_labels: {} },
    } as unknown as ServiceConfig;
    // No env tracking → terminal state alone is sufficient
    expect(isBlockerSatisfied({ state: 'Done', labels: [] }, 'deployed', cfgNoEnv)).toBe(true);
    expect(isBlockerSatisfied({ state: 'In Progress', labels: [] }, 'deployed', cfgNoEnv)).toBe(false);
  });

  describe('blockersSatisfied', () => {
    test('returns true when there are no blockers', () => {
      expect(blockersSatisfied([], mergedCfg)).toBe(true);
    });

    test('returns true when all blockers are satisfied', () => {
      const blockers = [
        { id: 'b1', identifier: 'SYM-1', state: 'Done', labels: [] },
        { id: 'b2', identifier: 'SYM-2', state: 'Done', labels: [] },
      ];
      expect(blockersSatisfied(blockers, mergedCfg)).toBe(true);
    });

    test('returns false when any single blocker is unsatisfied', () => {
      const blockers = [
        { id: 'b1', identifier: 'SYM-1', state: 'Done', labels: [] },
        { id: 'b2', identifier: 'SYM-2', state: 'In Progress', labels: [] },
      ];
      expect(blockersSatisfied(blockers, mergedCfg)).toBe(false);
    });

    test('returns false when all blockers are unsatisfied', () => {
      const blockers = [
        { id: 'b1', identifier: 'SYM-1', state: 'In Progress', labels: [] },
        { id: 'b2', identifier: 'SYM-2', state: 'Todo', labels: [] },
      ];
      expect(blockersSatisfied(blockers, mergedCfg)).toBe(false);
    });
  });

  describe('repoTargetReady', () => {
    const makeTarget = (depends_on: string[], ready_when = 'merged'): RepoTarget => ({
      repo_url: '', repo_alias: 'fe', local_path: '/fe',
      archon_workflow: 'wf', rationale: 'r', components: [],
      depends_on, ready_when,
    });

    test('returns true when target has no dependencies', () => {
      const state = createInitialState({ polling: { interval_ms: 1 }, agent: { max_concurrent_agents: 2 } } as unknown as ServiceConfig);
      expect(repoTargetReady(makeTarget([]), 'p1', state, mergedCfg)).toBe(true);
    });

    test('returns false when upstream sub-issue not in sibling_subissues yet', () => {
      const state = createInitialState({ polling: { interval_ms: 1 }, agent: { max_concurrent_agents: 2 } } as unknown as ServiceConfig);
      // No sibling_subissues entry → upstream not dispatched
      expect(repoTargetReady(makeTarget(['be']), 'p1', state, mergedCfg)).toBe(false);
    });

    test('returns true when upstream is in sibling_subissues and snapshot is Done', () => {
      const state = createInitialState({ polling: { interval_ms: 1 }, agent: { max_concurrent_agents: 2 } } as unknown as ServiceConfig);
      state.sibling_subissues.set('p1', new Map([['be', 'sub-be']]));
      state.subissue_snapshot.set('sub-be', { state: 'Done', labels: [], refreshed_at: Date.now() });
      expect(repoTargetReady(makeTarget(['be']), 'p1', state, mergedCfg)).toBe(true);
    });

    test('returns false when upstream snapshot state is In Progress', () => {
      const state = createInitialState({ polling: { interval_ms: 1 }, agent: { max_concurrent_agents: 2 } } as unknown as ServiceConfig);
      state.sibling_subissues.set('p1', new Map([['be', 'sub-be']]));
      state.subissue_snapshot.set('sub-be', { state: 'In Progress', labels: [], refreshed_at: Date.now() });
      expect(repoTargetReady(makeTarget(['be']), 'p1', state, mergedCfg)).toBe(false);
    });

    test('returns true when upstream is in target_machine_states succeeded (no sibling entry needed)', () => {
      const state = createInitialState({ polling: { interval_ms: 1 }, agent: { max_concurrent_agents: 2 } } as unknown as ServiceConfig);
      state.target_machine_states.set(workerKey('p1', 'be'), 'succeeded');
      // No sibling_subissues — relies on completed set
      expect(repoTargetReady(makeTarget(['be']), 'p1', state, mergedCfg)).toBe(true);
    });

    test('completed shortcut only applies for merged readiness; deployed requires snapshot', () => {
      const deployedTarget = makeTarget(['be'], 'deployed');
      const state = createInitialState({ polling: { interval_ms: 1 }, agent: { max_concurrent_agents: 2 } } as unknown as ServiceConfig);
      // Key in completed but no sibling entry or snapshot → ready_when=deployed does NOT short-circuit
      state.target_machine_states.set(workerKey('p1', 'be'), 'succeeded');
      expect(repoTargetReady(deployedTarget, 'p1', state, baseCfg)).toBe(false);
    });

    test('returns false when sibling entry exists but snapshot is missing', () => {
      const state = createInitialState({ polling: { interval_ms: 1 }, agent: { max_concurrent_agents: 2 } } as unknown as ServiceConfig);
      state.sibling_subissues.set('p1', new Map([['be', 'sub-be']]));
      // Snapshot not set → not ready
      expect(repoTargetReady(makeTarget(['be']), 'p1', state, mergedCfg)).toBe(false);
    });
  });
});

describe('buildGaggleEnv', () => {
  test('maps all expected keys', () => {
    const issue: Issue = {
      id: 'i1', identifier: 'SYM-1', title: 'A bug', description: null,
      priority: 1, state: 'In Progress', branch_name: null, url: 'https://x',
      labels: [], blocked_by: [], created_at: null, updated_at: null,
    };
    const target: RepoTarget = {
      repo_url: 'https://github.com/o/r', repo_alias: 'repo-r', local_path: '/r',
      archon_workflow: 'gaggle/fix', rationale: 'why', components: [],
    };
    const analysis: IssueAnalysis = { issue_id: 'i1', analysis_summary: 'summary', repo_targets: [] };
    const env = buildGaggleEnv({ issue, repo_target: target, analysis, attempt: null });
    expect(env.GAGGLE_ISSUE_ID).toBe('i1');
    expect(env.GAGGLE_ISSUE_IDENTIFIER).toBe('SYM-1');
    expect(env.GAGGLE_ISSUE_TITLE).toBe('A bug');
    expect(env.GAGGLE_REPO_ALIAS).toBe('repo-r');
    expect(env.GAGGLE_ARCHON_WORKFLOW).toBe('gaggle/fix');
    expect(env.GAGGLE_ATTEMPT).toBe('first');
    expect(env.GAGGLE_ANALYSIS_SUMMARY).toBe('summary');
  });

  test('encodes numeric attempt as string', () => {
    const issue: Issue = {
      id: 'i1', identifier: 'SYM-2', title: 'T', description: null,
      priority: 0, state: 'In Progress', branch_name: null, url: null,
      labels: [], blocked_by: [], created_at: null, updated_at: null,
    };
    const target: RepoTarget = { repo_url: '', repo_alias: 'r', local_path: '', archon_workflow: '', rationale: '', components: [] };
    const analysis: IssueAnalysis = { issue_id: 'i1', analysis_summary: '', repo_targets: [] };
    expect(buildGaggleEnv({ issue, repo_target: target, analysis, attempt: 2 }).GAGGLE_ATTEMPT).toBe('2');
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
      archon_workflow: 'gaggle/gaggle-fix-issue', rationale: 'why', components: ['c'],
    };
    const analysis: IssueAnalysis = {
      issue_id: 'iss-1', analysis_summary: 'sum', repo_targets: [target],
    };
    const msg = buildIssueMessage({ issue, repo_target: target, analysis, attempt: null });
    expect(msg).toContain('Issue: SYM-1 — A bug');
    expect(msg).toContain('Attempt: first');
    expect(msg).toContain('Scope: why');
    expect(msg).toContain('Analysis: sum');
    expect(msg).toContain('long body');
  });
});

describe('orchestrator state', () => {
  test('createInitialState produces empty maps/sets', () => {
    const cfg = { polling: { interval_ms: 1 }, agent: { max_concurrent_agents: 2 } } as unknown as ServiceConfig;
    const s = createInitialState(cfg);
    expect(s.running.size).toBe(0);
    expect(s.parent_machine_states.size).toBe(0);
    expect(s.target_machine_states.size).toBe(0);
    expect(s.poll_interval_ms).toBe(1);
  });

  test('workerKey produces deterministic "id__alias" string', () => {
    expect(workerKey('issue-1', 'repo-a')).toBe('issue-1__repo-a');
    expect(workerKey('i', 'r')).toBe('i__r');
  });

  test('buildSessionId encodes identifier, alias, and attempt', () => {
    expect(buildSessionId('SYM-1', 'repo-a', null)).toBe('SYM-1__repo-a__0');
    expect(buildSessionId('SYM-1', 'repo-a', 3)).toBe('SYM-1__repo-a__3');
  });

  test('availableSlots returns max_concurrent - running.size, floored at 0', () => {
    const s = createInitialState({ polling: { interval_ms: 1 }, agent: { max_concurrent_agents: 3 } } as unknown as ServiceConfig);
    expect(availableSlots(s)).toBe(3);
    s.running.set('k1', {} as never);
    s.running.set('k2', {} as never);
    expect(availableSlots(s)).toBe(1);
    s.running.set('k3', {} as never);
    expect(availableSlots(s)).toBe(0);
    s.running.set('k4', {} as never);
    expect(availableSlots(s)).toBe(0); // never goes negative
  });

  test('noRunningWorkersFor returns true when no key starts with issue_id', () => {
    const s = createInitialState({ polling: { interval_ms: 1 }, agent: { max_concurrent_agents: 2 } } as unknown as ServiceConfig);
    expect(noRunningWorkersFor(s, 'p1')).toBe(true);
    s.running.set('p1__repo-a', {} as never);
    expect(noRunningWorkersFor(s, 'p1')).toBe(false);
    expect(noRunningWorkersFor(s, 'p2')).toBe(true); // p2 has no workers
  });

  test('noRetryEntriesFor returns true when no retry key starts with issue_id', () => {
    const s = createInitialState({ polling: { interval_ms: 1 }, agent: { max_concurrent_agents: 2 } } as unknown as ServiceConfig);
    expect(noRetryEntriesFor(s, 'p1')).toBe(true);
    s.retry_attempts.set('p1__repo-b', {} as never);
    expect(noRetryEntriesFor(s, 'p1')).toBe(false);
    expect(noRetryEntriesFor(s, 'p2')).toBe(true);
  });
});
