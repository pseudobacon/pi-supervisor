/**
 * SupervisorStateManager — manages in-memory supervisor state and session persistence.
 *
 * The same record backs both backends. `backend` decides who answers; the
 * `phase` / `pauseReason` / `lastDecision` fields drive the MCP loop and are
 * persisted so a restart restores a run paused rather than silently resuming it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nonGoalReason, SUPERVISE_SUBCOMMANDS } from "./command-intent.js";
import type {
  Sensitivity,
  SupervisorBackendId,
  SupervisorIntervention,
  SupervisorPhase,
  SupervisorState,
} from "./types.js";

const ENTRY_TYPE = "supervisor-state";

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL_ID = "claude-haiku-4-5-20251001";
export const DEFAULT_SENSITIVITY: Sensitivity = "medium";

export interface StartOptions {
  backend?: SupervisorBackendId;
  acceptanceCriteria?: string[];
  mcpSummary?: string;
  /** Conversation to own. A new goal always gets a new one. */
  conversationId?: string;
  /** Carry the setup flag across a restart of the same conversation. */
  relayIntroSent?: boolean;
}

/** A run restored from disk is never allowed to resume on its own. */
const RESUMABLE_PHASES: SupervisorPhase[] = ["starting", "working", "reviewing"];

export class SupervisorStateManager {
  private state: SupervisorState | null = null;
  private pi: ExtensionAPI;
  /** Set by loadFromSession when a run happened but no state survived. */
  private missingStateNote: string | null = null;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  start(outcome: string, provider: string, modelId: string, sensitivity: Sensitivity, options: StartOptions = {}): void {
    const backend = options.backend ?? "model";
    this.state = {
      active: true,
      outcome,
      provider,
      modelId,
      sensitivity,
      interventions: [],
      startedAt: Date.now(),
      turnCount: 0,
      backend,
      phase: backend === "mcp" ? "starting" : undefined,
      acceptanceCriteria: options.acceptanceCriteria ?? [],
      mcpSummary: options.mcpSummary,
      pauseReason: undefined,
      lastDecision: undefined,
      conversationId: options.conversationId,
      relayIntroSent: options.relayIntroSent === true,
      relayTurn: 0,
      conversationAttached: undefined,
      lastActivity: undefined,
    };
    this.missingStateNote = null;
    this.persist();
  }

  stop(): void {
    if (!this.state) return;
    this.state.active = false;
    this.state.phase = undefined;
    this.persist();
  }

  isActive(): boolean {
    return this.state?.active === true;
  }

  getState(): SupervisorState | null {
    return this.state;
  }

  /**
   * Set when a restored session has no supervisor state but shows evidence a run
   * started and lost its state — see `missingStateDiagnosis`.
   */
  getMissingStateNote(): string | null {
    return this.missingStateNote;
  }

  getBackend(): SupervisorBackendId {
    return this.state?.backend ?? "model";
  }

  getPhase(): SupervisorPhase | undefined {
    return this.state?.phase;
  }

  addIntervention(intervention: SupervisorIntervention): void {
    if (!this.state) return;
    this.state.interventions.push(intervention);
    this.persist();
  }

  incrementTurnCount(): void {
    if (!this.state) return;
    this.state.turnCount++;
  }

  setModel(provider: string, modelId: string): void {
    if (!this.state) return;
    this.state.provider = provider;
    this.state.modelId = modelId;
    this.persist();
  }

  setSensitivity(sensitivity: Sensitivity): void {
    if (!this.state) return;
    this.state.sensitivity = sensitivity;
    this.persist();
  }

  // ---- MCP loop bookkeeping ----

  setPhase(phase: SupervisorPhase, pauseReason?: string): void {
    if (!this.state) return;
    this.state.phase = phase;
    this.state.pauseReason = phase === "paused" ? pauseReason : undefined;
    this.persist();
  }

  setLastDecision(summary: string): void {
    if (!this.state) return;
    this.state.lastDecision = summary;
    this.persist();
  }

  setAcceptanceCriteria(criteria: string[]): void {
    if (!this.state) return;
    this.state.acceptanceCriteria = criteria;
    this.persist();
  }

  setMcpSummary(summary: string): void {
    if (!this.state) return;
    this.state.mcpSummary = summary;
    this.persist();
  }

