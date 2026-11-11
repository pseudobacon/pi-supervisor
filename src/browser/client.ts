/**
 * browser/client — the extension's side of the browser relay transport.
 *
 * Same job as relay/chat.ts, different pipe: instead of `POST {proxy}/v1/responses`,
 * one turn is
 *
 *   POST /submit   the worker's own text, verbatim, once
 *   POST /wait     poll the page until the answer stops changing
 *
 * `fetch` is a parameter for two independent reasons: the offline suite injects fakes
 * and binds real loopback ports, and the suite-wide default-deny guard intercepts
 * `fetch` — so this transport is covered by the same guard that protects the proxy
 * path. Nothing here can reach a browser: Playwright lives in the adapter process,
 * not in this one.
 *
 * **No retries, anywhere, on this transport.** A retry is indistinguishable from a
 * second submission to a chat that has no idempotency key, so a failed or timed-out
 * send is reported and the run pauses. The attempt budget is spent *before* the
 * submit for the same reason: the operator approved a number of Perplexity requests,
 * and a request that never answered has still been made.
 */

import { SupervisorUnavailableError } from "../backends/types.js";
import type { FetchLike, RelayAttemptBudget } from "../relay/chat.js";
import {
  ADAPTER_ROUTES,
  type AdapterAnswer,
  type AdapterPinResult,
  type AdapterSubmitResult,
  assertLoopbackOrigin,
  parseAdapterAnswer,
  parseAdapterJson,
  parseAdapterPin,
  parseAdapterSubmit,
} from "./protocol.js";

export interface BrowserTransportSettings {
  /** Loopback origin of the adapter process, e.g. http://127.0.0.1:8731 */
  baseUrl: string;
  /** Pin target: the exact conversation URL, or null for a brand-new (zero-turn) chat. */
  sessionUrl: string | null;
  /** Per-request transport timeout for /submit, /pin, /read. */
  timeoutMs: number;
  /** How long the answer must stop changing before it counts as completed. */
  stableMs: number;
  /** Ceiling on waiting for one answer; exceeding it pauses the run, it does not guess. */
  maxWaitMs: number;
}

export interface BrowserTurn {
  answer: AdapterAnswer;
  submit: AdapterSubmitResult;
  /** 1-based turn index within this run, for `/supervise status`. */
  turn: number;
  detail: string;
}

export class BrowserChat {
  private turns = 0;
  private readonly origin: string;
  private pinned: AdapterPinResult | null = null;

  constructor(
    private readonly settings: BrowserTransportSettings,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly budget: RelayAttemptBudget | null = null
  ) {
    this.origin = assertLoopbackOrigin(settings.baseUrl);
    if (settings.sessionUrl) {
      // The chat side of the relay is Perplexity itself, so a session URL may be any
      // https origin — but a *non*-Perplexity URL cannot be the chat, and pinning the
      // wrong tab would write the worker's output into someone else's page.
      if (!/^https:\/\/(www\.)?perplexity\.ai\//.test(settings.sessionUrl)) {
        throw new SupervisorUnavailableError(
          `the pinned conversation must be a perplexity.ai URL, not "${settings.sessionUrl}"`,
          "config"
        );
      }
    }
  }

  get turnCount(): number {
    return this.turns;
  }

  get pinnedTab(): AdapterPinResult | null {
    return this.pinned;
  }

  /** One request to the adapter. Never retried; aborts with the caller's signal. */
  private async call<T>(route: string, body: unknown, timeoutMs: number, signal: AbortSignal | undefined, parse: (v: Record<string, unknown>) => T): Promise<T> {
    const url = `${this.origin}${route}`;
    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
    const linked = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: linked,
        redirect: "manual",
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const why = error instanceof Error && error.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : (error as Error)?.message ?? String(error);
      throw new SupervisorUnavailableError(`cannot reach the browser adapter at ${url}: ${why}`, "transport");
    }
    if (response.status >= 300 && response.status < 400) {
      throw new SupervisorUnavailableError(`the browser adapter redirected from ${url}; redirects on this transport are refused`, "transport");
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new SupervisorUnavailableError(`the browser adapter answered ${route} with HTTP ${response.status}: ${text.slice(0, 160)}`, "transport");
    }
    return parse(parseAdapterJson(text));
  }

  /**
   * Attach to the tab this run talks to. A session URL pins by exact URL and refuses
   * if that tab is not open; with no session URL the adapter must be looking at a chat
   * with zero turns, which is the only honest way to target a brand-new thread.
   */
  async pin(signal?: AbortSignal): Promise<AdapterPinResult> {
    const pin = await this.call(ADAPTER_ROUTES.pin, { url: this.settings.sessionUrl ?? null }, this.settings.timeoutMs, signal, parseAdapterPin);
    this.pinned = pin;
    return pin;
  }

  /** Read the newest completed answer without sending anything. */
  async read(signal?: AbortSignal): Promise<AdapterAnswer> {
    return this.call(ADAPTER_ROUTES.read, {}, this.settings.timeoutMs, signal, parseAdapterAnswer);
  }

  /** The adapter's own account of the page — for `/supervise status`, never a decision. */
  async status(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.call(ADAPTER_ROUTES.status, {}, this.settings.timeoutMs, signal, (v) => v);
  }

  /**
   * One relay turn: send the worker's text as it wrote it, then wait for the page to
   * settle. Throws `SupervisorUnavailableError` on any failure so the loop pauses with
   * a reason instead of continuing on a half-delivered turn.
   */
  async send(message: string, signal?: AbortSignal): Promise<BrowserTurn> {
    if (this.budget) {
      if (this.budget.used() >= this.budget.cap) {
        throw new SupervisorUnavailableError(
          `this run's browser relay attempts are used up (${this.budget.used()} of ${this.budget.cap}). Nothing was sent.`,
          "transport"
        );
      }
      // Spent before the request: a submit that timed out was still a request to
      // Perplexity, and pause/resume must never hand the run a fresh allowance.
      this.budget.record();
    }

    const submit = await this.call(ADAPTER_ROUTES.submit, { text: message }, this.settings.timeoutMs, signal, parseAdapterSubmit);
    // /wait outlives a normal request: the answer may legitimately take minutes to
    // stream, and the adapter polls the page rather than the network while it does.
    const answer = await this.call(
      ADAPTER_ROUTES.wait,
      { stableMs: this.settings.stableMs, maxWaitMs: this.settings.maxWaitMs },
      // Leave the adapter room to report a timeout itself rather than be cut off.
      this.settings.maxWaitMs + this.settings.timeoutMs,
      signal,
      parseAdapterAnswer
    );

    this.turns += 1;
    return {
      answer,
      submit,
      turn: this.turns,
      detail: `browser relay ${this.origin} · ${submit.detail} · ${answer.stableReads} stable reads · status ${answer.status || "unknown"}`,
    };
  }

  /** Tell the adapter to stop waiting. The browser itself is never closed. */
  async disconnect(): Promise<void> {
    try {
      await this.call(ADAPTER_ROUTES.disconnect, {}, this.settings.timeoutMs, undefined, (v) => v);
    } catch {
      // Nothing actionable: the adapter is either gone or already idle, and closing a
      // browser we do not own is never the right recovery.
    }
  }
}
