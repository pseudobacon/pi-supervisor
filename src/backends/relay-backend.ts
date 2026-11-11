/**
 * backends/relay-backend — the Perplexity chat relay.
 *
 * One conversation, opened with the user's goal, kept alive by its id for the
 * whole run. Each turn sends one message and receives one prose reply:
 *
 *   turn 1  goal + relay setup            → Perplexity's first instruction
 *   turn 2  "Local coding agent result:"  → the next instruction
 *   ...                                   → until [[PPLX_DONE]] / [[PPLX_BLOCKED]]
 *
 * Nothing is parsed. The reply is forwarded to the worker as written; the worker's
 * own final response is forwarded back as written. The only thing read out of a
 * reply is its final line, and only to recognise the two terminal markers.
 *
 * `id` stays "mcp" because that is the value already persisted in existing
 * session files for "the pplx-proxy backend"; the label is what users see.
 */

import type { McpSettings } from "../mcp/config.js";
import { type FetchLike, newConversationId, PerplexityChat, type RelayAttemptBudget } from "../relay/chat.js";
import { resolveRelay } from "../relay/config.js";
import {
  buildIntroPrompt,
  buildWorkerResultMessage,
  detectRelayMarkers,
  EMPTY_REPLY,
  loadRelayTemplate,
  relayNotes,
} from "../relay/protocol.js";
import type { BackendOutcome, SupervisorBackend, SupervisorRequest } from "./types.js";
import { SupervisorUnavailableError } from "./types.js";

export interface RelayBackendOptions {
  settings: McpSettings;
  cwd: string;
  /** Persisted per run: a new goal opens a new conversation, resume keeps this one. */
  conversationId: string;
  /** True when the setup message already went out (restored or resumed run). */
  introSent?: boolean;
  /** Persist the flag the moment the setup lands, so a restart does not resend it. */
  onIntroSent?: () => void;
  fetchImpl?: FetchLike;
  /** Hard transport budget for this run's /v1/responses attempts. */
  budget?: RelayAttemptBudget;
}

export class ChatRelayBackend implements SupervisorBackend {
  readonly id = "mcp" as const;
  readonly label: string;
  readonly conversationId: string;
  private introSent: boolean;
  private readonly chat: PerplexityChat;
  private readonly template: ReturnType<typeof loadRelayTemplate>;
  private readonly maxWorkerChars: number;

  constructor(private readonly opts: RelayBackendOptions) {
    const relay = resolveRelay(opts.settings, opts.cwd);
    this.conversationId = opts.conversationId;
    this.introSent = opts.introSent === true;
    this.template = loadRelayTemplate(opts.cwd, relay.introPath ?? undefined);
    this.maxWorkerChars = relay.maxWorkerChars;
    this.chat = new PerplexityChat(
      {
        baseUrl: relay.endpoint.baseUrl,
        apiKeyEnv: relay.apiKeyEnv || undefined,
        model: relay.model,
        timeoutMs: relay.timeoutMs,
        retries: relay.retries,
      },
      opts.conversationId,
      opts.fetchImpl,
      opts.budget ?? null
    );
    this.label = `pplx-proxy relay ${relay.endpoint.baseUrl.replace(/^\w+:\/\//, "")} · model ${relay.model}`;
  }

  get introDelivered(): boolean {
    return this.introSent;
  }

  get turns(): number {
    return this.chat.turnCount;
  }

  /** Ask the conversation for the next instruction. Rejects when cancelled or unreachable. */
  async review(request: SupervisorRequest, signal?: AbortSignal): Promise<BackendOutcome> {
    const opening = request.kind === "initial" && !this.introSent;

    // The worker's own words lead; the loop never hands the relay a JSON envelope.
    const workerText = (request.workerText ?? request.report ?? "").trim();
    const message = opening
      ? buildIntroPrompt(request.state.outcome, this.template.template)
      : buildWorkerResultMessage(workerText, {
          maxChars: this.maxWorkerChars,
          notes: relayNotes(workerText, request.workerFacts ?? {}),
        });

    const turn = await this.chat.send(message, signal);
    if (opening) {
      this.introSent = true;
      this.opts.onIntroSent?.();
    }

    // A turn that came back with nothing would otherwise be forwarded as an
    // empty instruction; that is a failure, and it pauses the run visibly.
    if (!turn.text.trim()) throw new SupervisorUnavailableError(EMPTY_REPLY, "malformed");

    // A reserved marker that does not terminate the reply is a protocol violation.
    // The reply is refused outright: it is never forwarded to the worker, and no
    // second request is made to "fix" the supervisor's formatting. The run pauses.
    const verdict = detectRelayMarkers(turn.text);
    if (verdict.action === "protocol-error") {
      throw new SupervisorUnavailableError(verdict.protocolError ?? "a control marker appeared where it cannot be a verdict", "protocol");
    }
    const decision =
      verdict.action === "done"
        ? {
            action: "done" as const,
            message: verdict.body,
            reasoning: verdict.body || "the supervisor signalled completion.",
            confidence: 1,
          }
        : verdict.action === "blocked"
          ? {
              action: "blocked" as const,
              blocker: verdict.body || "the supervisor gave no reason.",
              reasoning: verdict.body,
              confidence: 1,
            }
          : {
              action: "steer" as const,
              message: verdict.body,
              reasoning: `chat relay turn ${turn.turn}`,
              confidence: 1,
            };

    if (verdict.action === "continue" && !verdict.body.trim()) {
      throw new SupervisorUnavailableError(EMPTY_REPLY, "malformed");
    }

    return {
      decision,
      raw: turn.text,
      // Terminal by the model's own marker, so the loop does not ask a prose
      // reply for the evidence contract it was never given.
      terminal: verdict.action !== "continue",
      detail: turn.detail,
      conversation: { id: this.conversationId, turn: turn.turn, attached: turn.turn === 1 || turn.continued },
    };
  }

  async dispose(): Promise<void> {
    // Nothing to tear down: the conversation lives in the proxy, not here.
  }
}

export { newConversationId };
