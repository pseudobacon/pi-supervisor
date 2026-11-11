/**
 * backends/types — the seam between the supervision loop and whoever answers.
 *
 * The loop only knows this interface: it never sees MCP transports, model
 * registries, prompts, or parsers, and the UI never asks which backend answered.
 *
 * `report` is what the MCP backend sends; `state` / `agentIsIdle` / `stagnating`
 * / `onDelta` are what the model backend already consumed. One request shape, two
 * readers, so the two backends cannot drift into different decision vocabularies.
 */

import type { SteeringDecision, SupervisorBackendId, SupervisorState } from "../types.js";

export interface SupervisorBackend {
  readonly id: SupervisorBackendId;
  /** Secret-free one-liner for the widget, `/supervise status`, and notices. */
  readonly label: string;
  /** Ask for a decision. Rejects when `signal` fires or the supervisor is unreachable. */
  review(request: SupervisorRequest, signal?: AbortSignal): Promise<BackendOutcome>;
  /** Release connections / child resources. */
  dispose?(): Promise<void>;
}

export interface SupervisorRequest {
  /**
   * `initial` — before the worker has run, ask for the first instruction.
   * `review`  — judge a finished worker iteration.
   * `repair`  — the previous reply was rejected; ask for a corrected one.
   */
  kind: "initial" | "review" | "repair";
  state: SupervisorState;
  /** Bounded, redacted, self-contained report (built by report.ts). */
  report: string;
  /** Repair only: the rejected reply and why it was rejected. */
  repair?: { raw: string; summary: string };

  // Model-backend inputs (unused by the relay, which is idle-only by design).

  /**
   * The worker's actual final response for this iteration — what the chat relay
   * forwards back to the supervisor, ahead of any summary.
   */
  workerText?: string;
  /** Facts about the run the agent cannot report about itself (abort, failing tools). */
  workerFacts?: { aborted?: boolean; noResponse?: boolean; toolErrors?: string[] };
  /**
   * The worker's open todo counts, or null when this host does not expose a todo list.
   * pi 1.5.0 core does not — a list exists only if a tool like
   * `examples/extensions/todo.ts` is installed — so null is the ordinary answer, and
   * the browser relay reads it as "undecidable" rather than "nothing open".
   */
  workerTodos?: { pending: number; inProgress: number; source?: string } | null;
  agentIsIdle: boolean;
  stagnating: boolean;
  onDelta?: (accumulated: string) => void;
}

export interface BackendOutcome {
  decision: SteeringDecision;
  /** True when the reply needed one repair round to become valid. */
  repaired?: boolean;
  /** Supervisor text, redacted and bounded — kept for the repair round. */
  raw: string;
  /** How the request was actually sent, for status output. Never contains secrets. */
  detail?: string;
  /**
   * The reply ended on a terminal marker, so it is the supervisor's own verdict:
   * the loop reports it and stops instead of demanding the evidence contract a
   * prose reply was never given.
   */
  terminal?: boolean;
  /** Conversation bookkeeping for `/supervise status`. Never a secret. */
  conversation?: { id: string; turn: number; attached: boolean };
}

/**
 * Anything that must pause the loop instead of producing a worker instruction:
 * bad configuration, an unreachable server, or a reply that never validated.
 */
export class SupervisorUnavailableError extends Error {
  constructor(
    message: string,
    readonly kind: "config" | "transport" | "malformed" | "protocol" = "transport"
  ) {
    super(message);
    this.name = "SupervisorUnavailableError";
  }
}
