# Failed Worker Re-dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface failed workers in the Nest dashboard and allow operators to re-dispatch them with one click, reusing the original issue analysis.

**Architecture:** New `AnalysisRegistry` persists `IssueAnalysis` to `gaggle-analysis.json` so it survives restarts. A new `failed_targets` map on `OrchestratorState` tracks in-memory failure info for the dashboard. A new `POST /redispatch` endpoint on the per-gaggle API fires `retry_requested` directly into the state machine; the hub server proxies it. The dashboard's "Active Workers" panel is renamed "Workers" and gains a failed card with a Re-dispatch button.

**Tech Stack:** TypeScript, Bun, vanilla JS dashboard

---

## File Map

| File | Change |
|------|--------|
| `src/registry/analysis-registry.ts` | **Create** — functional registry (same pattern as run-registry.ts) |
| `src/__tests__/analysis-registry.test.ts` | **Create** — unit tests |
| `src/domain/types.ts` | **Modify** — add `FailedTargetInfo`, `FailedTargetSummary`; extend `OrchestratorState` |
| `src/orchestrator/state.ts` | **Modify** — add `failed_targets: new Map()` to `createInitialState` |
| `src/orchestrator/orchestrator.ts` | **Modify** — save analysis in `getOrAnalyze`; load from registry in `launchWorker`; track `failed_targets` in `emitTargetEvent`/`emitParentEvent`; add `public redispatch()` |
| `src/hub/gaggle-api.ts` | **Modify** — add `failed[]` to `stateToJson`; add `onRedispatch` to options; add `/redispatch` endpoint |
| `src/cli/start.ts` | **Modify** — pass `onRedispatch` when starting gaggle API |
| `src/hub/server.ts` | **Modify** — add proxy `POST /api/gaggles/{name}/targets/redispatch` |
| `dashboard/app.js` | **Modify** — rename panel, failed count, failed cards, Re-dispatch button |
| `dashboard/index.html` | **Modify** — rename panel heading |
| `dashboard/styles.css` | **Modify** — failed card styles |

---

## Task 1: AnalysisRegistry

**Files:**
- Create: `src/registry/analysis-registry.ts`
- Create: `src/__tests__/analysis-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/analysis-registry.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { saveAnalysis, getAnalysis, deleteAnalysis } from '../registry/analysis-registry.ts';
import { tmp, makeAnalysis } from './helpers/fixtures.ts';

describe('AnalysisRegistry', () => {
  test('getAnalysis returns null for unknown issue', () => {
    const dir = tmp();
    expect(getAnalysis(dir, 'iss-x')).toBeNull();
  });

  test('saveAnalysis then getAnalysis round-trips the data', () => {
    const dir = tmp();
    const analysis = makeAnalysis();
    saveAnalysis(dir, 'iss-1', analysis);
    const result = getAnalysis(dir, 'iss-1');
    expect(result).toEqual(analysis);
  });

  test('saveAnalysis overwrites existing entry', () => {
    const dir = tmp();
    saveAnalysis(dir, 'iss-1', makeAnalysis([], 'first'));
    saveAnalysis(dir, 'iss-1', makeAnalysis([], 'second'));
    expect(getAnalysis(dir, 'iss-1')?.analysis_summary).toBe('second');
  });

  test('deleteAnalysis removes the entry', () => {
    const dir = tmp();
    saveAnalysis(dir, 'iss-1', makeAnalysis());
    deleteAnalysis(dir, 'iss-1');
    expect(getAnalysis(dir, 'iss-1')).toBeNull();
  });

  test('deleteAnalysis is a no-op for unknown issue', () => {
    const dir = tmp();
    expect(() => deleteAnalysis(dir, 'iss-x')).not.toThrow();
  });

  test('data persists across load calls (simulating restart)', () => {
    const dir = tmp();
    const analysis = makeAnalysis();
    saveAnalysis(dir, 'iss-1', analysis);
    // A second call reads from disk again (no in-memory singleton)
    const result = getAnalysis(dir, 'iss-1');
    expect(result?.issue_id).toBe('iss-1');
  });

  test('multiple issues are independent', () => {
    const dir = tmp();
    saveAnalysis(dir, 'iss-1', makeAnalysis([], 'for-1'));
    saveAnalysis(dir, 'iss-2', makeAnalysis([], 'for-2'));
    expect(getAnalysis(dir, 'iss-1')?.analysis_summary).toBe('for-1');
    expect(getAnalysis(dir, 'iss-2')?.analysis_summary).toBe('for-2');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/__tests__/analysis-registry.test.ts
```

