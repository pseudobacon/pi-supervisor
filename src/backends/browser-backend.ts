/**
 * backends/browser-backend — the chat relay with the operator's browser as the pipe.
 *
 * Same loop, same seam, different transport. It is a separate class from
 * relay-backend.ts rather than a branch inside it for one reason: the proxy path is
 * covered by hundreds of assertions and shipped behaviour, and a `if (transport)` at
 * each decision point is how a refactor quietly changes one path while testing the
 * other. Here the two share the pure parts (instruction rule, budgets, redaction,
 * decision vocabulary) and share nothing else.
 *
 * The contract that differs from the proxy relay, and why:
 *
 * - **The first instruction is the operator's own words, and the chat is not asked for
 *   one.** `kind === "initial"` costs zero requests: the goal the operator pasted into
 *   `/supervise` *is* the worker's first prompt, forwarded verbatim. Asking Perplexity
 *   to restate it would invent the very thing the operator wrote.
 * - **The worker's final text goes out as it was written** — no `Local coding agent
 *   result:` header and no extension notes. That is the product, so the only brake is
 *   the size ceiling, which announces what it removed.
 * - **Completion is decided by two authorities, not one prose line.** The chat supplies
 *   the next instruction as the code block whose first line is the marker; when it
 *   supplies none *and* the worker has no open todos, the run is complete. Anything in
 *   between — no block but open todos, two marked blocks, a marked block with nothing
 *   in it — is a visible pause, because guessing is what sends a finished run back to
 *   work or stops a live one early.
 *
 * The backend id stays `mcp`. That value is what existing persisted sessions and
 * `.pi/supervisor-config.json` files already mean by "the chat relay", and roughly
 * twenty call sites compare against it; the label is what says which pipe is in use.
 */

import { BrowserChat, type BrowserTurn } from "../browser/client.js";
import { toReplyBlocks } from "../browser/protocol.js";
import type { McpSettings } from "../mcp/config.js";
import type { FetchLike, RelayAttemptBudget } from "../relay/chat.js";
import { resolveRelay } from "../relay/config.js";
import { assessCapture, buildBrowserResultMessage, decideConversationCompletion, extractMarkedInstruction } from "../relay/instruction.js";
import { EMPTY_REPLY, truncateMiddle } from "../relay/protocol.js";
import type { BackendOutcome, SupervisorBackend, SupervisorRequest } from "./types.js";
import { SupervisorUnavailableError } from "./types.js";

export interface BrowserBackendOptions {
  settings: McpSettings;
  cwd: string;
  fetchImpl?: FetchLike;
  /** Persisted per run: failures, timeouts and aborts all spend it. */
  budget?: RelayAttemptBudget;
  /** Test seam: the page-facing half, swapped for a fake. */
  transport?: Pick<BrowserChat, "send" | "read" | "pin" | "disconnect">;
}

/** What the page gave back for one turn, kept so status can show the truth. */
export interface BrowserTurnSummary {
  turn: number;
  status: string;
  stableReads: number;
  blocks: number;
  url: string;
}

export class BrowserRelayBackend implements SupervisorBackend {
  readonly id = "mcp" as const;
  readonly label: string;

  private readonly chat: Pick<BrowserChat, "send" | "read" | "pin" | "disconnect">;
  private readonly marker: string;
  private readonly maxWorkerChars: number;
  private last: BrowserTurnSummary | null = null;

  constructor(opts: BrowserBackendOptions) {
    const relay = resolveRelay(opts.settings, opts.cwd);
    this.marker = relay.marker;
    this.maxWorkerChars = relay.maxWorkerChars;
    this.chat =
      opts.transport ??
      new BrowserChat(
        {
          baseUrl: relay.adapterUrl,
          sessionUrl: relay.sessionUrl || null,
          timeoutMs: relay.timeoutMs,
          stableMs: relay.stableMs,
          maxWaitMs: relay.maxWaitMs,
        },
        opts.fetchImpl,
        opts.budget ?? null
      );
    this.label = `browser chat relay (${describeBrowser(relay.adapterUrl, relay.sessionUrl, this.marker)})`;
  }

  /** The last page turn, for `/supervise status`. Never a secret. */
  get lastTurn(): BrowserTurnSummary | null {
    return this.last;
  }

  get turns(): number {
    return this.last?.turn ?? 0;
  }

