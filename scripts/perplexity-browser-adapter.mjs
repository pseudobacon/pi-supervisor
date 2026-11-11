#!/usr/bin/env node
/**
 * perplexity-browser-adapter — a tiny loopback HTTP server that stands where the
 * pplx-proxy stood, and does its job by driving the operator's own logged-in browser.
 *
 * Why this exists: the proxy's value was never the model, it was *continuity* — the
 * stateful continuation of a conversation the operator already had, with its search
 * grounding and citations intact. A browser is the only client that has all of that.
 * The browser is also the most authoritative source of "is this answer finished?": the
 * page says so in its own header.
 *
 * WHAT THIS IS NOT
 *   It is not part of the extension. The extension talks HTTP to 127.0.0.1 and imports
 *   nothing from here. `playwright-core` is a declared runtime dependency of this package
 *   (operator decision 2026-11-09, so a clean `npm ci` can start this adapter), but the
 *   isolation that matters is still enforced: nothing in src/ may import this file or
 *   playwright, because the extension must stay loadable without a browser dependency.
 *
 *   It is not a scraper of other people's pages. It refuses a URL that is not
 *   perplexity.ai, and it refuses to bind anywhere but loopback, so the only thing that
 *   can reach it is software running on this machine.
 *
 *   It never closes a tab. That is not a nicety: tabs in the profile the operator chose
 *   can hold unsaved drafts, and closing one destroys something this process cannot
 *   restore. On fatal error it exits and leaves the browser exactly as it found it.
 *
 * THE TERMS-OF-SERVICE LINE, stated plainly (perplexity.ai/hub/legal/terms-of-service,
 * section 5.2) bans automated or programmatic access to the *website*, and says the
 * same restrictions do not apply to the API. Driving a signed-in web session
 * programmatically is on the banned side of that line, however personally useful it is,
 * and a detection-side signal is a single rate-limit change away. Run this on your own
 * account with your eyes on it. The official-API route is the compliant one; this route
 * was chosen for conversation continuity, not in ignorance of what it costs.
 *
 * USAGE
 *   # 1. start (or already have) a Chrome with a CDP port. Two options:
 *   #    a) your real logged-in profile — exposes that profile locally; or
 *   #    b) a dedicated profile you sign into once (scripts/launch-chrome.sh)
 *   google-chrome --remote-debugging-port=9333
 *   # 2. start the adapter (dependency is declared; `npm ci` is enough)
 *   node scripts/perplexity-browser-adapter.mjs --cdp 9333 --port 8731 \
 *        --url https://www.perplexity.ai/session/<id>
 *
 *   READ-ONLY MODE — observe a conversation, and structurally cannot change it:
 *   node scripts/perplexity-browser-adapter.mjs --cdp 9333 --port 8731 --read-only \
 *        --url https://www.perplexity.ai/session/<id> --log /tmp/adapter-audit.jsonl
 *     /submit is refused before a page is located; no typing, clicking, navigation,
 *     refresh or bringToFront; an exact pin is required on /pin AND /wait; and reads are
 *     clamped to --max-read-ms (default 30s) instead of the normal 240s. Every request is
 *     appended to --log as one JSON line: method, endpoint, timestamp, outcome, and counts
 *     — never a message body, never answer text, never a raw conversation id.
 *     `GET /health` reports `counters.submits`, so "nothing was submitted" is readable
 *     rather than asserted.
 *   # 3. point the extension at it
 *   /supervise mcp transport browser
 *   /supervise mcp adapter-url http://127.0.0.1:8731
 *   /supervise mcp session-url https://www.perplexity.ai/session/<id>
 *
 * The HTTP contract is src/browser/protocol.ts on the other end — change one, change
 * the other. Responses are the *answer*, never a screenshot: the operator asked for
 * Perplexity's code blocks and text.
 */

import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
// The same function a test runs against a fixture DOM — see the module's comment.
import { probePage as PROBE } from "./browser-page-probe.mjs";
import process from "node:process";