Expected: import error — `analysis-registry.ts` does not exist yet.

- [ ] **Step 3: Implement AnalysisRegistry**

Create `src/registry/analysis-registry.ts`:

```typescript
/**
 * Persistent registry of issue analysis results, keyed by issue_id.
 *
 * Backed by <base_folder>/gaggle-analysis.json. Analysis is written
 * immediately after IssueAnalyzer produces a result and deleted when the
 * parent issue reaches a terminal state. This allows re-dispatch to reuse
 * the same analysis without re-running the expensive Claude call.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../util/logger.ts';
import type { IssueAnalysis } from '../domain/types.ts';

const FILENAME = 'gaggle-analysis.json';

interface AnalysisEntry {
  analysis: IssueAnalysis;
  saved_at: number; // unix ms
}

interface AnalysisFile {
  entries: Record<string, AnalysisEntry>;
}

function filePath(baseFolder: string): string {
  return join(baseFolder, FILENAME);
}

function load(baseFolder: string): AnalysisFile {
  const p = filePath(baseFolder);
  if (!existsSync(p)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<AnalysisFile>;
    return { entries: parsed.entries ?? {} };
  } catch {
    return { entries: {} };
  }
}

function save(baseFolder: string, data: AnalysisFile): void {
  try {
    writeFileSync(filePath(baseFolder), JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logger.warn('gaggle-analysis.json write failed', { error: (err as Error).message });
  }
}

/** Persist an analysis result for an issue. Overwrites any existing entry. */
export function saveAnalysis(baseFolder: string, issue_id: string, analysis: IssueAnalysis): void {
  const data = load(baseFolder);
  data.entries[issue_id] = { analysis, saved_at: Date.now() };
  save(baseFolder, data);
}

/** Retrieve the analysis for an issue. Returns null if not found. */
export function getAnalysis(baseFolder: string, issue_id: string): IssueAnalysis | null {
  const data = load(baseFolder);
  return data.entries[issue_id]?.analysis ?? null;
}

/** Remove the analysis for an issue (call when parent reaches terminal state). */
export function deleteAnalysis(baseFolder: string, issue_id: string): void {
  const data = load(baseFolder);
  if (!(issue_id in data.entries)) return;
  delete data.entries[issue_id];
  save(baseFolder, data);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/__tests__/analysis-registry.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/registry/analysis-registry.ts src/__tests__/analysis-registry.test.ts
git commit -m "feat: add AnalysisRegistry for persistent issue analysis"
```

---

## Task 2: Types — FailedTargetInfo, FailedTargetSummary, OrchestratorState

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/orchestrator/state.ts`

- [ ] **Step 1: Add FailedTargetInfo and FailedTargetSummary to types.ts**

In `src/domain/types.ts`, add after the `CachedAnalysis` interface (after line 279):

```typescript
export interface FailedTargetInfo {
  issue: Issue;
  repo_target: RepoTarget;
  reason: string | null;
  failed_at: number; // unix ms
}

export interface FailedTargetSummary {
  issue_id: string;
  issue_identifier: string;
  issue_title: string;
  repo_alias: string;
  reason: string | null;
  failed_at: number; // unix ms
}
```

- [ ] **Step 2: Extend OrchestratorState**

In `src/domain/types.ts`, inside the `OrchestratorState` interface (after the `parent_machine_states` field, before `claude_totals`, around line 410), add:

```typescript
  /**
   * In-memory record of currently-failed targets. Keyed by workerKey.
   * Written when a target enters `failed`, cleared on retry or terminal.
   * Reason is null after restart (see Linear comment for full context).
   */
  failed_targets: Map<string, FailedTargetInfo>;
