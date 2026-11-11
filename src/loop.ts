/**
 * loop — the supervisor-driven run the extension owns.
 *
 * `/supervise <goal>` in MCP mode asks the supervisor for the first instruction
 * and starts the worker itself; after each settled worker run it reviews the
 * report and injects the next instruction, until the supervisor says `done`,
 * says `blocked`, or a limit stops the run. The worker is never asked to
 * remember to consult the supervisor.
 *
 * Boundaries and guards, and why each exists:
 *
 * - The review boundary is `agent_settled`, not `agent_end`: pi keeps the run
 *   active through automatic retries, compaction, and queued follow-ups, and only
 *   emits `agent_settled` once nothing more will run. `agent_end` is kept as a
 *   fallback for hosts older than 0.80.4, armed on a timer that `agent_settled`
 *   cancels — never both, because a settled run is marked reviewed by token.
 * - `generation` invalidates everything in flight: a response that arrives after
 *   stop, restart, pause, or session switch is dropped instead of injected.
 * - One `AbortController` per request, so stop aborts the outstanding MCP call.
 * - `awaitingWorker` means "the instruction we injected has not come back yet", so
 *   no lifecycle event can review the same iteration twice.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackendOutcome, SupervisorBackend, SupervisorRequest } from "./backends/types.js";
import { SupervisorUnavailableError } from "./backends/types.js";
import { redactSecrets } from "./redact.js";
import { buildReport, type ReportInclude, summarizeDecision, summarizeWorker } from "./report.js";
import type { SteeringDecision, SupervisorPhase, SupervisorState } from "./types.js";

export interface LoopOptions {
  /** Send an instruction to the worker and start a run. */
  sendInstruction: (text: string) => void;
  notify: (message: string, level?: "info" | "warning" | "error") => void;
  /** Rebuild the backend for the current settings; called on start and resume. */
  createBackend: (ctx: ExtensionContext) => SupervisorBackend;
  /**
   * The worker's open todos, read from the session at the moment of the request.
   * Omit it, or return null, and the browser relay treats completion as undecidable
   * instead of assuming an empty list.
   */
  workerTodos?: (ctx: ExtensionContext) => { pending: number; inProgress: number; source?: string } | null;
  /** Current settings limits. */
  limits: () => { maxIterations: number; maxDurationMs: number; maxReportChars: number; include?: ReportInclude };
  /** Called after every phase or decision change so the widget can refresh. */
  render: (ctx: ExtensionContext) => void;
  /** Test seam: older pi hosts without `agent_settled`. */
  settleGraceMs?: number;
}

export interface LoopStatus {
  running: boolean;
  phase: SupervisorState["phase"];
  iteration: number;
  paused?: string;
  requestInFlight: boolean;
}

/**
 * `agent_end` fallback timing for hosts without `agent_settled`. Short enough to
 * feel immediate, long enough that a retry or compaction can cancel it first.
 */
const SETTLE_FALLBACK_MS = 1200;
const SETTLE_FALLBACK_ATTEMPTS = 25;

export class SupervisorLoop {
  private ctxRef: ExtensionContext | null = null;
  private generation = 0;
  private controller: AbortController | null = null;
  private awaitingWorker = false;
  /** Set by an explicit `/supervise resume`: relay one interrupted run, on purpose. */
  private resumeExplains = false;
  private workerActive = false;
  /**
   * True between `agent_start` and the settle boundary that consumes it. Two
   * settle events for one worker run must not produce two reviews — and no
   * counter this extension keeps can tell that apart, only the host's own
   * start boundary can.
   */
  private runOpen = false;
  private reviewedToken = -1;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private iteration = 0;
  private startedAt = 0;
  private lastInstruction = "";
  private noProgress = 0;
  private backend: SupervisorBackend | null = null;
  /** Entries already reported, so a review never re-sends the whole session. */
  private reportedEntryCount = 0;

  constructor(
    private readonly state: () => SupervisorState | null,
    private readonly setPhase: (phase: SupervisorPhase, reason?: string) => void,
    private readonly record: (patch: {
      lastDecision?: string;
      acceptanceCriteria?: string[];
      relay?: { turn?: number; attached?: boolean; activity?: string };
    }) => void,
    private readonly opts: LoopOptions
  ) {}

  // ---- public surface ----

