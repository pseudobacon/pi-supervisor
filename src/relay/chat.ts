/**
 * relay/chat — one persistent Perplexity conversation, one turn at a time.
 *
 * The conversation lives in pplx-proxy, not here. Every turn is
 * `POST {base}/v1/responses` with the same `conversation` id, which is the
 * proxy's own continuation mechanism: it resolves the id to the last stored
 * response, replays that response's history, and calls Perplexity with
 * `last_backend_uuid` so only the new message crosses the wire. The extension
 * therefore sends one message per turn and keeps no transcript of its own.
 *
 * Nothing here invents API surface: `conversation`, `store`, `previous_response_id`
 * and `output_text` are all the proxy's existing Responses API fields.
 */

import { SupervisorUnavailableError } from "../backends/types.js";
import { redactSecrets } from "../redact.js";

export interface RelayTransportSettings {
  /** Proxy origin, no trailing slash — e.g. http://127.0.0.1:8892 */
  baseUrl: string;
  /** Name of the environment variable holding the bearer token. Never the value. */
  apiKeyEnv?: string;
  /** Proxy model alias — "auto" lets the proxy pick its default. */
  model: string;
  timeoutMs: number;
  retries: number;
}

export interface ChatTurn {
  /** The assistant's reply, verbatim apart from redaction and bounding. */
  text: string;
  /** pplx-proxy's own quota notice, kept separate so nothing is silently dropped. */
  notice: string;
  /** True when this turn continued the conversation rather than starting one. */
  continued: boolean;
  /** True when a turn that should have continued started fresh (proxy-side expiry). */
  lostContext: boolean;
  /** Turn number within this conversation, 1-based. */
  turn: number;
  detail: string;
}

/** `fetch` is a parameter so tests never touch the network. */
/**
 * The quota notice pplx-proxy appends to every answer it relays
 * (`f"\n\n[Remaining Pro Search: {rp}]"`, server.py:201) and strips again itself when
 * rebuilding history (server.py:1208). Mirrors that shape; it is deliberately narrow, so
 * anything else that trails a marker stays visible and is judged by the marker grammar.
 */
export const PROXY_QUOTA_NOTICE = /\s*\[Remaining Pro Search: \d+\]\s*$/;

/**
 * Hard ceiling on the /v1/responses transport attempts a run may make.
 * `used`/`record` read and write the run's persisted state, so pausing and
 * resuming can never replenish the budget, and a failed or timed-out attempt
 * spends it exactly like a successful one.
 */
export interface RelayAttemptBudget {
  cap: number;
  used: () => number;
  record: () => void;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Conversation id for a run: stable, opaque, and never a proxy URL or secret. */
export function newConversationId(cwd: string, seed: number): string {
  const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "session";
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, "").slice(0, 24) || "session";
  return `pi-sup-${slug}-${Math.abs(Math.trunc(seed)).toString(36)}`;
}

export class PerplexityChat {
  private turns = 0;

  constructor(
    private readonly settings: RelayTransportSettings,
    readonly conversationId: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly budget: RelayAttemptBudget | null = null
  ) {}

  get turnCount(): number {
    return this.turns;
  }

  /**
   * Send the next message into the same conversation. Rejects with
   * `SupervisorUnavailableError` so the loop pauses with a visible reason rather
   * than continuing on a half-delivered turn.
   */
  async send(message: string, signal?: AbortSignal): Promise<ChatTurn> {
    const url = `${this.settings.baseUrl.replace(/\/+$/, "")}/v1/responses`;
    const body = JSON.stringify({
      model: this.settings.model || "auto",
      input: message,
      conversation: this.conversationId,
      store: true,
    });

    let lastError = "";
    for (let attempt = 0; attempt <= this.settings.retries; attempt++) {
      if (signal?.aborted) throw new SupervisorUnavailableError("The request was cancelled.", "transport");
      const outcome = await this.attempt(url, body, signal);
      if (outcome.kind === "ok") {
        this.turns++;
        const turn = this.turns;
        const continued = outcome.previousResponseId !== null && turn > 1;
        return {
          text: outcome.text,
          notice: outcome.notice,
          continued,
          lostContext: turn > 1 && outcome.previousResponseId === null,
          turn,
          detail: `conversation ${this.conversationId} · turn ${turn} · ${
            turn === 1 ? "opened" : continued ? "continued" : "started fresh (proxy context expired)"
          } · ${outcome.text.length} chars${outcome.notice ? ` · ${outcome.notice}` : ""}`,
        };
      }
      lastError = outcome.message;
      if (!outcome.retryable || attempt === this.settings.retries) {
        throw new SupervisorUnavailableError(outcome.message, outcome.errorKind);
      }
      await delay(Math.min(8000, 500 * 2 ** attempt), signal);
    }
    throw new SupervisorUnavailableError(lastError || "the proxy did not answer.", "transport");
  }