```

- [ ] **Step 3: Add failed_targets to createInitialState**

In `src/orchestrator/state.ts`, inside `createInitialState`, add `failed_targets: new Map(),` alongside the other maps:

```typescript
export function createInitialState(cfg: ServiceConfig): OrchestratorState {
  return {
    poll_interval_ms: cfg.polling.interval_ms,
    max_concurrent_agents: cfg.agent.max_concurrent_agents,
    running: new Map(),
    pending_targets: new Map(),
    pending_issues: new Map(),
    supervised_gates: new Map(),
    retry_attempts: new Map(),
    analysis_cache: new Map(),
    sibling_subissues: new Map(),
    subissue_snapshot: new Map(),
    detached_archon_runs: new Map(),
    target_machine_states: new Map(),
    parent_machine_states: new Map(),
    failed_targets: new Map(),
    claude_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
  };
}
```

- [ ] **Step 4: Type-check**

```bash
bun tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/orchestrator/state.ts
git commit -m "feat: add FailedTargetInfo types and failed_targets to OrchestratorState"
```

---

## Task 3: Wire AnalysisRegistry into Orchestrator

**Files:**
- Modify: `src/orchestrator/orchestrator.ts`

This task makes the analysis persist to disk after every `getOrAnalyze()` call, falls back to the registry in `launchWorker()` when no override is provided, and cleans up the registry entry when a parent reaches a terminal state.

- [ ] **Step 1: Import saveAnalysis and getAnalysis in orchestrator.ts**

At the top of `src/orchestrator/orchestrator.ts`, find the existing registry imports (around line 37–40, which already import `createInitialState`, `workerKey`, etc.) and add:

```typescript
import { saveAnalysis, getAnalysis, deleteAnalysis } from '../registry/analysis-registry.ts';
```

- [ ] **Step 2: Save analysis to disk in getOrAnalyze()**

In `src/orchestrator/orchestrator.ts`, find `getOrAnalyze()`. After line 674 where the in-memory cache is written:

```typescript
      this.state.analysis_cache.set(issue.id, { analysis, cached_at: Date.now() });
```

Add the registry save immediately after:

```typescript
      this.state.analysis_cache.set(issue.id, { analysis, cached_at: Date.now() });
      saveAnalysis(this.cfg.registry.base_folder, issue.id, analysis);
```

- [ ] **Step 3: Fall back to registry in launchWorker()**

In `src/orchestrator/orchestrator.ts`, find `launchWorker()`. At line 481, the `workerArgs` object has:

```typescript
      analysis: analysisOverride ?? { issue_id: parentIssue.id, analysis_summary: '', repo_targets: [target] },
```

Replace with (falls back: override → memory cache → disk registry → empty stub):

```typescript
      analysis: analysisOverride
        ?? this.state.analysis_cache.get(parentIssue.id)?.analysis
        ?? getAnalysis(this.cfg.registry.base_folder, parentIssue.id)
        ?? { issue_id: parentIssue.id, analysis_summary: '', repo_targets: [target] },
```

- [ ] **Step 4: Delete registry entry on terminal parent state**

In `src/orchestrator/orchestrator.ts`, find `emitParentEvent()` (around line 1266). After the existing state recording line:

```typescript
    this.state.parent_machine_states.set(ctx.parent_issue.id, transition.to);
```

Add cleanup when the parent reaches a terminal state:

```typescript
    this.state.parent_machine_states.set(ctx.parent_issue.id, transition.to);
    if (transition.to === 'done' || transition.to === 'cancelled') {
      deleteAnalysis(this.cfg.registry.base_folder, ctx.parent_issue.id);
      // Clear any failed_targets entries for this parent
      for (const key of this.state.failed_targets.keys()) {
        if (key.startsWith(ctx.parent_issue.id + '__')) {
          this.state.failed_targets.delete(key);
        }
      }
    }