  get running(): boolean {
    const phase = this.state()?.phase;
    return phase === "starting" || phase === "working" || phase === "reviewing";
  }

  get requestInFlight(): boolean {
    return this.controller !== null;
  }

  status(): LoopStatus {
    const state = this.state();
    return {
      running: this.running,
      phase: state?.phase,
      iteration: this.iteration,
      paused: state?.pauseReason,
      requestInFlight: this.requestInFlight,
    };
  }

  /**
   * Ask the supervisor for the first instruction and start the worker. Returns
   * false when the run paused before anything was dispatched.
   */
  async start(ctx: ExtensionContext): Promise<boolean> {
    this.ctxRef = ctx;
    this.reset();
    const state = this.state();
    if (!state) return false;
    this.generation++;
    this.startedAt = Date.now();
    this.iteration = 0;
    this.reportedEntryCount = 0;
    this.setPhase("starting");
    this.paint();
    return this.requestDecision(ctx, "initial");
  }

  /** Continue a paused run. Never replays the previous instruction. */
  async resume(ctx: ExtensionContext): Promise<boolean> {
    this.ctxRef = ctx;
    const state = this.state();
    if (!state?.active) return false;
    if (state.phase === "paused" || state.phase === undefined) {
      this.generation++;
      this.clearSettleTimer();
      this.awaitingWorker = false;
      this.workerActive = false;
      this.setPhase("reviewing");
      this.paint();
      // The report is self-contained, so resuming reviews the current state of
      // the transcript rather than repeating what was already dispatched.
      // An explicit resume is the one moment the interruption is allowed to be
      // relayed: the human asked, so the pause does not simply re-arm itself.
      this.resumeExplains = true;
      return this.requestDecision(ctx, "review");
    }
    return false;
  }

  /**
   * Stop everything immediately. `workerRunning` tells the caller whether the
   * worker itself is still executing — this loop does not interrupt it.
   */
  async stop(workerRunning: boolean): Promise<void> {
    this.generation++;
    this.clearSettleTimer();
    this.controller?.abort();
    this.controller = null;
    this.awaitingWorker = false;
    this.workerActive = false;
    this.backend = null;
    this.setPhase("paused", "stopped");
    this.paint();
    if (workerRunning) this.opts.notify("Supervisor stopped. The worker is still running — press Esc to interrupt it.", "warning");
  }

  /** Drop all loop state (session switch/shutdown). In-flight replies become stale. */
  invalidate(): void {
    this.generation++;
    this.clearSettleTimer();
    this.controller?.abort();
    this.controller = null;
    this.awaitingWorker = false;
    this.workerActive = false;
    this.iteration = 0;
    this.lastInstruction = "";
    this.noProgress = 0;
    this.reportedEntryCount = 0;
    const backend = this.backend;
    this.backend = null;
    void backend?.dispose?.();
  }

  onWorkerStart(): void {
    this.workerActive = true;
    this.runOpen = true;
    this.clearSettleTimer();
  }

  /** `agent_settled` — the only authoritative "this worker run is over" event. */
  async onWorkerSettled(ctx: ExtensionContext, aborted: boolean): Promise<void> {
    this.ctxRef = ctx;
    this.clearSettleTimer();
    const generation = this.generation;
    this.workerActive = false;
    // One review per worker run: the start boundary is the only thing that can
    // prove this settle event is a run we have not already judged.
    if (!this.runOpen) return;
    this.runOpen = false;
    if (aborted) {
      this.pause("interrupted", "The worker run was interrupted, so supervision paused instead of guessing.");
      return;
    }
    if (!this.awaitingWorker) {
      // Nobody asked for this review: either the user prompted the worker, or the
      // same settled run was reported twice. Pause rather than race.
      if (this.running) this.pause("not awaiting a review", "Supervision paused: this worker run was not started by the supervisor.");
      return;
    }
    if (this.reviewedToken === generation) return;
    this.reviewedToken = generation;
    this.awaitingWorker = false;
    await this.requestDecision(ctx, "review");
  }