import {
  createApi,
  isPerplexityHost,
  parseConfig,
  settleLoop,
  validateConfig,
} from "./browser-adapter-core.mjs";

const ARGV = process.argv.slice(2);
const CONFIG = parseConfig(ARGV);
const HOST = CONFIG.host;
const PORT = CONFIG.port;
const CDP = CONFIG.cdp;
const TARGET = CONFIG.url;
const SETTLE_POLL_MS = CONFIG.pollMs;
const STABLE_READS = CONFIG.stableReads;

const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);
const die = (m, code = 1) => {
  log(`FATAL: ${m}`);
  process.exit(code);
};

// ── audit log ───────────────────────────────────────────────────────────────────────
// One JSON line per request. Deliberately: method, endpoint, timestamp, outcome, counts.
// Never a body, never answer text, never a credential, never a raw conversation id — a log
// file outlives the run, and the conversation does not belong in it.
const audit = (entry) => {
  // Keep the router's own stamp when it made one; a caller from the server layer does not.
  const { t, ...rest } = entry;
  const line = JSON.stringify({ t: t ?? new Date().toISOString(), ...rest });
  if (CONFIG.logFile) {
    try {
      appendFileSync(CONFIG.logFile, `${line}\n`);
    } catch (error) {
      log(`audit write failed (${CONFIG.logFile}): ${error.message}`);
    }
  }
  log(`AUDIT ${line}`);
};

// ── refusals, before anything is loaded ─────────────────────────────────────────────
// In the core (browser-adapter-core.mjs) so they can have regression tests rather than a
// human reading terminal output and agreeing.
const problems = validateConfig(CONFIG);
if (problems.length) {
  for (const problem of problems) log(`FATAL: ${problem}`);
  process.exit(1);
}
if (CONFIG.readOnly) log("READ-ONLY: /submit is refused before any page is located; no bringToFront; reads clamped to " + CONFIG.maxReadMs + "ms");
if (CONFIG.logFile) log(`audit log: ${CONFIG.logFile}`);

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  die("playwright-core is not installed. It is declared as a runtime dependency: npm ci, or npm i playwright-core");
}