```

- [ ] **Step 5: Type-check**

```bash
bun tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/orchestrator.ts
git commit -m "feat: persist analysis to registry; load from registry in launchWorker"
```

---

## Task 4: Track failed_targets and Add redispatch() Method

**Files:**
- Modify: `src/orchestrator/orchestrator.ts`

- [ ] **Step 1: Extend emitTargetEvent to track failed_targets**

In `src/orchestrator/orchestrator.ts`, find `emitTargetEvent()` (at line 1252). The current implementation is:

```typescript
  private async emitTargetEvent(
    fromState: TargetState,
    event: TargetEvent,
    ctx: TargetTransitionContext,
  ): Promise<TargetTransition> {
    const transition = targetTransition(fromState, event, ctx);
    await this.effectApplier.applyAll(transition.effects);
    const key = workerKey(ctx.identity.parent_issue_id, ctx.identity.repo_alias);
    this.state.target_machine_states.set(key, transition.to);
    return transition;
  }
```

Replace with:

```typescript
  private async emitTargetEvent(
    fromState: TargetState,
    event: TargetEvent,
    ctx: TargetTransitionContext,
  ): Promise<TargetTransition> {
    const transition = targetTransition(fromState, event, ctx);
    await this.effectApplier.applyAll(transition.effects);
    const key = workerKey(ctx.identity.parent_issue_id, ctx.identity.repo_alias);
    this.state.target_machine_states.set(key, transition.to);

    if (transition.to === 'failed') {
      const reason = 'reason' in event && typeof (event as { reason?: unknown }).reason === 'string'
        ? (event as { reason: string }).reason
        : null;
      this.state.failed_targets.set(key, {
        issue: ctx.parent_issue,
        repo_target: ctx.target,
        reason,
        failed_at: Date.now(),
      });
    } else if (fromState === 'failed') {
      this.state.failed_targets.delete(key);
    }

    return transition;
  }
```

- [ ] **Step 2: Add public redispatch() method**

In `src/orchestrator/orchestrator.ts`, add the following public method just before the closing `}` of the `Orchestrator` class (before line 2426). Place it near `getState()` (around line 214):

```typescript
  /**
   * Re-dispatch a failed target without re-analyzing. Called by the gaggle API
   * when the operator clicks Re-dispatch in the dashboard. Fires retry_requested
   * directly into the state machine — the SM handles label removal and worker spawn.
   */
  async redispatch(issue_id: string, repo_alias: string): Promise<void> {
    const key = workerKey(issue_id, repo_alias);
    if (this.state.target_machine_states.get(key) !== 'failed') {
      throw new Error(`Target ${key} is not in failed state`);
    }

    let parentIssue = this.state.pending_issues.get(issue_id);
    if (!parentIssue) {
      try {
        const fetched = await this.tracker.fetchIssueStatesByIds([issue_id]);
        parentIssue = fetched[0];
      } catch {
        /* ignore */
      }
    }
    if (!parentIssue) throw new Error(`Cannot resolve issue ${issue_id}`);

    this.state.pending_issues.set(issue_id, parentIssue);
    const target = this.buildRepoTargetForAlias(repo_alias, parentIssue);
    const targetIssueId = this.state.sibling_subissues.get(issue_id)?.get(repo_alias) ?? issue_id;

    const identity: TargetIdentity = {
      parent_issue_id: issue_id,
      repo_alias,
      target_issue_id: targetIssueId,
    };

    await this.emitTargetEvent('failed', { kind: 'retry_requested', message: null }, {
      cfg: this.cfg,
      identity,
      parent_issue: parentIssue,
      target,
      siblings: new Map(),
      attempt: 0,
    });

    logger.info('Failed target — dashboard re-dispatch', { issue_id, repo_alias });
  }
