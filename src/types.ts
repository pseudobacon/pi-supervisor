/**
 * Core types for the pi-supervisor extension.
 */

export type Sensitivity = "low" | "medium" | "high";

/**
 * Normalized supervisor actions.
 *
 * `continue` is only meaningful for the model-backed mid-run check (the agent is
 * still working, so doing nothing is a valid answer). The MCP idle loop rejects it.
 * `blocked` pauses the loop and hands control back to the user.
 */
export type SupervisorAction = "continue" | "steer" | "done" | "blocked";

/** Which supervisor answers the loop. */
export type SupervisorBackendId = "model" | "mcp";

/**
 * Where an MCP-mode supervision run currently is. Persisted so a restart can
 * restore a run paused instead of silently continuing it.
 */
export type SupervisorPhase =
  | "starting" // initial instruction requested from the supervisor
  | "working" // instruction dispatched, worker running
  | "reviewing" // worker settled, supervisor report in flight
  | "paused" // needs an explicit `/supervise resume`
  | "done"; // terminal success

/** A single intervention record */
export interface SupervisorIntervention {
  turnCount: number;
  message: string;
  reasoning: string;
  timestamp: number;
}

/** One acceptance criterion with the evidence that proves it. */
export interface CompletionCriterion {
  criterion: string;
  /** Concrete, checkable evidence — a command plus its result, a file, a test name. */
  evidence: string;
  met: boolean;
}

/** Full supervisor state — persisted to session */
export interface SupervisorState {
  active: boolean;
  outcome: string;
  provider: string; // e.g. "anthropic"
  modelId: string; // e.g. "claude-haiku-4-5-20251001"
  sensitivity: Sensitivity;
  interventions: SupervisorIntervention[];
  startedAt: number;
  turnCount: number;

  // ---- MCP backend / autonomous loop (all optional: older sessions lack them) ----

  /** Defaults to "model" when absent. */
  backend?: SupervisorBackendId;
  /** Loop phase. Only meaningful while `backend === "mcp"`. */
  phase?: SupervisorPhase;
  /** Why the loop paused — shown by `/supervise status`, never contains secrets. */
  pauseReason?: string;
  /** One-line summary of the latest normalized decision. */
  lastDecision?: string;
  /** Acceptance criteria the supervisor derived from the goal, kept for every review. */
  acceptanceCriteria?: string[];
  /** Secret-free summary of the active MCP settings, for status display. */
  mcpSummary?: string;

  // ---- chat relay bookkeeping (the pplx-proxy conversation) ----

  /** Which conversation this run owns. A new goal opens a new one. */
  conversationId?: string;
  /** The setup message went into that conversation, so a resume does not resend it. */
  relayIntroSent?: boolean;
  /** Turn count within the conversation, for `/supervise status`. */
  relayTurn?: number;
  /** False when a turn started fresh instead of continuing the conversation. */
  conversationAttached?: boolean;
  /** Last thing the relay reported — an instruction summary, a marker, or an error. */
  lastActivity?: string;
  /** Transport attempts against /v1/responses this run has spent — failures and timeouts included. */
  relayAttempts?: number;
}

/** Decision returned by a supervisor backend */
export interface SteeringDecision {
  action: SupervisorAction;
  /** Worker instruction. Required (non-empty) for `steer`. */
  message?: string;
  reasoning: string;
  confidence: number;
  /** `done` only: per-criterion assessment with evidence. */
  criteria?: CompletionCriterion[];
  /** `done` only: failures that still have to be resolved. Non-empty blocks `done`. */
  unresolved?: string[];
  /** `blocked` only: the specific missing permission, credential, or decision. */
  blocker?: string;
  /** First reply only: acceptance criteria the supervisor derived from the goal. */
  acceptanceCriteria?: string[];
}

/** A simplified message for building the supervisor context */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}