// ── the browser ─────────────────────────────────────────────────────────────────────
let browser;
try {
  // `noDefaults: true` is not a preference. Without it, connecting sends
  // `Browser.setDownloadBehavior { behavior: "allowAndName", downloadPath: <a local temp dir>,
  // eventsEnabled: true }` BROWSER-WIDE (playwright-core 1.65.0, lib/coreBundle.js:40400-40406,
  // reached from CRBrowserContext.initialize; the default is set at 53319-53320). That silently
  // changes how the operator's own Chrome handles downloads, for the whole lifetime of the
  // browser and not just this tab — a side effect on someone else's browser that has nothing to
  // do with reading a conversation. With the flag, connecting is a websocket plus reads.
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`, { noDefaults: true });
} catch (error) {
  die(`cannot reach Chrome on CDP port ${CDP}: ${error.message}\n  Start Chrome with --remote-debugging-port=${CDP}, then retry.`);
}
log(`connected to Chrome over CDP ${CDP} (browser version ${browser.version?.() ?? "?"})`);

/** The one tab we are allowed to touch. Never chosen by recency — always pinned. */
let page = null;

function allowedHost(host) {
  // `--allow-host` exists for one thing: attaching to a disposable loopback Chrome running a
  // local fixture page, so the safety work can be verified without touching a real
  // conversation. validateConfig refuses it unless it is a loopback name, so it cannot be used
  // to point this adapter at some other site.
  return isPerplexityHost(host) || (CONFIG.allowHost !== null && CONFIG.allowHost === host);
}

function driverPages() {
  const out = [];
  for (const context of browser.contexts()) for (const candidate of context.pages()) {
    let host = "";
    try {
      host = new URL(candidate.url()).hostname;
    } catch {
      continue;
    }
    if (allowedHost(host)) out.push(candidate);
  }
  return out;
}

/**
 * Attach to the one tab we may touch.
 *
 * `raise` is the focus question, and read-only mode answers it with false. `bringToFront` does
 * not navigate or edit anything, but it does take window focus away from whatever the operator
 * is doing — an observability run should not interrupt a person, so "read-only" has to mean
 * that too and not merely "no typing".
 */
async function locate(pin, { raise = true } = {}) {
  const pages = driverPages();
  if (pages.length === 0) throw new Error("no_perplexity_tab");
  if (pages.length > 1) throw new Error(`${pages.length}_perplexity_tabs: close all but the one you want to relay to, or pin one by URL`);
  const found = pages[0];
  // Pin strictly: an unknown id must fail visibly rather than attach to whatever is open.
  if (pin) {
    const want = pin.replace(/\/$/, "");
    const id = want.match(/\/session\/([a-f0-9-]+)/i)?.[1] ?? want.split("/").filter(Boolean).pop();
    if (!id || !found.url().includes(id)) throw new Error(`pin_unmatched: open tab is ${found.url()}, the pin wants ${id}`);
  } else if (/\/session\//.test(found.url())) {
    log(`      no pin supplied — adopting the open thread ${found.url()}`);
  }
  page = found;
  if (raise) await page.bringToFront().catch(() => {});
  return page;
}

/**
 * Keep the tab already attached unless we have nothing attached or the pin disagrees.
 * The old `/wait` skipped locating when a page existed; preserving that matters, because
 * always locating would fail with "N_perplexity_tabs" the moment a second tab is open.
 */
async function ensureLocated(pin, { raise = false } = {}) {
  if (page && !pin) return { url: page.url(), threadNodes: null, composerReady: null, detail: "already attached" };
  if (page && pin) {
    const id = String(pin).match(/\/session\/([a-f0-9-]+)/i)?.[1] ?? String(pin).replace(/\/$/, "").split("/").pop();
    if (id && page.url().includes(id)) return { url: page.url(), threadNodes: null, composerReady: null, detail: "already attached to the pinned conversation" };
    throw new Error(`pin_unmatched: attached tab is ${page.url()}, the pin wants ${id ?? pin}`);
  }
  const found = await locate(pin, { raise });
  const s = await read();
  return { url: found.url(), threadNodes: s.threadNodes, composerReady: s.composerEmpty, detail: CONFIG.readOnly ? "pinned by url, read-only (no bringToFront)" : "pinned by url" };
}

// ── page signals, all validated against the live DOM in Nov 2026 ────────────────────
// Do not "modernise" these selectors without re-validating them: two of them look wrong
// and are not. `div.prose[data-renderer="lm"]` matches the USER bubble too (the user's
// copy sits in a hashed-CSS-module wrapper), which is why assistant extraction goes
// through the answer partition instead. And the rendered answer has NO ``` fences, so
// splitting on backticks finds nothing — blocks come from the DOM.

const read = async () => page.evaluate(PROBE);

/** Word tokens, punctuation and case discarded: rendering cannot change the words. */
const tokens = (text) => (text ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Is `needle` present, in order, inside `haystack`, allowing extra tokens between?
 *
 * Equality and substring tests are both unusable here, and the reason is not flakiness — it
 * is that a user bubble is RENDERED. Measured 2026-11-09 against a real relay turn: the
 * worker's report arrived with `**Change**` rendered to `Change`, a ```diff fence to `diff`,
 * and a second fence to `text Hello, World!` — the language chip is *inserted* into the text.
 * So the DOM holds extra tokens we never sent and is missing punctuation we did send, and a
 * 600-token message can only be matched structurally. An in-order subsequence over word
 * tokens survives both directions of that edit; for a message this long an accidental match
 * is not a realistic risk.
 */
function containsInOrder(haystackTokens, needleTokens) {
  if (needleTokens.length === 0) return false;
  let i = 0;
  for (const token of haystackTokens) {
    if (token === needleTokens[i]) {
      i++;
      if (i === needleTokens.length) return true;
    }
  }
  return false;
}

/** The newest user turn, if it already holds `text`. The check that keeps a retry harmless. */
async function alreadyPosted(text) {
  const s = await read();
  const want = tokens(text);
  return s.entryTexts.some((t) => containsInOrder(tokens(t), want));
}

/**
 * Confirm the message became a turn. Three signals, none of which is "a bubble's innerText
 * equals my text" — that check reported a POSTED message as failed on 2026-11-09 while the
 * answer was already streaming, because the bubble is rendered (see containsInOrder):
 *   - the composer is normalized-empty (the send consumed it), AND
 *   - the turn count grew (we are looking at a new turn, not an echo), AND
 *   - the newest user turn holds our words, in order, allowing the renderer's insertions.
 * On failure the caller does nothing: Enter was pressed exactly once and stays that way.
 */
async function confirmTurn(text, beforeNodes, timeoutMs) {
  const want = tokens(text);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const s = await read();
    last = s;
    const held = s.entryTexts.some((t) => containsInOrder(tokens(t), want));
    if (s.composerEmpty && s.threadNodes > beforeNodes && held) {
      return { ok: true, detail: `confirmed: turns ${beforeNodes} -> ${s.threadNodes}, composer cleared, our words present in order` };
    }
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
  const seen = last ? `composerEmpty=${last.composerEmpty}, wordsPresent=${last.entryTexts.some((t) => containsInOrder(tokens(t), want))}, turns=${last.threadNodes}` : "no reads";
  return { ok: false, detail: `turn not confirmed after ${timeoutMs}ms (${seen}) — Enter was pressed once and will not be pressed again; the text may still be in the composer` };
}

// ── the settle loop ─────────────────────────────────────────────────────────────────
/**
 * Poll until what we read stops changing. Two OBSERVED signals, and they must agree: no
 * generation control on screen, AND an unchanged fingerprint of the actual answer text and
 * every code block (see settleLoop). Byte length is not the signal — two different answers
 * can share a length, and the only thing that may reach the worker is a code block, whose
 * content is what matters. If the signals disagree — content steady while a stop control is
 * still on screen — we keep waiting and say so, because a truncated answer relayed as
 * complete sends the worker off to do the wrong thing with total confidence.
 *
 * What `answerComplete: true` means is exactly that: both observed signals agreed. It is not
 * proof that generation ended, and nothing here should be read as making it so.
 */
// The real work lives in settleLoop (browser-adapter-core.mjs), where a test can drive it with
// a fake page and a fake clock. This wrapper only supplies the page and the wall clock.
async function settle(maxWaitMs, stableMs, signal) {
  return settleLoop({
    read,
    signal,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollMs: SETTLE_POLL_MS,
    stableReads: STABLE_READS,
    stableMs,
    timeoutMs: maxWaitMs,
  });
}



// ── the HTTP surface ────────────────────────────────────────────────────────────────
const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("body is not JSON");
  }
}