```

Note: `TargetIdentity` is already imported in the orchestrator. Check that `fetchIssueStatesByIds` is the correct method name on `this.tracker` by grepping for it — use whatever method is used in `pollFailedTargets()` (around line 1162).

- [ ] **Step 3: Type-check**

```bash
bun tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/orchestrator.ts
git commit -m "feat: track failed_targets in emitTargetEvent; add redispatch() method"
```

---

## Task 5: Gaggle API — failed[] Serialization and /redispatch Endpoint

**Files:**
- Modify: `src/hub/gaggle-api.ts`
- Modify: `src/cli/start.ts`

- [ ] **Step 1: Import FailedTargetSummary type**

In `src/hub/gaggle-api.ts`, update the import at line 17:

```typescript
import type { OrchestratorState, LiveSession, SupervisedGateEntry, FailedTargetSummary } from '../domain/types.ts';
```

- [ ] **Step 2: Add failed[] to stateToJson**

In `src/hub/gaggle-api.ts`, in the `stateToJson` function (line 79), add a `failed` field alongside `running`, `supervised_gates`, etc. After the `detached_archon_runs` field (around line 130):

```typescript
    failed: Array.from(state.failed_targets.entries()).map(([, info]): FailedTargetSummary => ({
      issue_id: info.issue.id,
      issue_identifier: info.issue.identifier,
      issue_title: info.issue.title,
      repo_alias: info.repo_target.repo_alias,
      reason: info.reason,
      failed_at: info.failed_at,
    })),
```

- [ ] **Step 3: Add onRedispatch to GaggleApiOptions and the /redispatch endpoint**

In `src/hub/gaggle-api.ts`, update `GaggleApiOptions` (starting at line 20) to add the redispatch hook:

```typescript
export interface GaggleApiOptions {
  port: number;
  host?: string;
  workspaceName: string;
  getState: () => OrchestratorState;
  onRedispatch?: (issue_id: string, repo_alias: string) => Promise<void>;
  /** How many log events to retain in memory (ring buffer). Default 1000. */
  logBufferSize?: number;
}
```

In `startGaggleApi`, inside the `fetch` handler (after the `/api/logs` route, before the final `return new Response('not found', { status: 404 })`), add:

```typescript
      if (url.pathname === '/redispatch' && req.method === 'POST') {
        if (!opts.onRedispatch) {
          return Response.json({ error: 'redispatch not configured' }, { status: 503 });
        }
        let body: { issue_id?: string; repo_alias?: string };
        try {
          body = await req.json() as { issue_id?: string; repo_alias?: string };
        } catch {
          return Response.json({ error: 'invalid JSON body' }, { status: 400 });
        }
        const { issue_id, repo_alias } = body;
        if (!issue_id || !repo_alias) {
          return Response.json({ error: 'issue_id and repo_alias required' }, { status: 400 });
        }
        try {
          await opts.onRedispatch(issue_id, repo_alias);
          return Response.json({ ok: true });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 400 });
        }
      }
```

- [ ] **Step 4: Wire onRedispatch in start.ts**

In `src/cli/start.ts`, find the `startGaggleApi` call (around line 114). Update it to pass the redispatch hook:

```typescript
  const apiHandle = wantApi
    ? startGaggleApi({
        port: opts.apiPort ?? 0,
        workspaceName: opts.workspaceName ?? basename(cfg.project_dir),
        getState: () => orchestrator.getState(),
        onRedispatch: (issue_id, repo_alias) => orchestrator.redispatch(issue_id, repo_alias),
      })
    : null;