  /** Attach a conversation id to a run started before this extension tracked one. */
  setConversationId(id: string): void {
    if (!this.state) return;
    this.state.conversationId = id;
    this.persist();
  }

  /** Remember that the setup message is in the conversation, so resume does not resend it. */
  setRelayIntroSent(sent: boolean): void {
    if (!this.state) return;
    this.state.relayIntroSent = sent;
    this.persist();
  }

  /** Count one spent /v1/responses transport attempt — failures and timeouts included. */
  recordRelayAttempt(): void {
    if (!this.state) return;
    this.state.relayAttempts = (this.state.relayAttempts ?? 0) + 1;
    this.persist();
  }

  /** Record the conversation's current turn, whether it continued, and what happened. */
  setRelayActivity(patch: { turn?: number; attached?: boolean; activity?: string }): void {
    if (!this.state) return;
    if (patch.turn !== undefined) this.state.relayTurn = patch.turn;
    if (patch.attached !== undefined) this.state.conversationAttached = patch.attached;
    if (patch.activity !== undefined) this.state.lastActivity = patch.activity;
    this.persist();
  }

  /** Restore state from session entries (finds the most recent supervisor-state entry). */
  loadFromSession(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && (entry as any).customType === ENTRY_TYPE) {
        this.state = normalizePersisted((entry as any).data as SupervisorState);
        this.missingStateNote = null;
        return;
      }
    }
    this.state = null;
    this.missingStateNote = missingStateDiagnosis(entries);
  }

  /**
   * Called after a session restore. An MCP run that was mid-flight when pi
   * exited, switched session, or reloaded comes back paused: an explicit
   * `/supervise resume` is the only thing that restarts it, and nothing about
   * the previous iteration is replayed automatically.
   */
  pauseRestoredRun(): boolean {
    if (!this.state?.active) return false;
    if (this.getBackend() !== "mcp") return false;
    if (!this.state.phase || !RESUMABLE_PHASES.includes(this.state.phase)) return false;
    this.state.phase = "paused";
    this.state.pauseReason = "restored from a previous session — nothing was replayed";
    this.persist();
    return true;
  }

  private persist(): void {
    if (!this.state) return;
    this.pi.appendEntry(ENTRY_TYPE, { ...this.state });
  }
}

/** Older session files have no backend/phase fields; defaults keep them working. */
export function normalizePersisted(data: SupervisorState | null | undefined): SupervisorState | null {
  if (!data) return null;
  const state: SupervisorState = { ...data };
  if (!Array.isArray(state.interventions)) state.interventions = [];
  if (state.backend !== "mcp" && state.backend !== "model") state.backend = "model";
  return state;
}

/**
 * A restored session can lack supervisor state in two ways: no supervision was ever
 * started, or a run started and its state was lost — the host exited or crashed before
 * the session file flushed, so nothing was ever persisted and nothing can be restored.
 * The two deserve different words. Evidence of the second: a user message that started
 * a supervision — a `/supervise` goal, not a control word — with no state entry.
 */
export const MISSING_STATE_NOTE =
  "No supervisor state in this session, but it contains a /supervise goal — a run was started and its state was lost (for example, the host exited before the session file flushed). Nothing can be restored; start a new goal with /supervise <goal>.";

export function missingStateDiagnosis(entries: readonly unknown[]): string | null {
  for (const raw of entries) {
    const entry = raw as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null;
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = Array.isArray(content)
      ? content
          .map((block) => {
            const b = block as { text?: unknown } | null;
            return b && typeof b === "object" && typeof b.text === "string" ? b.text : "";
          })
          .join("")
      : typeof content === "string"
        ? content
        : "";
    const trimmedText = text.trim();
    if (!trimmedText.startsWith("/supervise ")) continue;
    const args = trimmedText.slice("/supervise ".length).trim();
    // nonGoalReason returns "" for a genuine goal. Exact subcommands are commands,
    // not goals, and never started a run — and control words with extra text are
    // rejected by nonGoalReason — so neither is evidence of a lost run.
    if (
      args !== "" &&
      nonGoalReason(args) === "" &&
      !(SUPERVISE_SUBCOMMANDS as readonly string[]).includes(args)
    ) {
      return MISSING_STATE_NOTE;
    }
  }
  return null;
}