/** One mutation at a time: two concurrent submits would interleave into one garbled turn. */
let busy = false;

/**
 * The page side of the API. Everything the router can do to a browser goes through here, so
 * a test can hand the router an object that counts calls and assert that a rejected request
 * made none of them. In production these close over the real CDP page.
 */
const ops = {
  async status() {
    return {
      url: page?.url() ?? null,
      threadNodes: page ? (await read()).threadNodes : null,
      attached: !!page,
      perplexityTabs: page ? 1 : driverPages().length,
    };
  },
  /** An explicit pin: re-attach, re-read, report what is there. */
  async pin(pin, { raise = true } = {}) {
    const found = await locate(pin, { raise });
    const s = await read();
    return { url: found.url(), threadNodes: s.threadNodes, composerReady: s.composerEmpty, detail: CONFIG.readOnly ? "pinned by url, read-only (no bringToFront)" : "pinned by url" };
  },
  async ensureAttached(pin) {
    return ensureLocated(pin, { raise: false });
  },
  async settle({ timeoutMs, stableMs, signal }) {
    // The caller's abort signal, unchanged: when the extension gives up, this stops spending
    // reads against the operator's page. That was behaviour in the original handler and it is
    // still behaviour here — a client that walked away should not leave a poll running.
    return settle(timeoutMs, stableMs, signal);
  },
  /**
   * The mutation path. Its logic is the original, line for line, with one structural change:
   * it returns `{ status, body }` for the router instead of writing to the response itself.
   *
   * Two controls here are load-bearing and were nearly lost in that restructuring — recorded so
   * nobody "simplifies" them again:
   *   - refusing to post while the page is still generating, which would merge two turns;
   *   - reading the composer back and comparing EXACTLY before Enter. Enter is one keystroke
   *     from sending something the operator never approved into a live thread, and it cannot
   *     be taken back. If the text we typed is not the text we meant, nothing is pressed.
   */
  async submit(body) {
    if (busy) return { status: 409, body: { ok: false, error: "another mutation is in flight" } };
    const { text, pin } = body ?? {};
    if (typeof text !== "string" || !text.trim()) return { status: 400, body: { ok: false, error: "text must be a non-empty string" } };
    busy = true;
    try {
      if (!page) await locate(pin || null);
      if (pin) await locate(pin);
      // A browser has no request counter, so this is the whole brake: if the last
      // answer is still arriving, posting now would merge two turns into one message.
      const before = await read();
      // Measured 2026-11-09: a send can succeed while its confirmation fails, because the
      // bubble is rendered. If the intended text is already the newest user turn, the send
      // happened — so relay the answer instead of typing the same report a second time.
      if (await alreadyPosted(text)) {
        return { status: 200, body: { ok: true, postedText: text, url: before.url, detail: "already the newest user turn — not sending it twice" } };
      }
      if (before.generating) {
        return { status: 409, body: { ok: false, error: "the page is still generating — refusing to post on top of it" } };
      }
      if (!before.composerEmpty) {
        return { status: 409, body: { ok: false, error: `the composer already holds ${before.composerChars} chars — refusing to disturb it` } };
      }
      await page.locator('div[data-lexical-editor="true"][contenteditable="true"]').first().click();
      // Lexical normalises a typed keystroke into a paragraph break; one insertion does not.
      await page.keyboard.insertText(text);
      const want = text.replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
      // Read the composer back and compare EXACTLY. Pressing Enter on text we did not
      // intend is unrecoverable — it becomes a message in the operator's thread.
      const held = await page
        .evaluate(() => document.querySelector('div[data-lexical-editor="true"][contenteditable="true"]')?.innerText ?? "")
        .then((x) => x.replace(/\u200b/g, "").replace(/\s+/g, " ").trim());
      if (held !== want) {
        return { status: 409, body: { ok: false, error: `composer does not hold exactly the intended text — NOT pressing Enter (got ${held.length} chars, want ${want.length})` } };
      }
      const beforeNodes = before.threadNodes;
      await page.keyboard.press("Enter"); // exactly once, ever
      const confirm = await confirmTurn(text, beforeNodes, Math.max(20_000, SETTLE_POLL_MS * 40));
      if (!confirm.ok) return { status: 504, body: { ok: false, error: confirm.error ?? confirm.detail } };
      const after = await read();
      return { status: 200, body: { ok: true, postedText: text, url: after.url, detail: confirm.detail } };
    } finally {
      busy = false;
    }
  },

  /**
   * `/disconnect`. It calls nothing on the browser, by design.
   *
   * An earlier revision called `browser.close()` here, on a comment's word that that only
   * drops the CDP connection. The browser at the other end of this socket is the operator's
   * own — signed in, with tabs that can hold unsaved drafts — so a comment is not an
   * acceptable basis for an action on it. Tearing the adapter down is done the way a process
   * is known to be safe to tear down: stop listening, stop being connected, and exit. Chrome
   * keeps running when a client hangs up on it; that is the ordinary case of a browser
   * closing its DevTools front end, and it is verified against a disposable profile in
   * scripts/verify-adapter-disconnect.mjs rather than asserted here.
   */
  async teardown() {
    // Nothing here stops the listener or the connection while the response is still owed:
    // an earlier revision closed connections immediately, and the caller got "fetch failed"
    // instead of the answer — which is also how it fails open on the one question that matters
    // ("did the browser survive?"). Reply first, then leave.
    //
    // Exit without touching the browser: no browser.close(), no page.close(), no context call.
    setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        /* best effort */
      }
      server.close();
      process.exit(0);
    }, 250).unref();
    return { ok: true, closed: true, browserTouched: false, how: "adapter process exit; the externally owned browser is left running" };
  },
};

