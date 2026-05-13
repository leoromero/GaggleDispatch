/**
 * Service config builder (Section 6.1).
 *
 * Applies defaults, $VAR resolution, type coercion, and validation to the raw
 * front matter map produced by the workflow loader. Produces a typed `ServiceConfig`.
 */

import { dirname, isAbsolute, resolve } from 'node:path';
import { ConfigValidationError } from '../domain/errors.ts';
import type {
  ArchonConfig,
  AgentConfig,
  AuthConfig,
  ClaudeConfig,
  HooksConfig,
  PollingConfig,
  RegistryConfig,
  ServiceConfig,
  SourceRegistryEntry,
  GaggleLabels,
  TrackerConfig,
  WorkflowDefinition,
  WorkflowTemplatesConfig,
  WorkspaceConfig,
} from '../domain/types.ts';
import { validateRedirectUri } from '../tracker/linear-oauth.ts';
import { expandEnvString, expandPath, isInside } from '../util/paths.ts';

function asObject(v: unknown, name: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new ConfigValidationError(`${name} must be an object/map`);
  }
  return v as Record<string, unknown>;
}

function asArrayOfStrings(v: unknown, name: string, def: string[]): string[] {
  if (v === undefined || v === null) return def;
  if (!Array.isArray(v)) throw new ConfigValidationError(`${name} must be a list of strings`);
  return v.map((x, i) => {
    if (typeof x !== 'string') {
      throw new ConfigValidationError(`${name}[${i}] must be a string`);
    }
    return x;
  });
}

function asString(v: unknown, name: string, def?: string): string {
  if (v === undefined || v === null) {
    if (def !== undefined) return def;
    throw new ConfigValidationError(`${name} is required`);
  }
  if (typeof v !== 'string') throw new ConfigValidationError(`${name} must be a string`);
  return v;
}

function asOptionalString(v: unknown, name: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new ConfigValidationError(`${name} must be a string or null`);
  return v;
}

function asInt(v: unknown, name: string, def: number): number {
  if (v === undefined || v === null) return def;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ConfigValidationError(`${name} must be a number`);
    return Math.trunc(n);
  }
  throw new ConfigValidationError(`${name} must be a number`);
}

function asPositiveInt(v: unknown, name: string, def: number): number {
  const n = asInt(v, name, def);
  if (n <= 0) throw new ConfigValidationError(`${name} must be > 0`);
  return n;
}

function asBool(v: unknown, name: string, def: boolean): boolean {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  throw new ConfigValidationError(`${name} must be a boolean`);
}

function resolveSecretOrLiteral(v: string | undefined): string {
  if (v === undefined || v === null) return '';
  return expandEnvString(v);
}

/** Parse the optional `tracker.auth` block. Defaults to `mode: api_key` for
 *  backward compatibility with WORKFLOW.md files that don't declare auth.
 *  Throws ConfigValidationError on invalid OAuth shape. */
function parseAuthConfig(raw: unknown): AuthConfig {
  if (raw === undefined || raw === null) {
    return {
      mode: 'api_key',
      client_id: '',
      client_secret: '',
      redirect_uri: '',
      scopes: [],
    };
  }
  const obj = asObject(raw, 'tracker.auth');
  const mode = asString(obj.mode, 'tracker.auth.mode', 'api_key');
  if (mode !== 'api_key' && mode !== 'oauth') {
    throw new ConfigValidationError(`tracker.auth.mode must be 'api_key' or 'oauth', got '${mode}'`);
  }
  if (mode === 'api_key') {
    return { mode, client_id: '', client_secret: '', redirect_uri: '', scopes: [] };
  }
  const client_id = asString(obj.client_id, 'tracker.auth.client_id', '');
  if (!client_id) {
    throw new ConfigValidationError(
      "tracker.auth.client_id is required when tracker.auth.mode is 'oauth'",
    );
  }
  const client_secret = resolveSecretOrLiteral(
    asOptionalString(obj.client_secret, 'tracker.auth.client_secret') ?? '$LINEAR_OAUTH_CLIENT_SECRET',
  );
  if (!client_secret) {
    throw new ConfigValidationError(
      "tracker.auth.client_secret is empty (after $VAR resolution); set LINEAR_OAUTH_CLIENT_SECRET",
    );
  }
  const redirect_uri = asString(
    obj.redirect_uri,
    'tracker.auth.redirect_uri',
    'http://127.0.0.1:8765/oauth/callback',
  );
  const validationError = validateRedirectUri(redirect_uri);
  if (validationError) throw new ConfigValidationError(validationError);
  const scopes = asArrayOfStrings(obj.scopes, 'tracker.auth.scopes', ['read', 'write']);
  return { mode: 'oauth', client_id, client_secret, redirect_uri, scopes };
}