  /**
   * `agent_end` compatibility path for hosts without `agent_settled` (pi < 0.80.4).
   *
   * An end is NOT proof that nothing more will run: automatic retries, compaction,
   * and queued follow-ups all continue the run. So the timer only reviews when the
   * host reports the agent idle with nothing queued, re-arms otherwise, and gives
   * up rather than injecting into a live run.
   */
  onWorkerEnd(ctx: ExtensionContext): void {
    this.ctxRef = ctx;
    const generation = this.generation;
    if (!this.awaitingWorker) return;
    // A later end refreshes the poll with the newest context; the host state it
    // reports (idle, queue) is what decides whether reviewing is safe.
    this.clearSettleTimer();
    // On a host without `agent_settled` nothing else ever clears workerActive, so
    // the end is the best signal available. The fallback's own idle/queue check is
    // what keeps it from injecting into a retry, compaction, or queued follow-up.
    this.workerActive = false;
    this.armSettleFallback(ctx, generation, 0);
  }

  private armSettleFallback(ctx: ExtensionContext, generation: number, attempt: number): void {
    this.clearSettleTimer();
    const timer = setTimeout(() => {
      this.settleTimer = null;
      if (generation !== this.generation || !this.awaitingWorker || this.workerActive) return;
      if (ctx.hasPendingMessages() || !ctx.isIdle()) {
        if (attempt + 1 < SETTLE_FALLBACK_ATTEMPTS) this.armSettleFallback(ctx, generation, attempt + 1);
        else this.pause("no settle signal", "the worker kept running after it reported an end, and supervision will not inject into a live run");
        return;
      }
      void this.onWorkerSettled(ctx, false);
    }, this.opts.settleGraceMs ?? SETTLE_FALLBACK_MS);
    // Never hold the process open for a compatibility timer.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.settleTimer = timer;
  }

  /** An unrelated prompt from the user pauses the loop instead of racing it. */
  onUserInput(): boolean {
    if (this.running || this.awaitingWorker) {
      this.pause("user prompt", "You sent a message, so the supervisor paused. /supervise resume to continue, /supervise stop to end it.");
      return true;
    }
    return false;
  }

  // ---- internals ----

  /** Repaint the widget for whichever context the loop last saw. */
  private paint(): void {
    if (this.ctxRef) this.opts.render(this.ctxRef);
  }

  private reset(): void {
    this.generation++;
    this.clearSettleTimer();
    this.controller?.abort();
    this.controller = null;
    this.awaitingWorker = false;
    this.workerActive = false;
    this.reviewedToken = -1;
    this.iteration = 0;
    this.lastInstruction = "";
    this.noProgress = 0;
    const backend = this.backend;
    this.backend = null;
    void backend?.dispose?.();
  }

  private pause(kind: string, detail: string): void {
    this.clearSettleTimer();
    this.controller?.abort();
    this.controller = null;
    // Drop the connection: what the user changes while paused — endpoint, tool,
    // report limits — has to be in force on resume, not the settings that were
    // current when the supervisor first connected.
    const dropped = this.backend;
    this.backend = null;
    void dropped?.dispose?.();
    this.awaitingWorker = false;
    this.workerActive = false;
    this.runOpen = false;
    const reason = `${kind}: ${redactSecrets(detail)}`.slice(0, 400);
    this.setPhase("paused", reason);
    this.record({ relay: { activity: reason } });
    this.paint();
  }

