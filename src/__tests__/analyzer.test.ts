/**
 * Issue Analyzer tests — uses an injected fake AnalyzerClient to exercise
 * JSON extraction (raw / fenced / surrounded by prose), alias-vs-url
 * reconciliation against the registry, and zero-targets failure.
 */

import { describe, expect, test } from 'bun:test';
import { IssueAnalyzer, type AnalyzerClient } from '../analyzer/issue-analyzer.ts';
import { IssueAnalysisError, IssueAnalysisNoTargets } from '../domain/errors.ts';
import { makeIssue, makeRegistryContext, makeRegistryRepo, makeServiceConfig } from './helpers/fixtures.ts';

function makeFakeClient(text: string): { client: AnalyzerClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const client: AnalyzerClient = {
    messages: {
      async create(args) {
        calls.push(args);
        return { content: [{ type: 'text', text }] };
      },
    },
  };
  return { client, calls };
}

describe('IssueAnalyzer.analyze', () => {
  test('parses a clean JSON response and reconciles local_path from registry', async () => {
    const ctx = makeRegistryContext([
      makeRegistryRepo({ name: 'repo-a', url: 'https://github.com/o/repo-a', local_path: '/abs/repo-a' }),
    ]);
    const json = JSON.stringify({
      analysis_summary: 'fix it',
      repo_targets: [
        {
          repo_url: 'https://github.com/o/repo-a',
          repo_alias: 'repo-a',
          archon_workflow: 'symphony/symphony-supervised',
          rationale: 'because',
          components: ['comp-a'],
        },
      ],
    });
    const { client } = makeFakeClient(json);
    const a = new IssueAnalyzer(makeServiceConfig(), client);
    const result = await a.analyze(makeIssue(), ctx);
    expect(result.repo_targets.length).toBe(1);
    expect(result.repo_targets[0]!.local_path).toBe('/abs/repo-a');
    expect(result.repo_targets[0]!.archon_workflow).toBe('symphony/symphony-supervised');
    expect(result.analysis_summary).toBe('fix it');
  });

  test('extracts JSON inside ```json fences', async () => {
    const ctx = makeRegistryContext();
    const fenced = '```json\n' + JSON.stringify({
      analysis_summary: 'x',
      repo_targets: [{ repo_url: 'https://github.com/o/repo-a', repo_alias: 'repo-a', archon_workflow: 'symphony/symphony-fix-issue', rationale: '', components: [] }],
    }) + '\n```';
    const { client } = makeFakeClient(fenced);
    const a = new IssueAnalyzer(makeServiceConfig(), client);
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets[0]!.repo_alias).toBe('repo-a');
  });

  test('extracts JSON when surrounded by prose', async () => {
    const ctx = makeRegistryContext();
    const messy = `Here is the analysis:\n\n${JSON.stringify({
      analysis_summary: 'p',
      repo_targets: [{ repo_url: '', repo_alias: 'repo-a', archon_workflow: '', rationale: '', components: [] }],
    })}\n\nLet me know if you need more.`;
    const { client } = makeFakeClient(messy);
    const a = new IssueAnalyzer(makeServiceConfig(), client);
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets[0]!.repo_alias).toBe('repo-a');
    // Falls back to default_workflow from the registry repo
    expect(r.repo_targets[0]!.archon_workflow).toBe('symphony/symphony-fix-issue');
  });

  test('reconciles alias-only response (no repo_url) against registry name', async () => {
    const ctx = makeRegistryContext([makeRegistryRepo({ name: 'svc-x', url: 'https://github.com/o/svc-x' })]);
    const { client } = makeFakeClient(
      JSON.stringify({
        analysis_summary: '',
        repo_targets: [{ repo_alias: 'svc-x', rationale: '', components: [] }],
      }),
    );
    const a = new IssueAnalyzer(makeServiceConfig(), client);
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets[0]!.repo_url).toBe('https://github.com/o/svc-x');
  });

  test('preserves depends_on and ready_when when provided', async () => {
    const ctx = makeRegistryContext([
      makeRegistryRepo({ name: 'frontend', url: 'https://github.com/o/frontend' }),
      makeRegistryRepo({ name: 'backend', url: 'https://github.com/o/backend' }),
    ]);
    const { client } = makeFakeClient(
      JSON.stringify({
        analysis_summary: 'multi',
        repo_targets: [
          { repo_alias: 'backend', rationale: '', components: [] },
          { repo_alias: 'frontend', rationale: '', components: [], depends_on: ['backend'], ready_when: 'deployed' },
        ],
      }),
    );
    const a = new IssueAnalyzer(makeServiceConfig(), client);
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets[1]!.depends_on).toEqual(['backend']);
    expect(r.repo_targets[1]!.ready_when).toBe('deployed');
    expect(r.repo_targets[0]!.depends_on).toBeUndefined();
  });

  test('drops targets that match no repo (alias mismatch)', async () => {
    const ctx = makeRegistryContext([makeRegistryRepo({ name: 'real-repo', url: 'https://github.com/o/real-repo' })]);
    const { client } = makeFakeClient(
      JSON.stringify({
        analysis_summary: '',
        repo_targets: [
          { repo_alias: 'ghost-repo', rationale: '', components: [] },
          { repo_alias: 'real-repo', rationale: '', components: [] },
        ],
      }),
    );
    const a = new IssueAnalyzer(makeServiceConfig(), client);
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets.length).toBe(1);
    expect(r.repo_targets[0]!.repo_alias).toBe('real-repo');
  });

  test('throws IssueAnalysisNoTargets when every target is unmatched', async () => {
    const ctx = makeRegistryContext([makeRegistryRepo({ name: 'repo-a', url: 'https://github.com/o/repo-a' })]);
    const { client } = makeFakeClient(
      JSON.stringify({
        analysis_summary: '',
        repo_targets: [{ repo_alias: 'unknown-1' }, { repo_alias: 'unknown-2' }],
      }),
    );
    const a = new IssueAnalyzer(makeServiceConfig(), client);
    await expect(a.analyze(makeIssue(), ctx)).rejects.toBeInstanceOf(IssueAnalysisNoTargets);
  });

  test('throws when registry context has zero repositories', async () => {
    const ctx = makeRegistryContext([]);
    const { client } = makeFakeClient('{}');
    const a = new IssueAnalyzer(makeServiceConfig(), client);
    await expect(a.analyze(makeIssue(), ctx)).rejects.toBeInstanceOf(IssueAnalysisError);
  });

  test('throws when response contains no JSON object at all', async () => {
    const ctx = makeRegistryContext();
    const { client } = makeFakeClient('Sorry I cannot help with this');
    const a = new IssueAnalyzer(makeServiceConfig(), client);
    await expect(a.analyze(makeIssue(), ctx)).rejects.toBeInstanceOf(IssueAnalysisError);
  });

  test('throws when extracted text is not valid JSON', async () => {
    const ctx = makeRegistryContext();
    const { client } = makeFakeClient('Here goes: { not valid json at all }');
    const a = new IssueAnalyzer(makeServiceConfig(), client);
    await expect(a.analyze(makeIssue(), ctx)).rejects.toBeInstanceOf(IssueAnalysisError);
  });

  test('passes the configured model and max_tokens to the client', async () => {
    const ctx = makeRegistryContext();
    const cfg = makeServiceConfig();
    cfg.claude.analyzer_model = 'claude-test-model';
    cfg.claude.analyzer_max_tokens = 12345;
    const { client, calls } = makeFakeClient(
      JSON.stringify({ analysis_summary: '', repo_targets: [{ repo_alias: 'repo-a' }] }),
    );
    const a = new IssueAnalyzer(cfg, client);
    await a.analyze(makeIssue(), ctx);
    expect(calls[0]!.model).toBe('claude-test-model');
    expect(calls[0]!.max_tokens).toBe(12345);
  });

  test('wraps SDK errors as IssueAnalysisError', async () => {
    const ctx = makeRegistryContext();
    const failingClient: AnalyzerClient = {
      messages: {
        async create() {
          throw new Error('upstream 500');
        },
      },
    };
    const a = new IssueAnalyzer(makeServiceConfig(), failingClient);
    await expect(a.analyze(makeIssue(), ctx)).rejects.toBeInstanceOf(IssueAnalysisError);
  });

  test('falls back to archon.default_workflow when registry repo has no default', async () => {
    const ctx = makeRegistryContext([
      makeRegistryRepo({
        name: 'repo-a',
        url: 'https://github.com/o/repo-a',
        default_workflow: '',
        available_workflows: [],
      }),
    ]);
    const { client } = makeFakeClient(
      JSON.stringify({
        analysis_summary: '',
        repo_targets: [{ repo_alias: 'repo-a', rationale: '', components: [] }],
      }),
    );
    const cfg = makeServiceConfig();
    cfg.archon.default_workflow = 'symphony/fallback-wf';
    const a = new IssueAnalyzer(cfg, client);
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets[0]!.archon_workflow).toBe('symphony/fallback-wf');
  });

  test('sanitizes alias when populating repo_alias', async () => {
    const ctx = makeRegistryContext([makeRegistryRepo({ name: 'Repo With Spaces!', url: 'https://github.com/o/repo' })]);
    const { client } = makeFakeClient(
      JSON.stringify({
        analysis_summary: '',
        repo_targets: [{ repo_url: 'https://github.com/o/repo', rationale: '', components: [] }],
      }),
    );
    const a = new IssueAnalyzer(makeServiceConfig(), client);
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets[0]!.repo_alias).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(r.repo_targets[0]!.repo_alias).not.toContain(' ');
    expect(r.repo_targets[0]!.repo_alias).not.toContain('!');
  });
});