export function buildServiceConfig(def: WorkflowDefinition): ServiceConfig {
  const root = def.config;
  const projectDir = dirname(def.source_path);

  // ── tracker ──────────────────────────────────────────────────────────────
  const trackerRaw = asObject(root.tracker, 'tracker');
  const trackerKindRaw = asString(trackerRaw.kind, 'tracker.kind');
  if (trackerKindRaw !== 'linear') {
    throw new ConfigValidationError(`tracker.kind '${trackerKindRaw}' is not supported (only 'linear')`);
  }

  const gaggleLabelsRaw = asObject(trackerRaw.gaggle_labels, 'tracker.gaggle_labels');
  const gaggle_labels: GaggleLabels = {
    claimed: asString(gaggleLabelsRaw.claimed, 'tracker.gaggle_labels.claimed', 'gaggle:claimed'),
    queued: asString(gaggleLabelsRaw.queued, 'tracker.gaggle_labels.queued', 'gaggle:queued'),
    running: asString(gaggleLabelsRaw.running, 'tracker.gaggle_labels.running', 'gaggle:running'),
    waiting_human: asString(
      gaggleLabelsRaw.waiting_human,
      'tracker.gaggle_labels.waiting_human',
      'gaggle:waiting-human',
    ),
    analyzing: asString(gaggleLabelsRaw.analyzing, 'tracker.gaggle_labels.analyzing', 'gaggle:analyzing'),
    dispatching: asString(gaggleLabelsRaw.dispatching, 'tracker.gaggle_labels.dispatching', 'gaggle:dispatching'),
    retrying: asString(gaggleLabelsRaw.retrying, 'tracker.gaggle_labels.retrying', 'gaggle:retrying'),
    failed: asString(gaggleLabelsRaw.failed, 'tracker.gaggle_labels.failed', 'gaggle:failed'),
  };

  const deployRaw = asObject(trackerRaw.deploy_env_labels, 'tracker.deploy_env_labels');
  const deploy_env_labels: Record<string, string> =
    Object.keys(deployRaw).length === 0
      ? { dev: 'deployed:dev', staging: 'deployed:staging', prod: 'deployed:prod' }
      : Object.fromEntries(
          Object.entries(deployRaw).map(([k, v]) => [
            k,
            asString(v, `tracker.deploy_env_labels.${k}`),
          ]),
        );

  const tracker: TrackerConfig = {
    kind: 'linear',
    endpoint: asString(trackerRaw.endpoint, 'tracker.endpoint', 'https://api.linear.app/graphql'),
    api_key: resolveSecretOrLiteral(asOptionalString(trackerRaw.api_key, 'tracker.api_key') ?? '$LINEAR_API_KEY'),
    project_slug: asString(trackerRaw.project_slug, 'tracker.project_slug', ''),
    active_states: asArrayOfStrings(trackerRaw.active_states, 'tracker.active_states', ['Todo', 'In Progress']),
    terminal_states: asArrayOfStrings(trackerRaw.terminal_states, 'tracker.terminal_states', [
      'Closed',
      'Cancelled',
      'Canceled',
      'Duplicate',
      'Done',
    ]),
    assigned_to_me: asBool(trackerRaw.assigned_to_me, 'tracker.assigned_to_me', true),
    create_sub_issues: asBool(trackerRaw.create_sub_issues, 'tracker.create_sub_issues', true),
    default_ready_env: asString(trackerRaw.default_ready_env, 'tracker.default_ready_env', 'dev'),
    deploy_env_labels,
    blocker_satisfied_states: asArrayOfStrings(
      trackerRaw.blocker_satisfied_states,
      'tracker.blocker_satisfied_states',
      [],
    ),
    blocker_default_readiness: asString(
      trackerRaw.blocker_default_readiness,
      'tracker.blocker_default_readiness',
      'deployed',
    ),
    gate_waiting_state: asOptionalString(trackerRaw.gate_waiting_state, 'tracker.gate_waiting_state'),
    gate_resume_state: asOptionalString(trackerRaw.gate_resume_state, 'tracker.gate_resume_state'),
    pr_ready_state: asOptionalString(trackerRaw.pr_ready_state, 'tracker.pr_ready_state'),
    gaggle_labels,
    auth: parseAuthConfig(trackerRaw.auth),
  };

  // ── polling ──────────────────────────────────────────────────────────────
  const pollingRaw = asObject(root.polling, 'polling');
  const polling: PollingConfig = {
    interval_ms: asPositiveInt(pollingRaw.interval_ms, 'polling.interval_ms', 30_000),
  };

  // ── workspace ────────────────────────────────────────────────────────────
  const workspaceRaw = asObject(root.workspace, 'workspace');
  const workspaceRootStr = asString(workspaceRaw.root, 'workspace.root', '~/gaggle_workspaces');
  const workspace: WorkspaceConfig = {
    root: expandPath(workspaceRootStr, projectDir),
  };

  // ── hooks ────────────────────────────────────────────────────────────────
  const hooksRaw = asObject(root.hooks, 'hooks');
  const hooks: HooksConfig = {
    before_run: asOptionalString(hooksRaw.before_run, 'hooks.before_run'),
    after_run: asOptionalString(hooksRaw.after_run, 'hooks.after_run'),
    timeout_ms: asPositiveInt(hooksRaw.timeout_ms, 'hooks.timeout_ms', 60_000),
  };

  // ── agent ────────────────────────────────────────────────────────────────
  const agentRaw = asObject(root.agent, 'agent');
  const byStateRaw = asObject(agentRaw.max_concurrent_agents_by_state, 'agent.max_concurrent_agents_by_state');
  const max_concurrent_agents_by_state: Record<string, number> = Object.fromEntries(
    Object.entries(byStateRaw).map(([k, v]) => [
      k.toLowerCase(),
      asPositiveInt(v, `agent.max_concurrent_agents_by_state.${k}`, 1),
    ]),
  );
  const agent: AgentConfig = {
    max_concurrent_agents: asPositiveInt(agentRaw.max_concurrent_agents, 'agent.max_concurrent_agents', 10),
    max_turns: asPositiveInt(agentRaw.max_turns, 'agent.max_turns', 20),
    max_retry_backoff_ms: asPositiveInt(agentRaw.max_retry_backoff_ms, 'agent.max_retry_backoff_ms', 300_000),
    max_concurrent_agents_by_state,
  };

  // ── archon ───────────────────────────────────────────────────────────────
  const archonRaw = asObject(root.archon, 'archon');
  const archon: ArchonConfig = {
    command: asString(archonRaw.command, 'archon.command', 'archon workflow run'),
    api_url: asString(archonRaw.api_url, 'archon.api_url', 'http://localhost:3090'),
    poll_interval_ms: asPositiveInt(archonRaw.poll_interval_ms, 'archon.poll_interval_ms', 5_000),
    turn_timeout_ms: asPositiveInt(archonRaw.turn_timeout_ms, 'archon.turn_timeout_ms', 3_600_000),
    stall_timeout_ms: asInt(archonRaw.stall_timeout_ms, 'archon.stall_timeout_ms', 300_000),
    default_workflow: asString(archonRaw.default_workflow, 'archon.default_workflow', 'gaggle/gaggle-fix-issue'),
    gate_timeout_ms: asInt(archonRaw.gate_timeout_ms, 'archon.gate_timeout_ms', 0),
  };

  // ── claude ───────────────────────────────────────────────────────────────
  const claudeRaw = asObject(root.claude, 'claude');
  const claude: ClaudeConfig = {
    api_key: resolveSecretOrLiteral(asOptionalString(claudeRaw.api_key, 'claude.api_key') ?? '$ANTHROPIC_API_KEY'),
    analyzer_model: asString(claudeRaw.analyzer_model, 'claude.analyzer_model', 'claude-sonnet-4-5'),
    analyzer_max_tokens: asPositiveInt(claudeRaw.analyzer_max_tokens, 'claude.analyzer_max_tokens', 1024),
    gate_classifier_model: asString(claudeRaw.gate_classifier_model, 'claude.gate_classifier_model', 'claude-haiku-4-5-20251001'),
  };

  // ── workflow_templates ───────────────────────────────────────────────────
  const wtRaw = asObject(root.workflow_templates, 'workflow_templates');
  const wtPathStr = asString(wtRaw.path, 'workflow_templates.path');
  const workflow_templates: WorkflowTemplatesConfig = {
    path: expandPath(wtPathStr, projectDir),
    target_subdir: asString(wtRaw.target_subdir, 'workflow_templates.target_subdir', 'gaggle'),
    sync_on_dispatch: asBool(wtRaw.sync_on_dispatch, 'workflow_templates.sync_on_dispatch', true),
    reload_on_change: asBool(wtRaw.reload_on_change, 'workflow_templates.reload_on_change', true),
  };

  // ── registry ─────────────────────────────────────────────────────────────
  const regRaw = asObject(root.registry, 'registry');
  const baseFolderRaw = asString(regRaw.base_folder, 'registry.base_folder');
  const baseFolder = expandPath(baseFolderRaw, projectDir);
  if (!isAbsolute(baseFolder)) {
    throw new ConfigValidationError(`registry.base_folder must resolve to an absolute path (got ${baseFolder})`);
  }
  // base_folder may equal project_dir (the project dir is a management folder, not source code).
  // It must not be a strict subdirectory of project_dir (e.g. project_dir/repos would be confusing).
  if (isInside(baseFolder, projectDir) && resolve(baseFolder) !== resolve(projectDir)) {
    throw new ConfigValidationError(
      `registry.base_folder (${baseFolder}) must not be a subdirectory of the project directory (${projectDir}). ` +
      `Set it to the project directory itself or an entirely separate path.`,
    );
  }
  let reposPath: string | undefined;
  if (regRaw.repos_path !== undefined && regRaw.repos_path !== null) {
    const raw = asString(regRaw.repos_path, 'registry.repos_path');
    const resolved = expandPath(raw, projectDir);
    if (!isAbsolute(resolved)) {
      throw new ConfigValidationError(`registry.repos_path must resolve to an absolute path (got ${resolved})`);
    }
    reposPath = resolved;
  }
  const registry: RegistryConfig = {
    base_folder: baseFolder,
    ...(reposPath !== undefined ? { repos_path: reposPath } : {}),
    sync_interval_ms: asInt(regRaw.sync_interval_ms, 'registry.sync_interval_ms', 900_000),
    sync_on_startup: asBool(regRaw.sync_on_startup, 'registry.sync_on_startup', true),
    analysis_cache_ttl_ms: asInt(regRaw.analysis_cache_ttl_ms, 'registry.analysis_cache_ttl_ms', 300_000),
    auto_scaffold: asBool(regRaw.auto_scaffold, 'registry.auto_scaffold', true),
  };

  // ── repositories (Source Registry) ───────────────────────────────────────
  const reposRaw = root.repositories;
  if (reposRaw !== undefined && reposRaw !== null && !Array.isArray(reposRaw)) {
    throw new ConfigValidationError('repositories must be a list');
  }
  const repositories: SourceRegistryEntry[] = (reposRaw as unknown[] | undefined ?? []).map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ConfigValidationError(`repositories[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const url = asString(e.url, `repositories[${i}].url`);
    const default_branch = asString(e.default_branch, `repositories[${i}].default_branch`, 'main');
    const isHttps = /^https?:\/\/(?:www\.)?github\.com\//i.test(url);
    const isSsh = /^git@[^:]+:[^/]+\//i.test(url);
    if (!isHttps && !isSsh) {
      throw new ConfigValidationError(
        `repositories[${i}].url must be a GitHub HTTPS URL or SSH URL (git@<host>:owner/repo) — got ${url}`,
      );
    }
    return { url, default_branch };
  });

  // Detect duplicate slugs at config-load time too (Repo Syncer also enforces).
  const slugs = new Map<string, string>();
  for (const r of repositories) {
    const slug = r.url.trim().replace(/\/$/, '').split('/').pop()?.replace(/\.git$/i, '') ?? '';
    if (slugs.has(slug)) {
      throw new ConfigValidationError(
        `Two registered repositories produce the same slug '${slug}': ${slugs.get(slug)} and ${r.url}`,
      );
    }
    slugs.set(slug, r.url);
  }

  return {
    tracker,
    polling,
    workspace,
    hooks,
    agent,
    archon,
    claude,
    workflow_templates,
    registry,
    repositories,
    prompt_template: def.prompt_template,
    workflow_md_path: def.source_path,
    project_dir: projectDir,
  };
}

export function defaultGateResumeState(cfg: ServiceConfig): string {
  if (cfg.tracker.gate_resume_state) return cfg.tracker.gate_resume_state;
  return cfg.tracker.active_states[0] ?? 'In Progress';
}

/** State to move an issue/sub-issue to when Archon finishes successfully (PR created). */
export function completedState(cfg: ServiceConfig): string {
  if (cfg.tracker.pr_ready_state) return cfg.tracker.pr_ready_state;
  return cfg.tracker.terminal_states[0] ?? 'Done';
}