  private clearSettleTimer(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private async requestDecision(ctx: ExtensionContext, kind: "initial" | "review"): Promise<boolean> {
    const generation = ++this.generation;
    const state = this.state();
    if (!state) return false;

    const limits = this.opts.limits();

    // Limits stop the run; they never decide the outcome.
    const limitHit = this.limitReason(state, limits);
    if (limitHit) {
      this.pause(limitHit, "The supervisor stopped here rather than calling unfinished work complete.");
      this.opts.notify(`Supervisor paused — ${limitHit}. /supervise status for details.`, "warning");
      return false;
    }

    const entries = ctx.sessionManager.getBranch();
    const fresh = entries.slice(this.reportedEntryCount);
    // What the agent actually said, kept apart from the evaluator report so the
    // relay forwards the worker's own words rather than a summary of them.
    const worker = summarizeWorker(fresh);
    // Interruption and silence are not data to relay — they are reasons to stop and
    // say so. A run that was cut short, or that ended without any final response,
    // pauses the relay instead of letting the supervisor guess what happened: nothing
    // is sent to Perplexity and nothing is dispatched. A run that *completed* while
    // reporting failures is the opposite case — that is a real result, and it travels
    // on. `/supervise resume` explains an interruption deliberately, never automatic.
    // "Unexplained" needs evidence of a run. A batch with no entries at all is not a
    // silent worker; it is the extension seeing nothing, which happens when a session
    // switched underneath the run. Requiring activity keeps the pause honest.
    const activity = fresh.some((entry) => (entry as { type?: unknown } | null)?.type === "message");
    const judged = kind !== "initial" && state.backend === "mcp" && !this.resumeExplains;
    this.resumeExplains = false; // the allowance is spent whether or not it was used
    const incompleteRun = !judged
      ? ""
      : worker.aborted
        ? "the worker run was interrupted or stopped with an error before finishing"
        : worker.noResponse && activity
          ? "the worker run ended without a final response"
          : "";
    if (incompleteRun) {
      this.pause(
        "worker run incomplete",
        `Paused: ${incompleteRun}. Nothing was sent to the supervisor, and nothing was dispatched.`
      );
      this.opts.notify(
        `Supervisor paused: ${incompleteRun}. Nothing was sent to the supervisor. /supervise resume to continue and explain it.`,
        "error"
      );
      return false; // paused above; there is no decision to apply
    }
    const report = buildReport({
      goal: state.outcome,
      acceptanceCriteria: state.acceptanceCriteria ?? [],
      iteration: this.iteration + 1,
      maxIterations: limits.maxIterations,
      instruction: this.lastInstruction || undefined,
      entries: fresh,
      history: state.interventions.map((iv, i) => ({
        iteration: i + 1,
        action: "steer",
        summary: iv.message,
      })),
      initial: kind === "initial",
      limits: { maxChars: limits.maxReportChars },
      include: limits.include,
    });

    if (!this.backend) this.backend = this.opts.createBackend(ctx);
    const backend = this.backend;
    const controller = new AbortController();
    this.controller = controller;
    this.setPhase("reviewing");
    this.paint();

    const request: SupervisorRequest = {
      kind,
      state,
      report,
      agentIsIdle: true,
      stagnating: false,
      workerText: worker.finalText,
      workerFacts: { aborted: worker.aborted, noResponse: worker.noResponse, toolErrors: worker.toolErrors },
      workerTodos: this.opts.workerTodos?.(ctx) ?? null,
    };

    let outcome: BackendOutcome | undefined;
    try {
      outcome = await backend.review(request, controller.signal);
    } catch (error) {
      if (generation !== this.generation) return false; // stopped, resumed, or switched
      this.controller = null;
      this.handleFailure(error);
      return false;
    }

    this.controller = null;
    if (generation !== this.generation) return false; // reply arrived too late
    if (!this.state()?.active) return false;
    // A backend that answers with nothing is broken, not merely disagreeing.
    if (!outcome?.decision) {
      this.pause("unavailable", "The supervisor answered without a decision.");
      return false;
    }

    if (outcome.decision.acceptanceCriteria?.length && !(state.acceptanceCriteria?.length ?? 0)) {
      this.record({ acceptanceCriteria: outcome.decision.acceptanceCriteria });
    }
    this.record({
      lastDecision: summarizeDecision(outcome.decision),
      relay: {
        turn: outcome.conversation?.turn,
        attached: outcome.conversation?.attached,
        activity: `${outcome.detail ?? "the supervisor replied"} → ${outcome.decision.action}`.slice(0, 300),
      },
    });
    this.paint();

    return this.applyDecision(ctx, outcome.decision, limits, outcome.terminal === true);
  }

  private limitReason(state: SupervisorState, limits: { maxIterations: number; maxDurationMs: number }): string | null {
    if (this.iteration >= limits.maxIterations) return `reached the ${limits.maxIterations}-iteration limit`;
    if (this.startedAt && Date.now() - this.startedAt > limits.maxDurationMs) {
      return `exceeded the ${Math.round(limits.maxDurationMs / 60000)} minute limit`;
    }
    if (state.interventions.length >= limits.maxIterations * 2) return "too many steering attempts for this goal";
    return null;
  }

  private handleFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SupervisorUnavailableError) {
      this.pause(error.kind, message);
      this.opts.notify(`Supervisor paused (${error.kind}): ${message}`, "error");
      return;
    }
    this.pause("supervisor request failed", message);
    this.opts.notify(`Supervisor paused: ${message}`, "error");
  }

  private applyDecision(
    ctx: ExtensionContext,
    decision: SteeringDecision,
    limits: { maxIterations: number },
    terminal = false
  ): boolean {
    switch (decision.action) {
      case "done": {
        // A relay reply that ended on [[PPLX_DONE]] is the supervisor's own
        // verdict, written in prose. There is no evidence contract to demand
        // from it: show what it said and stop.
        if (terminal) {
          this.setPhase("done");
          this.record({ relay: { activity: "the supervisor signalled completion" } });
          const summary = decision.message?.trim();
          this.opts.notify(`Supervisor: goal met.${summary ? `\n${summary}` : ""}`, "info");
          this.paint();
          return true;
        }
        const missing = this.incompleteEvidence(decision);
        if (missing) {
          // "done" without proof is not proof. Send the worker off to produce the
          // evidence instead of accepting the claim or pausing on the spot.
          this.iteration++;
          this.dispatch(
            ctx,
            `Do not treat the goal as finished yet. For each acceptance criterion, run the check that proves it and report the command with its output — still missing concrete evidence for: ${missing}.`
          );
          return true;
        }
        this.setPhase("done");
        this.opts.notify(`Supervisor: goal met. ${decision.criteria?.map((c) => c.criterion).join("; ") ?? ""}`.trim(), "info");
        this.paint();
        return true;
      }

      case "blocked":
        this.pause("blocked", decision.blocker ?? "the supervisor reported a blocker without detail");
        this.opts.notify(`Supervisor is blocked: ${decision.blocker ?? "(no detail)"} — /supervise resume once it is resolved.`, "warning");
        return true;

      case "steer": {
        const instruction = decision.message?.trim();
        if (!instruction) {
          this.pause("empty instruction", 'the supervisor returned "steer" with no instruction');
          this.opts.notify('Supervisor paused: "steer" without an instruction.', "error");
          return false;
        }
        // The same instruction twice in a row means the supervisor is not making
        // progress. Pause; do not keep spending turns, and do not call it done.
        if (instruction === this.lastInstruction) {
          this.noProgress++;
          if (this.noProgress >= 2) {
            this.pause("stagnated", `the supervisor repeated the same instruction ${this.noProgress} times with no change`);
            this.opts.notify("Supervisor paused — it repeated the same instruction without progress. /supervise resume to try again.", "warning");
            return false;
          }
        } else {
          this.noProgress = 0;
        }
        if (this.iteration + 1 > limits.maxIterations) {
          this.pause(`reached the ${limits.maxIterations}-iteration limit`, "the run stopped here rather than calling unfinished work complete");
          this.opts.notify(`Supervisor paused — iteration limit (${limits.maxIterations}).`, "warning");
          return false;
        }
        this.iteration++;
        this.dispatch(ctx, instruction);
        return true;
      }

      default:
        // `continue` cannot advance an idle run.
        this.pause("useless decision", 'the supervisor returned "continue", which cannot advance an idle run');
        this.opts.notify('Supervisor paused: it replied "continue" while the worker was idle.', "error");
        return false;
    }
  }

  /** Criteria that were claimed met without evidence, or not met at all. */
  private incompleteEvidence(decision: SteeringDecision): string {
    const criteria = decision.criteria ?? [];
    const bad = criteria.filter((c) => !c.met || !c.evidence.trim());
    if (!criteria.length) return "every acceptance criterion (no assessment was provided)";
    if (decision.unresolved?.length) return `the unresolved failures: ${decision.unresolved.join(", ")}`;
    return bad.length ? bad.map((c) => c.criterion).join("; ") : "";
  }

  private dispatch(ctx: ExtensionContext, instruction: string): void {
    const text = redactSecrets(instruction).trim();
    const state = this.state();
    this.lastInstruction = text;
    this.awaitingWorker = true;
    this.reviewedToken = -1;
    this.reportedEntryCount = ctx.sessionManager.getBranch().length;
    this.setPhase("working");
    this.record({ lastDecision: `steer: ${text.slice(0, 200)}` });

    // Recorded as an intervention so the history travels with every later report.
    state?.interventions.push({
      turnCount: state.turnCount,
      message: text,
      reasoning: "supervisor decision",
      timestamp: Date.now(),
    });

    this.paint();
    this.opts.sendInstruction(text);
  }
}