  private async attempt(
    url: string,
    body: string,
    signal?: AbortSignal
  ): Promise<
    | { kind: "ok"; text: string; notice: string; previousResponseId: string | null }
    | { kind: "error"; message: string; retryable: boolean; errorKind: "config" | "transport" }
  > {
    // The hard budget is checked and spent immediately before the send, so every
    // transport attempt — success, failure, timeout, or retry — counts, and a
    // resumed run resumes with whatever budget was left.
    if (this.budget) {
      const used = this.budget.used();
      if (used >= this.budget.cap) {
        return {
          kind: "error",
          message: `Relay request budget exhausted: ${used} of ${this.budget.cap} /v1/responses attempts already used for this run — no further attempt was sent.`,
          retryable: false,
          errorKind: "transport",
        };
      }
      this.budget.record();
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.settings.timeoutMs);
    const onAbort = () => timeout.abort();
    signal?.addEventListener("abort", onAbort);
    let status = 0;
    let raw = "";
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const token = this.settings.apiKeyEnv ? process.env[this.settings.apiKeyEnv] : undefined;
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await this.fetchImpl(url, { method: "POST", redirect: "error", headers, body, signal: timeout.signal });
      status = response.status;
      raw = await response.text();
    } catch (error) {
      if (signal?.aborted) {
        return { kind: "error", message: "The request was cancelled.", retryable: false, errorKind: "transport" };
      }
      const why = timeout.signal.aborted
        ? `timed out after ${Math.round(this.settings.timeoutMs / 1000)}s`
        : redactSecrets(error instanceof Error ? error.message : String(error));
      return { kind: "error", message: `Cannot reach pplx-proxy at ${url}: ${why}`, retryable: timeout.signal.aborted || true, errorKind: "transport" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (status === 401 || status === 403) {
      const env = this.settings.apiKeyEnv ?? "PPLX_PROXY_API_KEY";
      return {
        kind: "error",
        message: `pplx-proxy refused the request (HTTP ${status}). Set ${env} in the environment, or point the relay at an unauthenticated proxy.`,
        retryable: false,
        errorKind: "config",
      };
    }
    if (status === 404) {
      return {
        kind: "error",
        message: `pplx-proxy no longer knows conversation ${this.conversationId} (HTTP 404) — its responses expire. Start a new run with /supervise <goal>.`,
        retryable: false,
        errorKind: "transport",
      };
    }
    if (status >= 500) {
      return { kind: "error", message: `pplx-proxy returned HTTP ${status}.`, retryable: true, errorKind: "transport" };
    }
    if (status === 429) {
      return { kind: "error", message: "pplx-proxy rate-limited the request (HTTP 429).", retryable: true, errorKind: "transport" };
    }
    if (status >= 400) {
      const detail = redactSecrets(raw.slice(0, 300)).replace(/\s+/g, " ").trim();
      return {
        kind: "error",
        message: `pplx-proxy rejected the request (HTTP ${status})${detail ? `: ${detail}` : ""}`,
        retryable: false,
        errorKind: "config",
      };
    }

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { kind: "error", message: "pplx-proxy returned something that is not JSON.", retryable: true, errorKind: "transport" };
    }
    const text = extractResponseText(json);
    if (!text.trim()) {
      return {
        kind: "error",
        message: "pplx-proxy answered with no text — the turn was not delivered, so nothing was sent to the worker.",
        retryable: false,
        errorKind: "transport",
      };
    }
    // pplx-proxy appends its quota notice to the answer text itself — server.py:201
    // builds "\n\n[Remaining Pro Search: N]" and _response_suffix (server.py:427)
    // attaches it on every Responses reply — and the proxy strips that same notice
    // again when it rebuilds history (_REMAINING_NOTICE_RE, server.py:1208). It is
    // furniture, not content; it also lands after a terminal marker, where the marker
    // grammar cannot allow anything. So it comes off here, and travels along by name.
    const notice = PROXY_QUOTA_NOTICE.exec(text)?.[0]?.trim() ?? "";
    const answer = text.replace(PROXY_QUOTA_NOTICE, "").trim();
    const previous = json.previous_response_id;
    return {
      kind: "ok",
      text: redactSecrets(answer),
      notice: notice ? redactSecrets(notice) : "",
      previousResponseId: typeof previous === "string" && previous ? previous : null,
    };
  }
}

/**
 * The Responses API puts the answer in `output_text`; streamed and tool-using
 * replies also carry it inside `output[]`. Read both so a shape the proxy chose
 * today keeps working tomorrow.
 */
export function extractResponseText(json: Record<string, unknown>): string {
  const direct = json.output_text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const output = Array.isArray(json.output) ? json.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const record = block as Record<string, unknown>;
      const text = record.text ?? record.content;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });
}