```

- [ ] **Step 5: Type-check**

```bash
bun tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/hub/gaggle-api.ts src/cli/start.ts
git commit -m "feat: expose failed[] in gaggle API state and add /redispatch endpoint"
```

---

## Task 6: Hub Server — Proxy /api/gaggles/{name}/targets/redispatch

**Files:**
- Modify: `src/hub/server.ts`

- [ ] **Step 1: Add the proxy endpoint**

In `src/hub/server.ts`, find the existing control endpoints (around line 270–288, the start/stop pattern). Add the following new route after the `startMatch` block (after line 288), before the `/api/state` check:

```typescript
      const redispatchMatch = req.method === 'POST' && url.pathname.match(/^\/api\/gaggles\/([^/]+)\/targets\/redispatch$/);
      if (redispatchMatch) {
        const name = decodeURIComponent(redispatchMatch[1]);
        const workspace = opts.manager.get(name);
        if (!workspace || !workspace.api_url) {
          return Response.json({ error: 'gaggle not found or not running' }, { status: 404 });
        }
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: 'invalid JSON body' }, { status: 400 });
        }
        try {
          const res = await fetch(`${workspace.api_url}/redispatch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          return Response.json(data, { status: res.status });
        } catch (err) {
          return Response.json({ error: (err as Error).message }, { status: 502 });
        }
      }
```

- [ ] **Step 2: Type-check**

```bash
bun tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/hub/server.ts
git commit -m "feat: proxy POST /api/gaggles/{name}/targets/redispatch to gaggle API"
```

---

## Task 7: Dashboard — Failed Cards, Renamed Panel, Re-dispatch Button

**Files:**
- Modify: `dashboard/index.html`
- Modify: `dashboard/styles.css`
- Modify: `dashboard/app.js`

- [ ] **Step 1: Rename panel heading in index.html**

In `dashboard/index.html`, at lines 31–34:

```html
<section id="workers-panel" class="panel wide">
  <h2>Active workers</h2>
  <div id="workers-list" class="workers-list"></div>
</section>
```

Change to:

```html
<section id="workers-panel" class="panel wide">
  <h2>Workers</h2>
  <div id="workers-list" class="workers-list"></div>
</section>
```

- [ ] **Step 2: Add failed card styles to styles.css**

In `dashboard/styles.css`, after the `.badge.gate` block (after line 338), add:

```css
.badge.failed {
  background: rgba(239, 68, 68, 0.15);
  color: var(--red);
}
```

After the `.worker-card.gated` block (after line 301), add:

```css
.worker-card.failed {
  border-color: rgba(239, 68, 68, 0.4);
  background: linear-gradient(180deg, rgba(239, 68, 68, 0.05), var(--panel-2));
}
```

After the `.worker-card .gate-msg` block (after line 358), add:

```css
.worker-card .fail-reason {
  font-style: italic;
  color: var(--red);
  background: rgba(239, 68, 68, 0.06);
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 11px;
  margin-top: 4px;
}

.worker-card .actions button.redispatch-btn {
  font-size: 11px;
  color: var(--accent);
  background: none;
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
}

.worker-card .actions button.redispatch-btn:hover {
  background: rgba(79, 156, 249, 0.1);
}

.worker-card .actions button.redispatch-btn:disabled {
  color: var(--text-faint);
  border-color: var(--text-faint);
  cursor: not-allowed;
}

.worker-card .actions .redispatch-error {
  font-size: 10px;
  color: var(--red);
  margin-left: 6px;
}
```

- [ ] **Step 3: Add failed count to renderPipeline() in app.js**

In `dashboard/app.js`, in `renderPipeline()`, at line 245 where the counters are declared, add `failed`:

```javascript
  let running = 0, gated = 0, queued = 0, retries = 0, failed = 0;
```

In the loop over workspace states (around line 251), after the `retries +=` line, add:

```javascript
    failed += s.failed?.length ?? 0;
```

In the pipeline summary `summary.append(...)` block (around line 283), replace the existing `retries` item with a `failed` item and keep retries or remove as appropriate. Replace the four `el` calls with:

```javascript
  summary.append(
    el('div', { class: 'item' }, [el('span', { class: 'count', style: { color: 'var(--green)' } }, String(running)), el('span', { class: 'label' }, 'running')]),
    el('div', { class: 'item' }, [el('span', { class: 'count', style: { color: 'var(--amber)' } }, String(gated)), el('span', { class: 'label' }, 'gate wait')]),
    el('div', { class: 'item' }, [el('span', { class: 'count', style: { color: 'var(--purple)' } }, String(queued)), el('span', { class: 'label' }, 'queued')]),
    el('div', { class: 'item' }, [el('span', { class: 'count', style: { color: 'var(--red)' } }, String(failed)), el('span', { class: 'label' }, 'failed')]),
  );
```

- [ ] **Step 4: Add failed cards to renderWorkers() in app.js**

In `dashboard/app.js`, in `renderWorkers()`, find the loop that collects cards (around line 317):

```javascript
    for (const w of s.running ?? []) cards.push({ name, kind: 'running', w });
    for (const g of s.supervised_gates ?? []) cards.push({ name, kind: 'gate', w: g });
```

Add the failed collection after:

```javascript
    for (const w of s.running ?? []) cards.push({ name, kind: 'running', w });
    for (const g of s.supervised_gates ?? []) cards.push({ name, kind: 'gate', w: g });
    for (const f of s.failed ?? []) cards.push({ name, kind: 'failed', w: f });
```

Update the empty-state check (around line 321):

```javascript
  if (cards.length === 0) {
    root.appendChild(el('div', { class: 'empty' }, 'No workers.'));
    return;
  }
```

In the `for (const { name, kind, w } of cards)` loop, after the `else` block for `gate` cards (after line 385), add an `else if` for failed cards:

```javascript
    } else if (kind === 'failed') {
      const agoStr = w.failed_at ? formatAgoMs(w.failed_at) : 'unknown time ago';
      const reasonText = w.reason ?? 'see Linear comment for details';
      const btn = el('button', { class: 'redispatch-btn' }, 'Re-dispatch');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Dispatching…';
        const errSpan = btn.parentElement?.querySelector('.redispatch-error');
        if (errSpan) errSpan.remove();
        try {
          const res = await fetch(
            `/api/gaggles/${encodeURIComponent(name)}/targets/redispatch`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ issue_id: w.issue_id, repo_alias: w.repo_alias }),
            },
          );
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
          // Optimistically remove the card
          btn.closest('.worker-card')?.remove();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Re-dispatch';
          const errEl = el('span', { class: 'redispatch-error' }, err.message ?? 'failed');
          btn.parentElement?.appendChild(errEl);
        }
      });
      root.appendChild(
        el('div', { class: 'worker-card failed' }, [
          el('div', { class: 'head' }, [
            el('div', { class: 'who' }, [
              el('span', { class: 'ws-color', style: { background: colorFor(name) } }),
              `${w.issue_identifier} · ${w.repo_alias}`,
            ]),
            el('span', { class: 'badge failed' }, `failed · ${agoStr}`),
          ]),
          el('div', { class: 'meta' }, w.issue_title || ''),
          el('div', { class: 'fail-reason' }, reasonText),
          el('div', { class: 'actions' }, [btn]),
        ]),
      );
    }
```

- [ ] **Step 5: Verify the dashboard renders**

Start the hub (or a standalone gaggle with `--api-port 0`) and open the dashboard in a browser. Verify:
- Panel heading reads "Workers" (not "Active workers")
- Pipeline summary shows a "failed" count in red
- With no failed targets: workers list shows "No workers."
- With a failed target (trigger one manually or check Linear for any with `gaggle:failed`): a red-bordered card appears with the issue identifier, repo, reason, and Re-dispatch button

- [ ] **Step 6: Commit**

```bash
git add dashboard/index.html dashboard/styles.css dashboard/app.js
git commit -m "feat: dashboard Workers panel with failed cards and Re-dispatch button"
```

---

## Self-Review Checklist

After completing all tasks, verify:

1. `bun tsc --noEmit` — no type errors
2. `bun test` — all tests pass
3. `bun test src/__tests__/analysis-registry.test.ts` — 7 tests pass
4. Dashboard visually shows failed workers and the Re-dispatch button works end-to-end
5. Analysis is persisted: confirm `gaggle-analysis.json` appears in the base_folder after an issue is analyzed
6. Analysis is reused: kill and restart the orchestrator, trigger a re-dispatch — confirm no `Issue analyzed` log line fires (analysis came from registry)
7. Analysis is cleaned up: after an issue reaches `done`, confirm its entry is removed from `gaggle-analysis.json`
