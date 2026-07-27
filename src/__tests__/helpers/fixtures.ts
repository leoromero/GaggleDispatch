/**
 * Shared test fixtures and helpers.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Issue,
  IssueAnalysis,
  RegistryComponent,
  RegistryContext,
  RegistryRepo,
  RepoTarget,
  ServiceConfig,
  SyncedRegistryRepoEntry,
} from '../../domain/types.ts';

export function tmp(prefix = 'gaggle-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'iss-1',
    identifier: 'SYM-1',
    title: 'Sample issue',
    description: 'A description',
    priority: 1,
    state: 'In Progress',
    branch_name: null,
    url: 'https://linear.app/x/issue/SYM-1',
    labels: [],
    blocked_by: [],
    created_at: '2026-05-09T00:00:00Z',
    updated_at: '2026-05-09T00:00:00Z',
    parent_id: null,
    ...overrides,
  };
}

export function makeRepoTarget(overrides: Partial<RepoTarget> = {}): RepoTarget {
  return {
    repo_url: 'https://github.com/o/repo-a',
    repo_alias: 'repo-a',
    local_path: '/tmp/checkouts/repo-a',
    workflow: 'gaggle/gaggle-fix-issue',
    rationale: 'because',
    components: ['comp-a'],
    ...overrides,
  };
}

export function makeAnalysis(targets: RepoTarget[] = [makeRepoTarget()], summary = 'sum'): IssueAnalysis {
  return { issue_id: 'iss-1', analysis_summary: summary, repo_targets: targets };
}

export function makeRegistryRepo(overrides: Partial<RegistryRepo> = {}): RegistryRepo {
  return {
    name: 'repo-a',
    url: 'https://github.com/o/repo-a',
    local_path: '/tmp/checkouts/repo-a',
    description: 'desc',
    default_workflow: 'gaggle/gaggle-fix-issue',
    available_workflows: ['gaggle/gaggle-fix-issue', 'gaggle/gaggle-supervised'],
    components: [{ name: 'comp-a', description: 'cmp', component_type: 'ecs_service' }],
    narrative: 'narrative-a',
    ...overrides,
  };
}

export function makeRegistryContext(repos: RegistryRepo[] = [makeRegistryRepo()]): RegistryContext {
  const components: RegistryComponent[] = [];
  for (const r of repos) {
    for (const c of r.components) {
      components.push({ ...c, repo_name: r.name, repo_url: r.url, repo_local_path: r.local_path });
    }
  }
  return {
    repositories: repos,
    components,
    last_synced_at: new Date().toISOString(),
    warnings: [],
    repos_dir: '/tmp/checkouts',
  };
}

export function makeServiceConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      api_key: 'lin_test_key',
      project_slug: 'SYM',
      active_states: ['Todo', 'In Progress'],
      terminal_states: ['Done', 'Cancelled'],
      assigned_to_me: true,
      assigned_to_user_email: null,
      create_sub_issues: true,
      default_ready_env: 'dev',
      deploy_env_labels: { dev: 'deployed:dev', staging: 'deployed:staging', prod: 'deployed:prod' },
      blocker_satisfied_states: [],
      blocker_default_readiness: 'deployed',
      gate_waiting_state: null,
      gate_resume_state: null,
      pr_ready_state: null,
      gaggle_labels: {
        claimed: 'gaggle:claimed',
        queued: 'gaggle:queued',
        running: 'gaggle:running',
        waiting_human: 'gaggle:waiting-human',
        analyzing: 'gaggle:analyzing',
        dispatching: 'gaggle:dispatching',
        retrying: 'gaggle:retrying',
        failed: 'gaggle:failed',
      },
      auth: {
        mode: 'api_key',
        client_id: '',
        client_secret: '',
        redirect_uri: '',
        scopes: [],
      },
      mirror_labels: false,
      outbox_max_attempts: 5,
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: '/tmp/aux' },
    hooks: { before_run: null, after_run: null, timeout_ms: 60_000 },
    agent: {
      max_concurrent_agents: 5,
      max_turns: 20,
      max_retry_backoff_ms: 60_000,
      max_concurrent_agents_by_state: {},
    },
    executor: {
      command: 'archon workflow run',
      api_url: 'http://localhost:3090',
      poll_interval_ms: 5_000,
      turn_timeout_ms: 60_000,
      stall_timeout_ms: 30_000,
      default_workflow: 'gaggle/gaggle-fix-issue',
      gate_timeout_ms: 0,
      startup_cleanup_age_days: 0,
    },
    database: { url: '', max_connections: 0 },
    claude: {
      api_key: '',
      analyzer_model: 'claude-sonnet-4-5',
      analyzer_max_tokens: 1024,
      gate_classifier_model: 'claude-haiku-4-5-20251001',
    },
    workflow_templates: {
      path: '/tmp/templates',
      target_subdir: 'gaggle',
      sync_on_dispatch: false,
      reload_on_change: false,
    },
    registry: {
      base_folder: '/tmp/base',
      sync_interval_ms: 0,
      sync_on_startup: false,
      analysis_cache_ttl_ms: 300_000,
      auto_scaffold: false,
    },
    repositories: [{ url: 'https://github.com/o/repo-a', default_branch: 'main' }],
    prompt_template: '',
    workflow_md_path: '/tmp/WORKFLOW.md',
    project_dir: '/tmp/proj',
    ...overrides,
  };
}

export function makeSyncedEntry(overrides: Partial<SyncedRegistryRepoEntry> = {}): SyncedRegistryRepoEntry {
  return {
    url: 'https://github.com/o/repo-a',
    default_branch: 'main',
    slug: 'repo-a',
    local_path: '/tmp/checkouts/repo-a',
    last_synced_at: '2026-05-09T00:00:00Z',
    last_commit_sha: 'a'.repeat(40),
    sync_status: 'ok',
    sync_error: null,
    frontmatter: {
      name: 'repo-a',
      description: 'd',
      default_workflow: 'gaggle/gaggle-fix-issue',
      available_workflows: ['gaggle/gaggle-fix-issue'],
      components: [{ name: 'comp-a', description: 'c' }],
    },
    narrative: 'n',
    ...overrides,
  };
}

/** Write a minimal gaggle.md to a path. */
export function writeGaggleMd(path: string, opts: { name: string; component?: string } = { name: 'r' }): void {
  mkdirSync(path.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  const compName = opts.component ?? `${opts.name}-api`;
  writeFileSync(
    path,
    `---
name: ${opts.name}
description: A test repo.
default_workflow: gaggle/gaggle-fix-issue
available_workflows:
  - gaggle/gaggle-fix-issue
components:
  - name: ${compName}
    description: A component.
    component_type: ecs_service
---

Body of the gaggle.md.
`,
  );
}