const api = createApi({ config: CONFIG, ops, audit });

const server = createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  // Reject any foreign Origin: a web page must not be able to aim this at itself and
  // drive your chat from a script tag. Loopback is not automatically safe.
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    audit({ m: req.method, e: url.pathname, outcome: "refused-origin", ms: Date.now() - started });
    return json(res, 403, { ok: false, error: `refused origin ${origin}` });
  }
  // Only the path is logged, never the query string: a session identity could ride there.
  // "The caller gave up — stop spending reads on the operator's page."
  //
  // This listens on the RESPONSE, not the request, and that is load-bearing rather than
  // stylistic: Node emits `close` on the request stream as soon as its body is consumed
  // normally, so a request-level listener aborts every `/wait` a few milliseconds in. (That is
  // exactly what the first version of this rewire did, and a real run caught it in 4ms.)
  // `writableEnded` distinguishes a hung-up client from a completed request.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  let result;
  try {
    result = await api.handle({ method: req.method, pathname: url.pathname, body: await readBody(req), signal: controller.signal });
  } catch (error) {
    const message = String(error?.message ?? error);
    // A lost page is a protocol-level fact, not a transport one: the extension must not
    // retry it into a different tab.
    const gone = /closed|crashed|destroyed|target page|no_perplexity_tab|_tabs|pin_unmatched/.test(message);
    result = { status: gone ? 404 : 500, body: { ok: false, error: message } };
    // The message goes to the operator's terminal, never into the audit file: a failure text
    // can carry the conversation's URL, and the log is the wrong place for that.
    log(`      ${req.method} ${url.pathname} failed (${result.status}): ${message}`);
  }
  // One line per request. The router audits its own decisions in detail; this line only covers
  // what the router never saw (a thrown handler, an unreadable body) so the trail has no gaps.
  if (!result.audited) {
    audit({ m: req.method, e: url.pathname, outcome: result.body?.ok === false ? `error:${result.status}` : "ok", status: result.status, ms: Date.now() - started });
  }
  return json(res, result.status, result.body);
});

server.on("error", (error) => die(`cannot listen on ${HOST}:${PORT}: ${error.message}`));
server.listen(PORT, HOST, async () => {
  log(`listening on http://${HOST}:${PORT} — target ${TARGET}`);
  log(`      adapter has NO request budget of its own: the extension spends one per attempt and persists the counter.`);
  try {
    // Read-only mode never raises the tab either: the operator's window keeps focus even at
    // attach time. `bringToFront` is a focus change, which read-only promised not to make.
    const found = await locate(null, { raise: !CONFIG.readOnly });
    const s = await read();
    log(`      attached to ${found.url()} (${s.threadNodes} turn nodes, composer ${s.composerEmpty ? "ready" : "already holding text"})`);
  } catch (error) {
    log(`      will attach on first /pin: ${error.message}`);
  }
});

// A tab is the operator's work. Closing one can destroy an unsaved draft, so no path
// here — including this one — ever closes a page; we unhook and let the process die.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig}: unhooking. Tabs are left open, exactly as they were.`);
    try {
      server.closeAllConnections?.();
    } catch {
      /* best effort */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_500).unref();
  });
}
