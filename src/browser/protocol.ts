/**
 * browser/protocol — the loopback contract between this extension and the browser
 * adapter, and the only place that decides whether an adapter reply is trustworthy.
 *
 * The adapter is a separate process because the browser is not ours to own: it is the
 * operator's logged-in Chrome, attached over CDP. Nothing here imports Playwright or
 * launches a browser — that would drag a browser dependency into the extension and
 * make the offline suite depend on a page existing. The extension only ever speaks
 * this JSON contract to `http://127.0.0.1:<port>`.
 *
 * Why the shape is this narrow: the relay forwards the worker's raw final text out,
 * and the chat's raw reply back into the session transcript. A host that is not
 * loopback would therefore be told both halves of a private exchange, so
 * `assertLoopbackOrigin` is a trust boundary, not a convenience. Every field that
 * drives a decision (a submission outcome, a rendered answer, code blocks, a stable
 * read) is validated here rather than trusted, because a missing field must fail the
 * run visibly instead of being read as `undefined` by a caller that assumed text.
 */

import { SupervisorUnavailableError } from "../backends/types.js";
import type { ReplyBlock } from "../relay/instruction.js";

/** Endpoints the adapter serves. Kept as one object so a typo cannot invent a route. */
export const ADAPTER_ROUTES = {
  health: "/health",
  pin: "/pin",
  read: "/read",
  submit: "/submit",
  wait: "/wait",
  status: "/status",
  disconnect: "/disconnect",
} as const;

/**
 * Only loopback. The adapter carries the worker's own words out and Perplexity's
 * words back in, so an origin off this machine is refused before a request is built.
 * A literal loopback host is required: `127.0.0.0/8`, `localhost`, and `::1`. Names
 * that merely *resolve* to loopback (`localhost.localdomain`, `127.0.0.1.nip.io`,
 * `lvh.me`) are refused, because resolution is attacker-controlled while a literal is
 * not.
 */
export function assertLoopbackOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SupervisorUnavailableError(`browser adapter origin "${raw}" is not a URL`, "config");
  }
  if (url.protocol !== "http:") {
    throw new SupervisorUnavailableError(`browser adapter origin "${raw}" must be http:// (loopback, plain)`, "config");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) {
    throw new SupervisorUnavailableError(
      `browser adapter origin "${raw}" is not loopback. The adapter relays the worker's raw output and the chat's raw reply, ` +
        "so it must run on this machine (http://127.0.0.1:<port>).",
      "config"
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new SupervisorUnavailableError(`browser adapter origin "${raw}" must be an origin without a path (the adapter owns its routes)`, "config");
  }
  return `${url.protocol}//${url.host}`;
}

/** One code block as the adapter read it out of the page. */
export interface AdapterBlock {
  /** The `figcaption` label, lower-cased; `""` when the block had none. */
  label: string;
  /** The `code` element's text. Deliberately not the block's `innerText`, which also
   *  contains the label — measured as a 5-character difference on every block seen. */
  content: string;
}

export interface AdapterAnswer {
  /** The rendered answer's text, verbatim. */
  answerText: string;
  /** Its code blocks, already split into label and content by the adapter. */
  blocks: AdapterBlock[];
  /** The page's own run-status word, e.g. `Finished`. Kept for the operator's line. */
  status: string;
  /** Pixels from the bottom of the thread scroll container. */
  distanceFromBottom: number;
  /** True when the adapter saw a stop control during this reply — still generating. */
  generating: boolean;
  /**
   * The adapter's own confirmation that this reply is FINISHED — that both of its completion
   * signals agreed, not merely "it stopped changing while we watched". Optional in the type so
   * that an adapter which never says it is treated as unconfirmed (see assessCapture in
   * relay/instruction.ts): "we saw no change for 8 reads" and "the answer is complete" are
   * different claims, and only the second one may end a run.
   */
  answerComplete?: boolean;
  /** How many consecutive identical reads made this answer "completed". */
  stableReads: number;
  /** The answer's own identity for this turn (turn partition index), if the page gave one. */
  turnId: string | null;
}

export interface AdapterSubmitResult {
  ok: true;
  /** What the page now shows as the newest user turn, for post-submit verification. */
  postedText: string;
  /** The session URL after the send (a new chat settles to /session/<uuid> here). */
  url: string;
  detail: string;
}

