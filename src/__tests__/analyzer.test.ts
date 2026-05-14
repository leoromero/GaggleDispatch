/**
 * Issue Analyzer tests — injects a fake ClaudeRunner to exercise JSON
 * extraction, alias/url reconciliation against the registry, and error cases.
 * The ClaudeRunner abstraction decouples tests from the Claude subprocess.
 */

import { describe, expect, test } from 'bun:test';
import { IssueAnalyzer, type ClaudeRunner } from '../analyzer/issue-analyzer.ts';
import { IssueAnalysisError, IssueAnalysisNoTargets } from '../domain/errors.ts';
import { makeIssue, makeRegistryContext, makeRegistryRepo, makeServiceConfig } from './helpers/fixtures.ts';

function fakeRunner(text: string): ClaudeRunner {
  return async () => text;
}

function failingRunner(message: string): ClaudeRunner {
  return async () => { throw new Error(message); };
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
          archon_workflow: 'gaggle/gaggle-supervised',
          rationale: 'because',
          components: ['comp-a'],
        },
      ],
    });
    const a = new IssueAnalyzer(makeServiceConfig(), fakeRunner(json));
    const result = await a.analyze(makeIssue(), ctx);
    expect(result.repo_targets.length).toBe(1);
    expect(result.repo_targets[0]!.local_path).toBe('/abs/repo-a');
    expect(result.repo_targets[0]!.archon_workflow).toBe('gaggle/gaggle-supervised');
    expect(result.analysis_summary).toBe('[complexity: complex] fix it');
  });

  test('extracts JSON inside ```json fences', async () => {
    const ctx = makeRegistryContext();
    const fenced = '```json\n' + JSON.stringify({
      analysis_summary: 'x',
      repo_targets: [{ repo_url: 'https://github.com/o/repo-a', repo_alias: 'repo-a', archon_workflow: 'gaggle/gaggle-fix-issue', rationale: '', components: [] }],
    }) + '\n```';
    const a = new IssueAnalyzer(makeServiceConfig(), fakeRunner(fenced));
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets[0]!.repo_alias).toBe('repo-a');
  });

  test('extracts JSON when surrounded by prose', async () => {
    const ctx = makeRegistryContext();
    const messy = `Here is the analysis:\n\n${JSON.stringify({
      analysis_summary: 'p',
      repo_targets: [{ repo_url: '', repo_alias: 'repo-a', archon_workflow: '', rationale: '', components: [] }],
    })}\n\nLet me know if you need more.`;
    const a = new IssueAnalyzer(makeServiceConfig(), fakeRunner(messy));
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets[0]!.repo_alias).toBe('repo-a');
    // No complexity field → defaults to 'complex' → gaggle/gaggle-supervised
    expect(r.repo_targets[0]!.archon_workflow).toBe('gaggle/gaggle-supervised');
  });

  test('reconciles alias-only response (no repo_url) against registry name', async () => {
    const ctx = makeRegistryContext([makeRegistryRepo({ name: 'svc-x', url: 'https://github.com/o/svc-x' })]);
    const a = new IssueAnalyzer(makeServiceConfig(), fakeRunner(
      JSON.stringify({
        analysis_summary: '',
        repo_targets: [{ repo_alias: 'svc-x', rationale: '', components: [] }],
      }),
    ));
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets[0]!.repo_url).toBe('https://github.com/o/svc-x');
  });

  test('preserves depends_on and ready_when when provided', async () => {
    const ctx = makeRegistryContext([
      makeRegistryRepo({ name: 'frontend', url: 'https://github.com/o/frontend' }),
      makeRegistryRepo({ name: 'backend', url: 'https://github.com/o/backend' }),
    ]);
    const a = new IssueAnalyzer(makeServiceConfig(), fakeRunner(
      JSON.stringify({
        analysis_summary: 'multi',
        repo_targets: [
          { repo_alias: 'backend', rationale: '', components: [] },
          { repo_alias: 'frontend', rationale: '', components: [], depends_on: ['backend'], ready_when: 'deployed' },
        ],
      }),
    ));
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets[1]!.depends_on).toEqual(['backend']);
    expect(r.repo_targets[1]!.ready_when).toBe('deployed');
    expect(r.repo_targets[0]!.depends_on).toBeUndefined();
  });

  test('drops targets that match no repo (alias mismatch)', async () => {
    const ctx = makeRegistryContext([makeRegistryRepo({ name: 'real-repo', url: 'https://github.com/o/real-repo' })]);
    const a = new IssueAnalyzer(makeServiceConfig(), fakeRunner(
      JSON.stringify({
        analysis_summary: '',
        repo_targets: [
          { repo_alias: 'ghost-repo', rationale: '', components: [] },
          { repo_alias: 'real-repo', rationale: '', components: [] },
        ],
      }),
    ));
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets.length).toBe(1);
    expect(r.repo_targets[0]!.repo_alias).toBe('real-repo');
  });

  test('throws IssueAnalysisNoTargets when every target is unmatched', async () => {
    const ctx = makeRegistryContext([makeRegistryRepo({ name: 'repo-a', url: 'https://github.com/o/repo-a' })]);
    const a = new IssueAnalyzer(makeServiceConfig(), fakeRunner(
      JSON.stringify({
        analysis_summary: '',
        repo_targets: [{ repo_alias: 'unknown-1' }, { repo_alias: 'unknown-2' }],
      }),
    ));
    await expect(a.analyze(makeIssue(), ctx)).rejects.toBeInstanceOf(IssueAnalysisNoTargets);
  });

  test('throws when registry context has zero repositories', async () => {
    const ctx = makeRegistryContext([]);
    const a = new IssueAnalyzer(makeServiceConfig(), fakeRunner('{}'));
    await expect(a.analyze(makeIssue(), ctx)).rejects.toBeInstanceOf(IssueAnalysisError);
  });

  test('throws when response contains no JSON object at all', async () => {
    const ctx = makeRegistryContext();
    const a = new IssueAnalyzer(makeServiceConfig(), fakeRunner('Sorry I cannot help with this'));
    await expect(a.analyze(makeIssue(), ctx)).rejects.toBeInstanceOf(IssueAnalysisError);
  });

  test('throws when extracted text is not valid JSON', async () => {
    const ctx = makeRegistryContext();
    const a = new IssueAnalyzer(makeServiceConfig(), fakeRunner('Here goes: { not valid json at all }'));
    await expect(a.analyze(makeIssue(), ctx)).rejects.toBeInstanceOf(IssueAnalysisError);
  });

  test('wraps runner errors as IssueAnalysisError', async () => {
    const ctx = makeRegistryContext();
    const a = new IssueAnalyzer(makeServiceConfig(), failingRunner('upstream 500'));
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
    const cfg = makeServiceConfig();
    cfg.archon.default_workflow = 'gaggle/fallback-wf';
    const a = new IssueAnalyzer(cfg, fakeRunner(
      JSON.stringify({
        analysis_summary: '',
        repo_targets: [{ repo_alias: 'repo-a', rationale: '', components: [] }],
      }),
    ));
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets[0]!.archon_workflow).toBe('gaggle/fallback-wf');
  });

  test('sanitizes alias when populating repo_alias', async () => {
    const ctx = makeRegistryContext([makeRegistryRepo({ name: 'Repo With Spaces!', url: 'https://github.com/o/repo' })]);
    const a = new IssueAnalyzer(makeServiceConfig(), fakeRunner(
      JSON.stringify({
        analysis_summary: '',
        repo_targets: [{ repo_url: 'https://github.com/o/repo', rationale: '', components: [] }],
      }),
    ));
    const r = await a.analyze(makeIssue(), ctx);
    expect(r.repo_targets[0]!.repo_alias).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(r.repo_targets[0]!.repo_alias).not.toContain(' ');
    expect(r.repo_targets[0]!.repo_alias).not.toContain('!');
  });
});
