/**
 * The run loop.
 *
 * Owns one workflow run: plan, dispatch ready nodes concurrently, record every
 * transition to the store, and stop at a terminal state or an approval gate.
 *
 * Two invariants hold the design together:
 *
 *  - The store is the source of truth, not this object. Every status change is
 *    persisted before the in-memory map is trusted, so a process that dies
 *    mid-run leaves behind enough to resume from.
 *  - Pausing is a normal exit, not a suspension. When a gate is reached the
 *    loop returns and the run's `done` promise settles; nothing is left
 *    waiting on a human. Resuming builds a fresh runner over the same row.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { logger } from '../../util/logger.ts';
import type { NodeStatus, RunEvent, RunEventHandler, SideEffects } from '../types.ts';
import type { Store } from '../store/types.ts';
import { evaluateCondition } from './conditions.ts';
import { CommandResolver } from './commands.ts';
import { isSettled, plan, runOutcome, type NodeStateMap } from './planner.ts';
import { runBash, runScript, type ShellOutcome } from './nodes/shell.ts';
import type { AiRunner } from './provider/claude.ts';
import type { WorkflowDef, WorkflowNode } from './schema.ts';
import {
  appendContextIfAbsent,
  substitute,
  type NodeOutputValue,
  type SubstitutionContext,
} from './substitute.ts';

export interface RunnerConfig {
  nodeIdleTimeoutMs: number;
  bashTimeoutMs: number;
  maxRunDurationMs: number;
  leaseHeartbeatMs: number;
  leaseTtlMs: number;
  /** Bounds how many nodes execute at once within a single run. */
  maxParallelNodes: number;
  /**
   * Ceiling on agent turns per AI node, or 0 for the SDK's own default.
   *
   * A cost bound, so it is worth having even though no shipped workflow sets
   * one per node. It was parsed from `agent.max_turns` and read by nothing,
   * which meant an operator lowering it to cap spend got exactly nothing.
   */
  maxTurns: number;
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  nodeIdleTimeoutMs: 300_000,
  bashTimeoutMs: 120_000,
  maxRunDurationMs: 3_600_000,
  leaseHeartbeatMs: 15_000,
  leaseTtlMs: 60_000,
  maxParallelNodes: 4,
  maxTurns: 0,
};

export interface RunnerDeps {
  store: Store;
  ai: AiRunner;
  commands: CommandResolver;
  config: RunnerConfig;
  /** Directories searched for named `script:` files. */
  scriptDirs: string[];
  bashPath?: string;
}

export interface RunnerContext {
  runId: string;
  workflow: WorkflowDef;
  cwd: string;
  artifactsDir: string;
  baseBranch: string | null;
  userMessage: string;
  issueContext?: string;
  env: Record<string, string>;
  dryRun: boolean;
}

/** Why the loop stopped. */
export type RunnerStop =
  | { kind: 'succeeded' }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'paused'; node_id: string; message: string };

export const LEASE_OWNER = `${hostname()}:${process.pid}`;

/** A gate decision made while the run was parked, replayed on resume. */
export interface PendingDecision {
  node_id: string;
  /**
   * Other nodes the same answer governs.
   *
   * Startup recovery parks *every* interrupted `at_most_once` node behind one
   * gate — the store allows a single pending gate per run and the message
   * names them all. If the answer only reached the node the gate row happens
   * to carry, the rest would re-run unasked, which is exactly the duplicate
   * side effect the marker exists to prevent.
   */
  covers?: string[];
  decision: 'approved' | 'rejected';
  comment: string | null;
  /** How many rework cycles this gate has already been through. */
  rework_attempts: number;
}

/**
 * Completion detection for loop nodes.
 *
 * `<promise>SIGNAL</promise>` is the reliable form — a bare signal anywhere in
 * the text would fire on the model merely *discussing* the signal, so the
 * plain form is only accepted at the very end of the output.
 */
export function detectCompletionSignal(text: string, signal: string): boolean {
  if (!signal) return false;
  const tagged = new RegExp(`<promise>\\s*${escapeRegex(signal)}\\s*</promise>`, 'i');
  if (tagged.test(text)) return true;
  const trimmed = text.trimEnd();
  return trimmed.endsWith(signal);
}