export interface AdapterPinResult {
  ok: true;
  url: string;
  /** Turn partitions on the page. Zero means a new chat, which cannot be URL-pinned. */
  threadNodes: number;
  composerReady: boolean;
  detail: string;
}

const str = (v: unknown, field: string, kind: "protocol" | "config" = "protocol"): string => {
  if (typeof v !== "string") throw new SupervisorUnavailableError(`adapter field "${field}" is ${v === null ? "null" : typeof v}, expected string`, kind);
  return v;
};
const num = (v: unknown, field: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new SupervisorUnavailableError(`adapter field "${field}" is not a finite number`, "protocol");
  return v;
};
const bool = (v: unknown, field: string): boolean => {
  if (typeof v !== "boolean") throw new SupervisorUnavailableError(`adapter field "${field}" is not a boolean`, "protocol");
  return v;
};

/** Anything the adapter answers that is not JSON, or not an object, is a protocol error. */
export function parseAdapterJson(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SupervisorUnavailableError("the browser adapter replied with something that is not JSON", "protocol");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SupervisorUnavailableError("the browser adapter replied with a JSON value that is not an object", "protocol");
  }
  return value as Record<string, unknown>;
}

function parseBlocks(value: unknown): AdapterBlock[] {
  if (!Array.isArray(value)) throw new SupervisorUnavailableError('adapter field "blocks" is not an array', "protocol");
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw new SupervisorUnavailableError(`adapter block ${index + 1} is not an object`, "protocol");
    const record = entry as Record<string, unknown>;
    const label = str(record.label, `blocks[${index}].label`).trim().toLowerCase();
    const content = str(record.content, `blocks[${index}].content`);
    return { label, content };
  });
}

export function parseAdapterAnswer(value: Record<string, unknown>): AdapterAnswer {
  if (!bool(value.ok, "ok")) {
    const reason = typeof value.error === "string" && value.error ? value.error : "the adapter reported the read failed";
    throw new SupervisorUnavailableError(reason, "protocol");
  }
  return {
    answerText: str(value.answerText, "answerText"),
    blocks: parseBlocks(value.blocks),
    status: str(value.status, "status"),
    distanceFromBottom: num(value.distanceFromBottom, "distanceFromBottom"),
    generating: bool(value.generating, "generating"),
    // Absent stays absent — no default in either direction. The caller distinguishes "the
    // adapter never confirmed" from "the adapter says this is not finished".
    answerComplete: typeof value.answerComplete === "boolean" ? value.answerComplete : undefined,
    stableReads: num(value.stableReads, "stableReads"),
    turnId: value.turnId === null || value.turnId === undefined ? null : str(value.turnId, "turnId"),
  };
}

export function parseAdapterSubmit(value: Record<string, unknown>): AdapterSubmitResult {
  // An ambiguous submission is reported as ok:false by the adapter, and stays an
  // error here: the answer to "did my message land?" is never "send it again".
  if (!bool(value.ok, "ok")) {
    const reason = typeof value.error === "string" && value.error ? value.error : "the browser adapter could not confirm the submission";
    throw new SupervisorUnavailableError(`${reason} — the message was NOT retried, and nothing further was sent.`, "transport");
  }
  return {
    ok: true,
    postedText: str(value.postedText, "postedText"),
    url: str(value.url, "url"),
    detail: str(value.detail, "detail"),
  };
}

export function parseAdapterPin(value: Record<string, unknown>): AdapterPinResult {
  if (!bool(value.ok, "ok")) {
    const reason = typeof value.error === "string" && value.error ? value.error : "the browser adapter refused to pin that tab";
    throw new SupervisorUnavailableError(reason, "config");
  }
  return {
    ok: true,
    url: str(value.url, "url"),
    threadNodes: num(value.threadNodes, "threadNodes"),
    composerReady: bool(value.composerReady, "composerReady"),
    detail: str(value.detail, "detail"),
  };
}

/** Blocks in the shape relay/instruction.ts consumes. Labels are already lower-cased. */
export function toReplyBlocks(answer: AdapterAnswer): ReplyBlock[] {
  return answer.blocks.map((b) => ({ label: b.label, content: b.content }));
}
