# Failed Worker Re-dispatch Design

**Date:** 2026-05-14  
**Status:** Approved

## Problem

When a worker fails, the target is parked with a `gaggle:failed` label on the Linear issue. Recovery today requires operators to manually remove that label in Linear. Failed workers are also invisible in the Nest dashboard — operators have no in-product way to see or act on them.

## Goal

- Surface failed workers in the Nest dashboard alongside running and paused workers
- Allow operators to re-dispatch a failed worker from the dashboard with one click
- Ensure re-dispatch reuses the original issue analysis (no redundant re-analysis)
- Persist analysis to disk so it survives orchestrator restarts and cache TTL expiry

## Approach

Approach B: new `AnalysisRegistry` for disk persistence, in-memory `failed_targets` map for dashboard state, direct re-dispatch API endpoint.

---

## Section 1 — Analysis Registry

**New file:** `src/registry/analysis-registry.ts`  
**Backing file:** `<base_folder>/gaggle-analysis.json`

```ts
interface AnalysisEntry {
  analysis: IssueAnalysis;
  saved_at: number; // unix ms
}

class AnalysisRegistry {
  saveAnalysis(issue_id: string, analysis: IssueAnalysis): void
  getAnalysis(issue_id: string): IssueAnalysis | null
  deleteAnalysis(issue_id: string): void
}
```

**Lifecycle:**
- Written immediately after `IssueAnalyzer` produces a result, before worker dispatch
- Deleted when a parent issue reaches terminal state (`done` / `cancelled`)
- No TTL on disk — it is the durable source of truth

**Integration with existing cache:**  
The in-memory `analysis_cache` on `OrchestratorState` stays as-is for fast access during normal dispatch. `AnalysisRegistry` is the fallback when the cache misses (restart or TTL expiry). `launchWorker()` checks memory cache first, then falls back to the registry.

---

## Section 2 — Failed Target State

**New type and map on `OrchestratorState`:**

```ts
interface FailedTargetInfo {
  issue: Issue;
  repo_target: RepoTarget;
  reason: string | null;
  failed_at: number; // unix ms
}

// Added to OrchestratorState:
failed_targets: Map<string, FailedTargetInfo> // key: `${issue_id}:${repo_alias}`
```

**Written:** by the effect applier when it processes the `apply_label(failed)` effect, reading the reason from the `worker_failed` / `gate_rejected` / `gate_timed_out` event payload.

**Cleared:** when `retry_requested` fires (target transitions back to `dispatching`) and when the parent reaches terminal state.

**After restart:** the orchestrator recovers failed targets by finding Linear issues with `gaggle:failed` label. The target re-enters `failed` state but `reason` will be `null` — the dashboard renders this as "see Linear comment". The full reason is always durably recorded in the comment the orchestrator posts to the Linear issue.

---

## Section 3 — API & Re-dispatch Mechanism

**New endpoint:**

```
POST /api/gaggles/{name}/targets/redispatch
Body: { issue_id: string, repo_alias: string }
```

**Handler sequence:**
1. Look up the gaggle by name; return 404 if not found
2. Validate the target is currently in `failed` state; return 400 if not
3. Call `linear.removeLabel(issue_id, 'failed')`
4. Fire `retry_requested` event directly into the orchestrator state machine (no poll wait)
5. The existing `failed → dispatching` transition takes over: posts acknowledgment comment, reads analysis from cache or `AnalysisRegistry`, spawns worker

**State serialization (`gaggle-api.ts`):**  
New `failed[]` section added alongside `running[]` and `supervised_gates[]`:

```ts
interface FailedTargetSummary {
  issue_identifier: string;
  issue_title: string;
  repo_alias: string;
  reason: string | null;
  failed_at: number; // unix ms
}
```

---

## Section 4 — Dashboard UI

**Panel rename:** "Active Workers" → "Workers"

**Pipeline summary counts** gain a `failed` count alongside running / gate-waiting / queued.

**Card types:**

| State | Shown info |
|-------|-----------|
| Running | Issue identifier, repo, turn #, tokens, last Archon message, link to Archon run |
| Paused (gate) | Issue identifier, repo, gate message, time paused, link to Archon run |
| Failed (new) | Issue identifier, repo, failure reason or "see Linear comment", time since failure, Re-dispatch button |

**Re-dispatch button behavior:**
- Calls `POST /api/gaggles/{name}/targets/redispatch`
- Optimistically removes the card from the failed section on success
- On API error: card remains, button shows error state

---

## Data Flow Summary

```
Worker fails
  → effect-applier: apply_label(failed) + write failed_targets entry
  → Linear issue gets gaggle:failed label
  → dashboard: failed card appears with reason + Re-dispatch button

Operator clicks Re-dispatch
  → POST /api/gaggles/{name}/targets/redispatch
  → linear.removeLabel(issue_id, 'failed')
  → fire retry_requested event
  → state machine: failed → dispatching
  → launchWorker() reads analysis from cache or AnalysisRegistry (no re-analysis)
  → failed_targets entry cleared
  → dashboard: card moves back into running
```

## Files Changed

| File | Change |
|------|--------|
| `src/registry/analysis-registry.ts` | New — `AnalysisRegistry` class |
| `src/domain/types.ts` | Add `FailedTargetInfo`, `FailedTargetSummary`; add `failed_targets` to `OrchestratorState` |
| `src/orchestrator/orchestrator.ts` | Save analysis to registry after analyze; fall back to registry in `launchWorker()` |
| `src/orchestrator/effect-applier.ts` | Write/clear `failed_targets` on `apply_label(failed)` and `retry_requested` |
| `src/hub/server.ts` | New `POST /api/gaggles/{name}/targets/redispatch` endpoint |
| `src/hub/gaggle-api.ts` | Add `failed[]` to state serialization |
| `dashboard/app.js` | Rename panel, add failed cards, Re-dispatch button, failed count |
| `dashboard/index.html` | Rename panel heading |
| `dashboard/styles.css` | Styles for failed card state |
