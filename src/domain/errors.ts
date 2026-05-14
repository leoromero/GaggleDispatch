/**
 * Typed errors used across GaggleDispatch (Section 5.6, 11.5, 15.1).
 */

export class GaggleError extends Error {
  override name = 'GaggleError';
  constructor(public code: string, message: string, public override cause?: unknown) {
    super(message);
  }
}

export class MissingWorkflowFile extends GaggleError {
  constructor(path: string) {
    super('missing_workflow_file', `WORKFLOW.md not found at ${path}`);
  }
}

export class MissingSyncedRegistry extends GaggleError {
  constructor(path: string) {
    super('missing_synced_registry', `Synced registry not found at ${path}`);
  }
}

export class WorkflowParseError extends GaggleError {
  constructor(message: string, cause?: unknown) {
    super('workflow_parse_error', message, cause);
  }
}

export class SyncedRegistryParseError extends GaggleError {
  constructor(message: string, cause?: unknown) {
    super('synced_registry_parse_error', message, cause);
  }
}

export class WorkflowFrontMatterNotAMap extends GaggleError {
  constructor() {
    super('workflow_front_matter_not_a_map', 'WORKFLOW.md front matter must be a YAML map');
  }
}

export class TemplateParseError extends GaggleError {
  constructor(message: string, cause?: unknown) {
    super('template_parse_error', message, cause);
  }
}

export class TemplateRenderError extends GaggleError {
  constructor(message: string, cause?: unknown) {
    super('template_render_error', message, cause);
  }
}

export class IssueAnalysisError extends GaggleError {
  constructor(message: string, cause?: unknown) {
    super('issue_analysis_error', message, cause);
  }
}

export class IssueAnalysisNoTargets extends GaggleError {
  constructor(issue_id: string) {
    super('issue_analysis_no_targets', `Issue analysis for ${issue_id} returned zero repo targets`);
  }
}

export class RepoSyncError extends GaggleError {
  constructor(message: string, cause?: unknown) {
    super('repo_sync_error', message, cause);
  }
}

export class RepoCloneError extends GaggleError {
  constructor(message: string, cause?: unknown) {
    super('repo_clone_error', message, cause);
  }
}

export class InvalidWorkspaceCwd extends GaggleError {
  constructor(message: string) {
    super('invalid_workspace_cwd', message);
  }
}

export class ArchonNotFound extends GaggleError {
  constructor() {
    super('archon_not_found', 'archon CLI not found in PATH');
  }
}

export class ArchonExitNonZero extends GaggleError {
  constructor(code: number) {
    super('archon_exit_nonzero', `Archon process exited with code ${code}`);
  }
}

export class ConfigValidationError extends GaggleError {
  constructor(message: string) {
    super('config_validation_error', message);
  }
}

export class LockTimeout extends GaggleError {
  constructor(path: string, holder?: string) {
    super(
      'lock_timeout',
      holder
        ? `Could not acquire Symphony file lock at ${path}. Held by ${holder}.`
        : `Could not acquire Symphony file lock at ${path} within timeout.`,
    );
  }
}