  /**
   * Ask for the next instruction. For `initial` that is the operator's own goal, and
   * nothing is sent to the chat at all.
   */
  async review(request: SupervisorRequest, signal?: AbortSignal): Promise<BackendOutcome> {
    if (request.kind === "initial") {
      const goal = request.state.outcome.trim();
      if (!goal) throw new SupervisorUnavailableError("the run started without a goal, so there is no first instruction to send", "config");
      // No `terminal`: this is the worker's first instruction, not a verdict.
      return {
        decision: {
          action: "steer",
          message: goal,
          reasoning: "the operator's own prompt, forwarded verbatim — the chat was not asked for a first instruction.",
          confidence: 1,
        },
        raw: goal,
        detail: "browser relay · first instruction is the operator's prompt · 0 requests",
        conversation: { id: "browser-tab", turn: 0, attached: true },
      };
    }

    // What goes back into the thread: the worker's own words, as is.
    const workerText = (request.workerText ?? "").trim();
    const built = buildBrowserResultMessage(workerText, { maxChars: this.maxWorkerChars, truncate: truncateMiddle });
    if (!built.text) throw new SupervisorUnavailableError(EMPTY_REPLY, "malformed");

    const turn = await this.chat.send(built.text, signal);
    this.last = summarise(turn);

    // Capture first, then content. An answer we cannot vouch for — none extracted, or one whose
    // end the adapter never confirmed — must never be read as "a complete reply that happens to
    // hold no instruction block". That single confusion is how a relay ends a live run early.
    const capture = assessCapture(turn.answer);
    const picked = extractMarkedInstruction(toReplyBlocks(turn.answer), this.marker);
    const verdict = decideConversationCompletion(picked, capture);

    if (verdict.action === "stalled" || verdict.action === "ambiguous" || verdict.action === "empty") {
      // Never forwarded to the worker, and never "fixed" by asking the chat again:
      // the reply's formatting is not the worker's problem to solve.
      throw new SupervisorUnavailableError(verdict.reason, "protocol");
    }

    if (verdict.action === "complete") {
      return {
        decision: {
          action: "done",
          // The reply IS the verdict under this convention, so show the operator the chat's own
          // closing words rather than a paraphrase of them.
          message: verdict.reply || "the chat ended the run with no closing text.",
          reasoning: "the reply holds no instruction block, and in this thread's convention no block means the work is complete.",

          confidence: 1,
        },
        raw: turn.answer.answerText,
        terminal: true,
        // Todo counts ride along as information on the outcome a operator will read back, the
        // one place they used to hold authority. They decide nothing — see todosNote.
        detail: turn.detail + todosNote(request.workerTodos),
        conversation: { id: this.last?.url ?? "browser-tab", turn: this.last?.turn ?? 0, attached: true },
      };
    }

    if (!verdict.text.trim()) throw new SupervisorUnavailableError(EMPTY_REPLY, "malformed");
    return {
      decision: {
        action: "steer",
        message: verdict.text,
        reasoning: `browser relay turn ${this.last?.turn ?? 0}: code block ${picked.kind === "instruction" ? picked.blockIndex + 1 : "?"}`,
        confidence: 1,
      },
      raw: turn.answer.answerText,
      detail: turn.detail,
      conversation: { id: this.last?.url ?? "browser-tab", turn: this.last?.turn ?? 0, attached: true },
    };
  }

  /** Read the page without sending. Used by status; never decides anything. */
  async peek(signal?: AbortSignal) {
    const answer = await this.chat.read(signal);
    const picked = extractMarkedInstruction(toReplyBlocks(answer), this.marker);
    return { answer, picked };
  }

  async dispose(): Promise<void> {
    // Disconnects the adapter's CDP client. The browser is the operator's and is never
    // closed by this extension.
    await this.chat.disconnect();
  }
}

function summarise(turn: BrowserTurn): BrowserTurnSummary {
  return {
    turn: turn.turn,
    status: turn.answer.status,
    stableReads: turn.answer.stableReads,
    blocks: turn.answer.blocks.length,
    url: turn.submit.url,
  };
}

/**
 * Todo counts are information, not authority. They ride along on the status line because an
 * operator watching a run wants to know what the worker thinks is still open; they never decide
 * anything here. A worker is not required to keep a todo list, and a host without a todo tool
 * must not be able to prevent a conversation from ending — which is what the previous gate did
 * on 2026-11-09, pausing a run whose chat had already declared the work finished.
 */
function todosNote(todos: { pending: number; inProgress: number } | null | undefined): string {
  if (!todos) return "";
  return ` \u00b7 worker todos: ${todos.inProgress} in progress, ${todos.pending} pending (informational)`;
}

function describeBrowser(adapterUrl: string, sessionUrl: string, marker: string): string {
  const target = sessionUrl ? sessionUrl.replace(/^https:\/\/(www\.)?perplexity\.ai/, "") : "the new chat";
  return `${adapterUrl.replace(/^\w+:\/\//, "")} → ${target} · marker "${marker}"`;
}