export function stripPromiseTags(text: string): string {
  return text.replace(/<promise>\s*([\s\S]*?)\s*<\/promise>/gi, '$1');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface NodeResult {
  status: NodeStatus;
  output: string;
  json?: unknown;
  error?: string;
  sessionId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  /** Set by an approval node that needs the run to stop and wait. */
  pause?: { message: string };
  /** Set by a cancel node. */
  cancel?: { reason: string };
}

export class WorkflowRunner {
  private readonly deps: RunnerDeps;
  private readonly ctx: RunnerContext;
  private readonly onEvent: RunEventHandler;

  private readonly states: NodeStateMap = new Map();
  private readonly outputs = new Map<string, NodeOutputValue>();
  private readonly sessions = new Map<string, string>();
  private readonly abort = new AbortController();

  private stopped: RunnerStop | null = null;
  private suspended = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private runDeadline: ReturnType<typeof setTimeout> | null = null;
  private pendingDecision: PendingDecision | null = null;

  constructor(deps: RunnerDeps, ctx: RunnerContext, onEvent: RunEventHandler) {
    this.deps = deps;
    this.ctx = ctx;
    this.onEvent = onEvent;
  }

  /**
   * Hand a resumed run the decision that was made while it was parked.
   *
   * Set before `run()`; the gate node consumes it instead of parking again.
   */
  primeDecision(decision: PendingDecision): void {
    // A loop gate's comment becomes the next iteration's `$LOOP_USER_INPUT`;
    // executeLoop reads it off the decision, so there is no instance-level
    // "pending input" for a concurrent node to consume by mistake.
    this.pendingDecision = decision;
  }

  cancel(reason = 'cancelled by caller'): void {
    if (this.stopped) return;
    this.stopped = { kind: 'cancelled', reason };
    this.abort.abort();
  }

  /**
   * Stop for a restart, without settling the run.
   *
   * Cancelling would mark the run `cancelled` and throw away work that is only
   * interrupted by a shutdown. This leaves the row `running` and its in-flight
   * nodes `running`, then drops the lease on the way out — precisely the state
   * startup recovery looks for, so the run is picked up again and an
   * `at_most_once` node still gets its human.
   */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.stopped = { kind: 'cancelled', reason: 'executor shutting down' };
    this.abort.abort();
  }

  private emit(event: RunEvent): void {
    try {
      this.onEvent(event);
    } catch (err) {
      // A listener throwing must not take the run down with it.
      logger.warn('Run event listener threw', { error: (err as Error).message });
    }
  }

  private async record(
    node: WorkflowNode,
    status: NodeStatus,
    extra: Partial<{
      output: string | null;
      output_json: unknown;
      error: string | null;
      claude_session_id: string | null;
      input_tokens: number;
      output_tokens: number;
      completed_at: string | null;
      attempt: number;
    }> = {},
  ): Promise<void> {
    this.states.set(node.id, status);
    await this.deps.store.upsertNode({
      run_id: this.ctx.runId,
      node_id: node.id,
      node_type: node.type,
      status,
      side_effects: node.side_effects as SideEffects,
      started_at: new Date().toISOString(),
      ...extra,
    });
    await this.deps.store.touchRun(this.ctx.runId);
  }

  /**
   * Restore prior node state so a resumed run skips work that already landed.
   *
   * Only `completed` carries forward. Everything else is replanned:
   *
   *  - `failed` must retry — retrying the failure is the entire point of
   *    resuming, and carrying it forward would make every resume a no-op that
   *    re-reports the same failure.
   *  - `running` / `interrupted` belong to an execution that no longer exists
   *    (the gate that parked the run, or a process that died). Loading one as
   *    running would convince the planner that work is in flight which nothing
   *    is driving, and the run would finish having silently skipped the rest
   *    of the graph.
   *  - `skipped` re-evaluates its condition against the restored upstream
   *    outputs, which is idempotent when nothing changed and more correct when
   *    something did.
   */
  async hydrate(): Promise<void> {
    for (const row of await this.deps.store.getNodes(this.ctx.runId)) {
      if (row.status === 'completed') {
        this.states.set(row.node_id, row.status);
        this.outputs.set(row.node_id, { text: row.output ?? '', json: row.output_json ?? undefined });
      }
      if (row.claude_session_id) this.sessions.set(row.node_id, row.claude_session_id);
    }
  }

  private substitutionContext(extra: Partial<SubstitutionContext> = {}): SubstitutionContext {
    return {
      arguments: this.ctx.userMessage,
      workflowId: this.ctx.runId,
      artifactsDir: this.ctx.artifactsDir,
      baseBranch: this.ctx.baseBranch,
      context: this.ctx.issueContext,
      nodeOutputs: this.outputs,
      ...extra,
    };
  }

  private expand(
    text: string,
    opts: { shell?: boolean; extra?: Partial<SubstitutionContext> } = {},
  ): string {
    return this.expandShell(text, opts).text;
  }

  /**
   * Expand and keep the environment bindings a shell body needs.
   *
   * Untrusted values are referenced as `${GAGGLE_…}` rather than pasted in, so
   * a shell body is only complete once these are in the subprocess env.
   */
  private expandShell(
    text: string,
    opts: { shell?: boolean; extra?: Partial<SubstitutionContext> } = {},
  ): { text: string; bindings: Record<string, string> } {
    const res = substitute(text, this.substitutionContext(opts.extra), {
      shell: opts.shell === true,
      allowEscapes: opts.shell !== true,
    });
    if (res.unresolved.length > 0) {
      logger.debug('Unresolved references in node body', {
        run_id: this.ctx.runId,
        unresolved: res.unresolved,
      });
    }
    return { text: res.text, bindings: res.bindings };
  }

  private nodeEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, this.ctx.env, {
      ARTIFACTS_DIR: this.ctx.artifactsDir,
      WORKFLOW_ID: this.ctx.runId,
      GAGGLE_RUN_ID: this.ctx.runId,
    });
    if (this.ctx.baseBranch) env.BASE_BRANCH = this.ctx.baseBranch;
    return env;
  }

  /** Whichever session a `context: shared` node should continue from. */
  private inheritedSession(node: WorkflowNode): string | undefined {
    if (node.context !== 'shared') return undefined;
    for (const dep of [...node.depends_on].reverse()) {
      const sid = this.sessions.get(dep);
      if (sid) return sid;
    }
    return undefined;
  }

  private shellOutcomeToResult(node: WorkflowNode, out: ShellOutcome): NodeResult {
    if (out.cancelled) {
      return { status: 'cancelled', output: out.stdout, error: 'cancelled' };
    }
    if (out.timed_out) {
      return {
        status: 'failed',
        output: out.stdout,
        error: `timed out after ${node.timeout ?? this.deps.config.bashTimeoutMs}ms`,
      };
    }
    if (out.exit_code !== 0) {
      const tail = out.stderr.trim().split('\n').slice(-5).join('\n');
      return {
        status: 'failed',
        output: out.stdout,
        error: `exited ${out.exit_code}${tail ? `: ${tail}` : ''}`,
      };
    }
    return { status: 'completed', output: out.stdout };
  }

  private async executeBash(node: WorkflowNode): Promise<NodeResult> {
    const { text: script, bindings } = this.expandShell(node.bash!, { shell: true });
    const out = await runBash({
      script,
      cwd: this.ctx.cwd,
      env: { ...this.nodeEnv(), ...bindings },
      timeoutMs: node.timeout ?? this.deps.config.bashTimeoutMs,
      signal: this.abort.signal,
      bashPath: this.deps.bashPath,
      onLine: (line) => this.emit({ type: 'node_output', run_id: this.ctx.runId, node_id: node.id, line }),
    });
    return this.shellOutcomeToResult(node, out);
  }

  private async executeScript(node: WorkflowNode): Promise<NodeResult> {
    // Not shell-quoted: script bodies assign the value as a literal expression.
    const body = this.expand(node.script!, { shell: false });
    try {
      const out = await runScript({
        script: body,
        runtime: node.runtime!,
        deps: node.deps,
        cwd: this.ctx.cwd,
        env: this.nodeEnv(),
        timeoutMs: node.timeout ?? this.deps.config.bashTimeoutMs,
        scriptDirs: this.deps.scriptDirs,
        signal: this.abort.signal,
        onLine: (line) =>
          this.emit({ type: 'node_output', run_id: this.ctx.runId, node_id: node.id, line }),
      });
      return this.shellOutcomeToResult(node, out);
    } catch (err) {
      // Script resolution failures surface here rather than as an exit code.
      return { status: 'failed', output: '', error: (err as Error).message };
    }
  }

  private async executeAi(
    node: WorkflowNode,
    promptText: string,
    // Passed per call rather than held on the instance: nodes run
    // concurrently, and instance-level "pending" values would be consumed by
    // whichever node happened to expand its prompt first.
    extras: { loopUserInput?: string; rejectionReason?: string } = {},
  ): Promise<NodeResult> {
    const prompt = appendContextIfAbsent(
      this.expand(promptText, { shell: false, extra: extras }),
      this.ctx.issueContext,
    );

    const res = await this.deps.ai({
      prompt,
      cwd: this.ctx.cwd,
      env: this.nodeEnv(),
      model: node.model ?? this.ctx.workflow.model,
      allowedTools: node.allowed_tools,
      deniedTools: node.denied_tools,
      outputFormat: node.output_format,
      resumeSessionId: this.inheritedSession(node),
      ...(this.deps.config.maxTurns > 0 ? { maxTurns: this.deps.config.maxTurns } : {}),
      idleTimeoutMs: node.idle_timeout ?? this.deps.config.nodeIdleTimeoutMs,
      signal: this.abort.signal,
      readOnly: this.ctx.dryRun,
      onText: (chunk) =>
        this.emit({ type: 'node_output', run_id: this.ctx.runId, node_id: node.id, line: chunk }),
    });

    if (res.sessionId) this.sessions.set(node.id, res.sessionId);

    if (res.cancelled) return { status: 'cancelled', output: res.text, error: 'cancelled' };
    if (res.timedOut) {
      return { status: 'failed', output: res.text, error: 'idle timeout waiting for the model' };
    }
    if (res.error) return { status: 'failed', output: res.text, error: res.error, sessionId: res.sessionId };

    return {
      status: 'completed',
      output: res.text,
      json: res.json,
      sessionId: res.sessionId,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    };
  }

  private async executeCommand(node: WorkflowNode): Promise<NodeResult> {
    const resolved = this.deps.commands.resolve(node.command!);
    if (!resolved) {
      return {
        status: 'failed',
        output: '',
        error: `command '${node.command}' was not found in .gaggle/commands/ or the bundled library`,
      };
    }
    return this.executeAi(node, resolved.prompt);
  }

  /**
   * Run one node, honouring its retry policy.
   *
   * Retries apply to the node as a whole. An `at_most_once` node is never
   * retried after producing output, even if the workflow asks — the point of
   * the marker is that repeating it may not be safe.
   */
  private async executeWithRetry(node: WorkflowNode): Promise<NodeResult> {
    const maxAttempts =
      node.side_effects === 'at_most_once' ? 1 : (node.retry?.max_attempts ?? 1);
    let delay = node.retry?.delay_ms ?? 3000;
    let last: NodeResult = { status: 'failed', output: '', error: 'node never ran' };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await this.executeNodeOnce(node);
      if (last.status !== 'failed' || attempt === maxAttempts) return last;
      if (this.abort.signal.aborted) return last;

      logger.info('Retrying node', {
        run_id: this.ctx.runId,
        node_id: node.id,
        attempt,
        max_attempts: maxAttempts,
        error: last.error,
      });
      await Bun.sleep(delay);
      delay *= 2;
    }
    return last;
  }

  private async executeNodeOnce(node: WorkflowNode): Promise<NodeResult> {
    // A decision may target a node that is not itself a gate: startup recovery
    // parks an interrupted `at_most_once` node behind a synthetic gate carrying
    // that node's id. Only approval and loop nodes consume decisions in their
    // own bodies, so without this every other node type would ignore the
    // human's answer and simply re-run — which is precisely what the marker
    // exists to prevent.
    if (node.type !== 'approval' && node.type !== 'loop') {
      const decision = this.takeDecisionFor(node.id);
      if (decision?.decision === 'rejected') {
        return {
          status: 'cancelled',
          output: '',
          cancel: {
            reason: `not re-running '${node.id}' after interruption: ${
              decision.comment ?? 'rejected by operator'
            }`,
          },
        };
      }
      // An approval means "run it anyway", so fall through.
    }

    switch (node.type) {
      case 'bash':
        return this.executeBash(node);
      case 'script':
        return this.executeScript(node);
      case 'prompt':
        return this.executeAi(node, node.prompt!);
      case 'command':
        return this.executeCommand(node);
      case 'cancel':
        return {
          status: 'completed',
          output: '',
          cancel: { reason: this.expand(node.cancel!, { shell: false }) },
        };
      case 'approval':
        return this.executeApproval(node);
      case 'loop':
        return this.executeLoop(node);
      default:
        return { status: 'failed', output: '', error: `unsupported node type '${node.type}'` };
    }
  }

  // ── approval gates ────────────────────────────────────────────────────────

  /**
   * An approval node either parks the run or consumes a decision that arrived
   * while it was parked.
   *
   * The decision is handed in by the executor before the resumed run starts,
   * rather than polled from here — the runner should never block on a human.
   */
  private async executeApproval(node: WorkflowNode): Promise<NodeResult> {
    const cfg = node.approval!;
    const decision = this.takeDecisionFor(node.id);

    if (!decision) {
      const message = this.expand(cfg.message, { shell: false });
      // At most one pending gate per run — the store enforces it with a
      // partial unique index. Two gates reaching this concurrently is possible
      // when they sit in the same layer, and the second must not throw: the
      // run is stopping either way, and the first gate is the one the human
      // will answer.
      const existing = await this.deps.store.getPendingApproval(this.ctx.runId);
      if (!existing) {
        await this.deps.store.createApproval({
          id: randomUUID(),
          run_id: this.ctx.runId,
          node_id: node.id,
          message,
        });
      }
      return { status: 'completed', output: '', pause: { message } };
    }

    if (decision.decision === 'approved') {
      // capture_response is what makes the approver's comment available to
      // downstream nodes as $<gate>.output.
      return { status: 'completed', output: cfg.capture_response ? (decision.comment ?? '') : '' };
    }

    const reason = decision.comment ?? 'rejected';
    if (!cfg.on_reject) {
      return { status: 'completed', output: '', cancel: { reason: `gate rejected: ${reason}` } };
    }

    const attempts = decision.rework_attempts;
    if (attempts >= cfg.on_reject.max_attempts) {
      return {
        status: 'completed',
        output: '',
        cancel: {
          reason: `gate rejected ${attempts} times (max_attempts ${cfg.on_reject.max_attempts}): ${reason}`,
        },
      };
    }

    // Run the rework prompt, then park at the same gate again.
    const rework = await this.executeAi(node, cfg.on_reject.prompt, { rejectionReason: reason });
    if (rework.status === 'failed') return rework;

    const message = this.expand(cfg.message, { shell: false });
    const id = randomUUID();
    await this.deps.store.createApproval({
      id,
      run_id: this.ctx.runId,
      node_id: node.id,
      message,
    });
    for (let i = 0; i < attempts + 1; i++) await this.deps.store.incrementReworkAttempts(id);
    return { status: 'completed', output: '', pause: { message } };
  }

  // ── loops ─────────────────────────────────────────────────────────────────

  /**
   * Iterate a prompt until it signals completion, a shell check passes, or the
   * iteration budget runs out.
   *
   * Iterations are persisted individually so a resumed loop picks up where it
   * stopped instead of redoing work that already landed in the repository.
   */
  private async executeLoop(node: WorkflowNode): Promise<NodeResult> {
    const cfg = node.loop!;
    const prior = await this.deps.store.getLoopIterations(this.ctx.runId, node.id);
    if (prior.some((p) => p.completed)) {
      const last = prior[prior.length - 1]!;
      return { status: 'completed', output: last.output ?? '' };
    }

    let iteration = prior.length;
    let sessionId = this.sessions.get(node.id);
    let lastOutput = prior[prior.length - 1]?.output ?? '';

    // Only the first iteration after a gate sees the human's feedback.
    let loopInput: string | null = null;
    const decision = this.takeDecisionFor(node.id);
    if (decision?.decision === 'rejected') {
      return {
        status: 'completed',
        output: lastOutput,
        cancel: { reason: `loop gate rejected: ${decision.comment ?? 'no reason given'}` },
      };
    }
    if (decision?.comment) loopInput = decision.comment;

    while (iteration < cfg.max_iterations) {
      if (this.abort.signal.aborted) {
        return { status: 'cancelled', output: lastOutput, error: 'cancelled' };
      }
      iteration += 1;

      const prompt = appendContextIfAbsent(
        this.expand(cfg.prompt, { shell: false, extra: { loopUserInput: loopInput ?? undefined } }),
        this.ctx.issueContext,
      );
      // Consumed: only the first iteration after a gate sees the feedback.
      loopInput = null;

      const res = await this.deps.ai({
        prompt,
        cwd: this.ctx.cwd,
        env: this.nodeEnv(),
        model: node.model ?? this.ctx.workflow.model,
        // fresh_context deliberately drops the session so each iteration
        // starts clean; state is expected to live on disk instead.
        resumeSessionId: cfg.fresh_context ? undefined : sessionId,
        idleTimeoutMs: node.idle_timeout ?? this.deps.config.nodeIdleTimeoutMs,
        signal: this.abort.signal,
        readOnly: this.ctx.dryRun,
        onText: (chunk) =>
          this.emit({ type: 'node_output', run_id: this.ctx.runId, node_id: node.id, line: chunk }),
      });

      if (res.sessionId) {
        sessionId = res.sessionId;
        this.sessions.set(node.id, res.sessionId);
      }
      if (res.cancelled) return { status: 'cancelled', output: res.text, error: 'cancelled' };
      if (res.timedOut) {
        return { status: 'failed', output: res.text, error: `loop iteration ${iteration} idle timeout` };
      }
      if (res.error) return { status: 'failed', output: res.text, error: res.error };

      lastOutput = stripPromiseTags(res.text);
      const signalled = detectCompletionSignal(res.text, cfg.until);
      const bashSaysDone = signalled ? false : await this.untilBashPasses(cfg.until_bash);
      const complete = signalled || bashSaysDone;

      await this.deps.store.appendLoopIteration({
        run_id: this.ctx.runId,
        node_id: node.id,
        iteration,
        output: lastOutput,
        user_input: null,
        completed: complete,
      });

      if (complete) {
        return { status: 'completed', output: lastOutput, sessionId };
      }

      if (cfg.interactive) {
        const message = this.expand(cfg.gate_message ?? '', { shell: false });
        const existing = await this.deps.store.getPendingApproval(this.ctx.runId);
        if (!existing) {
          await this.deps.store.createApproval({
            id: randomUUID(),
            run_id: this.ctx.runId,
            node_id: node.id,
            message,
          });
        }
        return { status: 'completed', output: lastOutput, pause: { message } };
      }
    }

    return {
      status: 'failed',
      output: lastOutput,
      error: `loop did not signal '${cfg.until}' within ${cfg.max_iterations} iterations`,
    };
  }

  private async untilBashPasses(script: string | undefined): Promise<boolean> {
    if (!script?.trim()) return false;
    const { text, bindings } = this.expandShell(script, { shell: true });
    const out = await runBash({
      script: text,
      cwd: this.ctx.cwd,
      env: { ...this.nodeEnv(), ...bindings },
      timeoutMs: this.deps.config.bashTimeoutMs,
      signal: this.abort.signal,
      bashPath: this.deps.bashPath,
    });
    return out.exit_code === 0 && !out.timed_out && !out.cancelled;
  }

  private takeDecisionFor(nodeId: string): PendingDecision | null {
    const d = this.pendingDecision;
    if (!d) return null;
    const covered = d.node_id === nodeId || (d.covers?.includes(nodeId) ?? false);
    if (!covered) return null;
    // A decision covering several nodes stays available for each of them. It
    // cannot be consumed twice by one node: an `at_most_once` node never
    // retries, and no node runs twice in a single attempt.
    if (!d.covers?.length) this.pendingDecision = null;
    return d;
  }

  private evaluateWhen(node: WorkflowNode) {
    if (!node.when) return null;
    return evaluateCondition(node.when, (ref) => {
      const entry = this.outputs.get(ref.node_id);
      if (!entry) return '';
      if (!ref.field) return entry.text;
      let json = entry.json;
      if (json === undefined || json === null) {
        try {
          json = JSON.parse(entry.text);
        } catch {
          return '';
        }
      }
      if (typeof json !== 'object' || json === null) return '';
      const value = (json as Record<string, unknown>)[ref.field];
      return value === undefined || value === null ? '' : String(value);
    });
  }

  private startLeaseHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      void this.deps.store
        .renewLease(this.ctx.runId, LEASE_OWNER, this.deps.config.leaseTtlMs)
        .catch((err) => logger.warn('Lease renewal failed', { error: (err as Error).message }));
    }, this.deps.config.leaseHeartbeatMs);

    this.runDeadline = setTimeout(() => {
      logger.warn('Run exceeded max duration — cancelling', {
        run_id: this.ctx.runId,
        max_run_duration_ms: this.deps.config.maxRunDurationMs,
      });
      this.cancel(`exceeded max_run_duration_ms (${this.deps.config.maxRunDurationMs}ms)`);
    }, this.deps.config.maxRunDurationMs);
  }

  private stopLeaseHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.runDeadline) clearTimeout(this.runDeadline);
    this.heartbeat = null;
    this.runDeadline = null;
  }

  /**
   * Drive the graph to completion, a gate, or a terminal failure.
   *
   * Nodes are dispatched as soon as their own dependencies settle rather than
   * in whole layers, so a slow node never holds back an unrelated branch.
   */
  async run(): Promise<RunnerStop> {
    const byId = new Map(this.ctx.workflow.nodes.map((n) => [n.id, n]));
    mkdirSync(this.ctx.artifactsDir, { recursive: true });

    // Refuse to execute a run another process is driving. Two runners on one
    // run would interleave node writes and re-execute everything the other has
    // not finished yet — including `at_most_once` nodes.
    const leased = await this.deps.store.acquireLease(
      this.ctx.runId,
      LEASE_OWNER,
      this.deps.config.leaseTtlMs,
    );
    if (!leased) {
      const stop: RunnerStop = {
        kind: 'failed',
        error: 'run is leased by another executor',
      };
      logger.warn('Refusing to run: lease held elsewhere', { run_id: this.ctx.runId });
      this.stopped = stop;
      // Tell the caller. The run row is deliberately left alone — the other
      // executor owns it — but without an event the orchestrator's session
      // never sees an exit and holds its concurrency slot forever.
      this.emit({ type: 'run_failed', run_id: this.ctx.runId, error: stop.error });
      return stop;
    }

    await this.deps.store.updateRun(this.ctx.runId, { status: 'running' });
    this.startLeaseHeartbeat();
    this.emit({ type: 'run_started', run_id: this.ctx.runId });
    await this.deps.store.appendEvent(this.ctx.runId, 'run_started', null);

    const inFlight = new Map<string, Promise<void>>();
    /** Nodes that never became runnable — populated only on a stuck graph. */
    let deadlocked: string[] = [];

    try {
      for (;;) {
        if (this.stopped) break;

        const step = plan({
          nodes: this.ctx.workflow.nodes,
          states: this.states,
          evaluateWhen: (n) => this.evaluateWhen(n),
        });

        for (const skip of step.skip) {
          const node = byId.get(skip.node_id)!;
          await this.record(node, 'skipped', { completed_at: new Date().toISOString() });
          this.emit({
            type: 'node_skipped',
            run_id: this.ctx.runId,
            node_id: node.id,
            reason: skip.reason,
          });
          await this.deps.store.appendEvent(this.ctx.runId, 'node_skipped', node.id, {
            reason: skip.reason,
          });
        }

        const startable = step.ready.filter((id) => !inFlight.has(id));
        const capacity = Math.max(0, this.deps.config.maxParallelNodes - inFlight.size);
        for (const id of startable.slice(0, capacity)) {
          const node = byId.get(id)!;
          inFlight.set(id, this.dispatch(node).finally(() => inFlight.delete(id)));
        }

        if (inFlight.size === 0) {
          if (step.finished) break;
          if (step.ready.length === 0 && step.skip.length === 0) {
            // Nothing running, nothing startable, yet the planner says work
            // remains: the graph cannot progress. A cycle does this — the
            // validator rejects those, but a runner that silently reported
            // success here would mark the Linear issue Done having executed
            // nothing at all.
            deadlocked = [...this.ctx.workflow.nodes]
              .filter((n) => !isSettled(this.states.get(n.id) ?? 'pending'))
              .map((n) => n.id);
            break;
          }
          continue;
        }

        await Promise.race(inFlight.values());
      }

      // Let anything still running finish before deciding the outcome.
      await Promise.allSettled(inFlight.values());

      if (!this.stopped) {
        if (deadlocked.length > 0) {
          this.stopped = {
            kind: 'failed',
            error:
              `the graph cannot progress — ${deadlocked.length} node(s) never became ` +
              `runnable: ${deadlocked.join(', ')}. This usually means a dependency cycle.`,
          };
        } else {
          const outcome = runOutcome(this.states);
          this.stopped =
            outcome === 'succeeded'
              ? { kind: 'succeeded' }
              : outcome === 'cancelled'
                ? { kind: 'cancelled', reason: 'a node cancelled the run' }
                : { kind: 'failed', error: this.firstFailure() ?? 'a node failed' };
        }
      }

      await this.finalize(this.stopped);
      return this.stopped;
    } catch (err) {
      // A store error must not skip finalize: without a terminal status the run
      // row stays `running` forever and the orchestrator's slot never frees.
      const stop: RunnerStop = { kind: 'failed', error: `run loop failed: ${(err as Error).message}` };
      logger.error('Run loop threw', { run_id: this.ctx.runId, error: (err as Error).message });
      this.stopped = stop;
      // Stop and drain before finalizing. The throw came from the loop, not
      // from the nodes, so anything in flight is still running: finalizing
      // now would resolve `done` as failed while nodes keep writing rows, and
      // the orchestrator would free the slot and start the next run against a
      // repository this one is still working in.
      this.abort.abort();
      await Promise.allSettled(inFlight.values());
      await this.finalize(stop).catch((e) =>
        logger.error('Could not finalize a failed run', {
          run_id: this.ctx.runId,
          error: (e as Error).message,
        }),
      );
      return stop;
    } finally {
      this.stopLeaseHeartbeat();
      await this.deps.store.releaseLease(this.ctx.runId, LEASE_OWNER).catch(() => {});
    }
  }

  private firstFailure(): string | null {
    for (const [id, status] of this.states) {
      if (status === 'failed') return `node '${id}' failed`;
    }
    return null;
  }

  private async dispatch(node: WorkflowNode): Promise<void> {
    await this.record(node, 'running');
    this.emit({
      type: 'node_started',
      run_id: this.ctx.runId,
      node_id: node.id,
      node_type: node.type,
    });
    await this.deps.store.appendEvent(this.ctx.runId, 'node_started', node.id, {
      node_type: node.type,
    });

    let result: NodeResult;
    try {
      result = await this.executeWithRetry(node);
    } catch (err) {
      result = { status: 'failed', output: '', error: (err as Error).message };
    }

    // A suspended node was not cancelled, it was interrupted. Recording an
    // outcome here would hide it from recovery — which looks for `running`
    // nodes — and an at_most_once node would then re-run unasked.
    if (this.suspended) return;

    // A gate stops the whole run; it is not a node outcome.
    if (result.pause) {
      this.stopped = { kind: 'paused', node_id: node.id, message: result.pause.message };
      await this.record(node, 'running');
      return;
    }

    if (result.cancel) {
      // A `cancel:` node reports 'completed' — it did its job. A node refused
      // by an at_most_once decision reports 'cancelled', because recording it
      // completed would claim the side effect ran.
      await this.record(node, result.status, {
        output: '',
        completed_at: new Date().toISOString(),
      });
      // Stop the siblings too. Without this the run reports cancelled while
      // nodes it decided not to run are still executing — and for a rejected
      // `at_most_once` node that is the side effect the human just refused.
      this.stopped = { kind: 'cancelled', reason: result.cancel.reason };
      this.abort.abort();
      return;
    }

    if (result.status === 'completed') {
      this.outputs.set(node.id, { text: result.output, json: result.json });
    }

    await this.record(node, result.status, {
      output: result.output,
      output_json: result.json,
      error: result.error ?? null,
      claude_session_id: result.sessionId ?? null,
      input_tokens: result.inputTokens ?? 0,
      output_tokens: result.outputTokens ?? 0,
      completed_at: new Date().toISOString(),
    });

    if (result.status === 'completed') {
      this.emit({
        type: 'node_completed',
        run_id: this.ctx.runId,
        node_id: node.id,
        output: result.output,
      });
      await this.deps.store.appendEvent(this.ctx.runId, 'node_completed', node.id);
    } else {
      this.emit({
        type: 'node_failed',
        run_id: this.ctx.runId,
        node_id: node.id,
        error: result.error ?? 'unknown error',
      });
      await this.deps.store.appendEvent(this.ctx.runId, 'node_failed', node.id, {
        error: result.error ?? null,
      });
    }
  }

  private async finalize(stop: RunnerStop): Promise<void> {
    // Suspended runs are deliberately left `running` and unsettled; see
    // `suspend()`. The lease is dropped by run()'s finally.
    if (this.suspended) {
      logger.info('Run suspended for shutdown; leaving it for recovery', {
        run_id: this.ctx.runId,
      });
      return;
    }

    const now = new Date().toISOString();
    switch (stop.kind) {
      case 'succeeded':
        await this.deps.store.updateRun(this.ctx.runId, { status: 'completed', completed_at: now });
        await this.deps.store.appendEvent(this.ctx.runId, 'run_completed', null);
        this.emit({ type: 'run_succeeded', run_id: this.ctx.runId });
        break;
      case 'failed':
        await this.deps.store.updateRun(this.ctx.runId, { status: 'failed', completed_at: now });
        await this.deps.store.appendEvent(this.ctx.runId, 'run_failed', null, { error: stop.error });
        this.emit({ type: 'run_failed', run_id: this.ctx.runId, error: stop.error });
        break;
      case 'cancelled':
        await this.deps.store.updateRun(this.ctx.runId, {
          status: 'cancelled',
          completed_at: now,
          metadata: { cancel_reason: stop.reason },
        });
        await this.deps.store.appendEvent(this.ctx.runId, 'run_cancelled', null, {
          reason: stop.reason,
        });
        this.emit({ type: 'run_cancelled', run_id: this.ctx.runId, reason: stop.reason });
        break;
      case 'paused':
        await this.deps.store.updateRun(this.ctx.runId, {
          status: 'paused',
          metadata: { approval: { nodeId: stop.node_id, message: stop.message } },
        });
        await this.deps.store.appendEvent(this.ctx.runId, 'run_gate_paused', stop.node_id, {
          message: stop.message,
        });
        this.emit({
          type: 'run_gate_paused',
          run_id: this.ctx.runId,
          node_id: stop.node_id,
          gate_message: stop.message,
        });
        break;
    }
  }

  /** Node states as the runner currently sees them. For assertions in tests. */
  get nodeStates(): ReadonlyMap<string, NodeStatus> {
    return this.states;
  }
}

export type { NodeResult };
