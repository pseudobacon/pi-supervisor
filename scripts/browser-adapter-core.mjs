/**
 * The adapter's decision-making, separated from its plumbing.
 *
 * Everything in here is pure with respect to the browser: it decides *what may happen* and
 * returns data, and the caller in `perplexity-browser-adapter.mjs` is the only place that
 * touches a page. That split exists because the safety rules are the product:
 *
 *   - "read-only mode never submits" is worth nothing if it lives inside a script that
 *     connects to Chrome the moment it is imported and cannot be exercised by a test.
 *   - "a rejected submission touched no page" is only checkable if a fake page can count
 *     the calls that were not made.
 *   - The refusals in `validateConfig` were previously verified by a human reading terminal
 *     output. They are code now, so they can have regression tests.
 *
 * Nothing here imports playwright, reads argv, or opens a socket. It is imported by the test
 * suite directly.
 */
import { createHash } from "node:crypto";

/** Settings the adapter understands. A flag not listed here does not exist. */
export const DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 8731,
  cdp: 9333,
  url: "https://www.perplexity.ai/",
  pollMs: 500,
  stableReads: 3,
  // `/wait`'s own defaults, kept at their historical values so the live relay is unchanged.
  waitTimeoutMs: 240_000,
  waitStableMs: 8_000,
  // Read-only mode is where a ceiling matters: an operator watching a finished thread should
  // not have a poller running for four minutes. `maxReadMs: 0` means "no clamp", which is what
  // normal mode does today.
  readOnlyMaxReadMs: 30_000,
  readOnlyWaitTimeoutMs: 20_000,
  readOnlyWaitStableMs: 4_000,
});

/**
 * Read settings from `--name=value` or `--name value`.
 *
 * `env` exists so a test can prove no setting is read from an unexpected source; production
 * passes nothing, and nothing here reads `process.env`.
 */
export function parseConfig(argv = [], env = {}) {
  const find = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  const bool = (name) => argv.includes(`--${name}`);
  const num = (name, fallback) => {
    const raw = find(name) ?? env[`PI_ADAPTER_${name.toUpperCase()}`];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : Number.NaN;
  };

  const readOnly = bool("read-only");
  const cfg = {
    host: find("host") ?? DEFAULTS.host,
    port: num("port", DEFAULTS.port),
    cdp: num("cdp", DEFAULTS.cdp),
    url: find("url") ?? DEFAULTS.url,
    pollMs: num("poll", DEFAULTS.pollMs),
    stableReads: num("stable", DEFAULTS.stableReads),
    waitTimeoutMs: num("timeout", DEFAULTS.waitTimeoutMs),
    waitStableMs: num("stable-ms", DEFAULTS.waitStableMs),
    // Read-only: refuse to do anything that changes the page or the conversation.
    readOnly,
    maxReadMs: num("max-read-ms", readOnly ? DEFAULTS.readOnlyMaxReadMs : 0),
    readOnlyWaitTimeoutMs: num("ro-timeout", DEFAULTS.readOnlyWaitTimeoutMs),
    readOnlyWaitStableMs: num("ro-stable-ms", DEFAULTS.readOnlyWaitStableMs),
    // Extra hosts to accept, for a disposable local browser only. Never widens what may be
    // bound or driven remotely; see validateConfig.
    allowHost: find("allow-host") ?? null,
    logFile: find("log") ?? null,
  };
  return cfg;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Every hard refusal in one place, so "it would have refused" is a testable statement rather
 * than a claim about terminal output. Messages are kept deliberately close to what the adapter
 * has always printed — they are quoted in HANDOFF.md as measured behaviour.
 */
export function validateConfig(cfg) {
  const problems = [];
  if (!LOOPBACK.has(cfg.host)) {
    problems.push(`refusing to bind "${cfg.host}". This adapter types into a signed-in chat, so it serves loopback only. A remote caller would be able to send messages as you.`);
  }
  let targetHost = null;
  try {
    targetHost = new URL(cfg.url).hostname;
  } catch {
    problems.push(`--url "${cfg.url}" is not a URL.`);
  }
  if (targetHost && !(isPerplexityHost(targetHost) || (cfg.allowHost && cfg.allowHost === targetHost))) {
    problems.push(`refusing because --url host is "${targetHost}", not perplexity.ai${cfg.allowHost ? ` and not the explicit --allow-host "${cfg.allowHost}"` : ""}. This adapter drives one site and refuses to be pointed at another.`);
  }
  if (cfg.allowHost && !LOOPBACK.has(cfg.allowHost)) {
    problems.push(`--allow-host "${cfg.allowHost}" is refused: the local-fixture escape hatch is for loopback only, so it cannot be used to point this adapter at some other site.`);
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) problems.push(`--port "${cfg.port}" is not a port.`);
  if (!Number.isInteger(cfg.cdp) || cfg.cdp < 1 || cfg.cdp > 65535) problems.push(`--cdp "${cfg.cdp}" is not a port.`);
  if (cfg.pollMs < 50) problems.push(`--poll ${cfg.pollMs}ms is below the 50ms floor: the page is read by evaluating in it, and a tighter loop is just pressure on the operator's browser.`);
  if (cfg.stableReads < 1) problems.push(`--stable ${cfg.stableReads} is below the 1-read floor.`);
  if (cfg.readOnly && cfg.maxReadMs <= 0) {
    problems.push("read-only mode requires a positive --max-read-ms: an unbounded read poll is exactly what read-only mode exists to prevent.");
  }
  return problems;
}

export function isPerplexityHost(hostname) {
  return /(^|\.)perplexity\.ai$/.test(hostname);
}

/**
 * A fingerprint of what was actually read: the prose AND every block's label and content.
 *
 * Byte length alone was the original stability signal and it is not enough. Two different
 * answers can be the same length — "prints Hello, World!\n" vs "prints Hello, World!?" — and
 * the only thing that may be dispatched to the worker is a code block, whose content is what
 * matters, not its size. Blocks are included for that reason: a reply whose block content
 * churns while its total length holds is a reply that is still being written.
 *
 * This is an OBSERVED signal about what we read. It says nothing about whether the model has
 * finished; that inference belongs to `assessCapture`, and no hash here makes it stronger.
 */
export function fingerprint(answer) {
  const blocks = (answer?.blocks ?? []).map((b) => `${b.label}\u0000${b.content}`);
  const payload = JSON.stringify([answer?.answerText ?? "", blocks, answer?.generating === true]);
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Poll until the same answer is read repeatedly, or the clock runs out.
 *
 * Injected `read`, `now`, `sleep` — so a test can drive a whole conversation with a fake page
 * and a fake clock, including the case that motivated this rewrite: an answer whose text
 * changes while its length stays identical.
 *
 * `answerComplete: true` means only "both OBSERVED signals agreed": no generation control on
 * screen, and an unchanged fingerprint across the required consecutive reads. It is not proof
 * that generation ended. Callers must keep treating its absence or falsity as "not confirmed".
 */
export async function settleLoop(options) {
  const { read, now, sleep, signal, onRead } = options;
  const pollMs = Math.max(50, options.pollMs ?? 500);
  const stableReadsNeeded = Math.max(1, options.stableReads ?? 3);
  const stableMs = options.stableMs ?? 0;
  const neededFromTime = stableMs > 0 ? Math.ceil(stableMs / pollMs) : 0;
  const stableNeeded = Math.max(stableReadsNeeded, neededFromTime);
  const timeoutMs = options.timeoutMs ?? 240_000;

  const deadline = now() + Math.max(5_000, timeoutMs);
  let previous = null;
  let stableReads = 0;
  let waited = 0;
  let note = "";
  let s = await read();
  onRead?.(s);

  while (now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    const fp = fingerprint(s);
    const steady = previous !== null && fp === previous;
    if (!s.generating && steady) stableReads++;
    else stableReads = 0;
    if (s.generating && steady && note === "") {
      note = "content steady but the stop button is still on screen — still waiting";
    }
    if (!s.generating && stableReads >= stableNeeded && (s.answerText ?? "") !== "") {
      return { ...s, answerComplete: true, stableReads, stableNeeded, waitedMs: waited, fingerprint: fp, detail: note || `stable for ${stableReads} reads (${stableNeeded} needed)` };
    }
    previous = fp;
    await sleep(pollMs);
    waited += pollMs;
    s = await read();
    onRead?.(s);
  }
  return {
    ...s,
    answerComplete: false,
    stableReads,
    stableNeeded,
    waitedMs: waited,
    fingerprint: fingerprint(s),
    detail: `${note ? `${note}; ` : ""}waited ${waited}ms without both signals agreeing`,
  };
}

/** Endpoints that change the page or the conversation, and are therefore absent in read-only mode. */
export const MUTATING_ENDPOINTS = new Set(["/submit"]);

/**
 * Short, stable, non-reversible identity for a conversation id, for the audit log. The thread
 * id is a handle on one operator conversation; it has no business in a log file that outlives
 * the run. Eight hex characters is enough to tell one pin from another and useless on its own.
 */
export function pinRef(pin) {
  if (!pin) return null;
  const id = String(pin).match(/\/session\/([a-f0-9-]+)/i)?.[1] ?? String(pin).replace(/\/$/, "").split("/").pop();
  if (!id) return null;
  return createHash("sha256").update(String(id)).digest("hex").slice(0, 8);
}

/**
 * The request router. Returns `{ status, body }`; the caller serialises it.
 *
 * `ops` is the browser surface, and it is the point of this design: a test passes an `ops`
 * that counts how often anything touched a page, and then asserts the counter is still zero.
 * No page ever reaches the router itself.
 */
export function createApi({ config, ops, audit = () => {}, now = () => new Date().toISOString() }) {
  const counters = { submits: 0, submitRejected: 0, captures: 0, pins: 0 };
  // A timestamp on every line is part of the contract, so the router stamps it. `now` is
  // injected for the same reason the clock is injected into settleLoop: a module that grabs
  // `Date` directly cannot be tested for what it promises to write.
  const record = (entry) => audit({ t: now(), ...entry });

  const refuseReadOnly = (endpoint, why) => ({
    status: 405,
    body: { ok: false, error: `read-only mode: ${endpoint} is not available (${why})`, readOnly: true },
  });

  async function handle({ method, pathname, body = {}, signal = undefined }) {
    // ── read-only gating happens FIRST, and above every call that could touch a page ──────
    if (config.readOnly && MUTATING_ENDPOINTS.has(pathname)) {
      counters.submitRejected++;
      record({ m: method, e: pathname, outcome: "rejected-read-only", readOnly: true, interactions: 0 });
      return { ...refuseReadOnly(pathname, "this adapter was started with --read-only; no page is located, typed into, or clicked"), audited: true };
    }
    if (config.readOnly && method !== "GET" && pathname !== "/wait" && pathname !== "/pin" && pathname !== "/disconnect") {
      return { status: 404, body: { ok: false, error: `no endpoint ${pathname}`, readOnly: true } };
    }

    if (pathname === "/health") {
      const state = await ops.status();
      record({ m: method, e: pathname, outcome: "ok", attached: state.attached === true, tabs: state.perplexityTabs });
      return { status: 200, audited: true, body: { ok: true, readOnly: config.readOnly === true, counters: { ...counters }, ...state } };
    }

    if (pathname === "/pin") {
      if (method !== "POST") return { status: 405, body: { ok: false, error: "POST only" } };
      const pin = typeof body.url === "string" && body.url ? body.url : null;
      if (config.readOnly && !pin) {
        return { status: 400, body: { ok: false, error: "read-only mode requires an exact conversation pin (--url or body.url) before any capture", readOnly: true } };
      }
      const hostProblem = pinHostProblem(config, pin);
      if (hostProblem) return { status: 400, body: { ok: false, error: hostProblem } };
      // An explicit /pin always re-attaches and re-reads: the caller is telling us which
      // conversation to look at, and "already attached" is not a reason to skip verifying it.
      const found = await ops.pin(pin, { raise: !config.readOnly });
      counters.pins++;
      record({ m: method, e: pathname, outcome: "pinned", pin: pinRef(pin), tabs: found.threadNodes });
      return { status: 200, audited: true, body: { ok: true, url: found.url, threadNodes: found.threadNodes, composerReady: found.composerReady, detail: found.detail, readOnly: config.readOnly === true } };
    }

    if (pathname === "/wait") {
      if (method !== "POST") return { status: 405, body: { ok: false, error: "POST only" } };
      const pin = typeof body.pin === "string" && body.pin ? body.pin : null;
      if (config.readOnly && !pin) {
        return { status: 400, body: { ok: false, error: "read-only mode requires the exact conversation pin on /wait as well as on /pin, so a capture can never attach to whatever tab happens to be open", readOnly: true } };
      }
      const hostProblem = pinHostProblem(config, pin);
      if (hostProblem) return { status: 400, body: { ok: false, error: hostProblem } };

      // Bounds: read-only mode never polls past maxReadMs, and starts from its own shorter
      // defaults so a finished thread costs a few seconds rather than minutes.
      const requestedTimeout = Number(body.timeoutMs ?? (config.readOnly ? config.readOnlyWaitTimeoutMs : config.waitTimeoutMs));
      let timeoutMs = Number.isFinite(requestedTimeout) ? requestedTimeout : config.waitTimeoutMs;
      let clamped = false;
      if (config.maxReadMs > 0 && timeoutMs > config.maxReadMs) {
        timeoutMs = config.maxReadMs;
        clamped = true;
      }
      const requestedStable = Number(body.stableMs ?? (config.readOnly ? config.readOnlyWaitStableMs : config.waitStableMs));
      const stableMs = Number.isFinite(requestedStable) ? requestedStable : config.waitStableMs;

      // /wait attaches only if nothing is attached, or confirms the existing attachment is the
      // pinned conversation. Always locating would fail with "N_perplexity_tabs" the moment a
      // second tab is open, which is how the live relay works today.
      const found = await ops.ensureAttached(pin);
      const s = await ops.settle({ timeoutMs, stableMs, signal });
      counters.captures++;
      // Counts and signals only. The answer's TEXT never enters the log: it is the operator's
      // conversation, and a log file is not where it belongs.
      record({
        m: method, e: pathname, outcome: s.answerComplete ? "captured" : "incomplete",
        pin: pinRef(pin), stableReads: s.stableReads, stableNeeded: s.stableNeeded, waitedMs: s.waitedMs,
        answerComplete: s.answerComplete === true, generating: s.generating === true, status: s.status,
        chars: (s.answerText ?? "").length, blocks: (s.blocks ?? []).length, chromeSkipped: s.chromeSkipped ?? null, clamped,
      });
      return {
        status: 200,
        audited: true,
        body: {
          ok: true,
          answerComplete: s.answerComplete === true,
          answerText: s.answerText,
          blocks: s.blocks,
          status: s.status,
          generating: s.generating === true,
          distanceFromBottom: s.distanceFromBottom,
          stableReads: s.stableReads,
          stableNeeded: s.stableNeeded,
          // What the page chrome exclusion found, in counts. Its absence is itself information:
          // an adapter too old to report it says so by omitting the field rather than guessing 0.
          ...(s.chromeSkipped === undefined || s.chromeSkipped === null ? {} : { chromeSkipped: s.chromeSkipped }),
          fingerprint: s.fingerprint ?? null,
          turnId: String(s.threadNodes),
          detail: s.detail,
          bounds: { timeoutMs, stableMs, maxReadMs: config.maxReadMs, clamped },
          pinnedUrl: found.url,
        },
      };
    }

    if (pathname === "/submit") {
      if (method !== "POST") return { status: 405, body: { ok: false, error: "POST only" } };
      // Reaching here in read-only mode is impossible — the gate above returns first. This
      // assertion is the second line, not the first, and a test proves the first one fires.
      if (config.readOnly) return refuseReadOnly(pathname, "unreachable: rejected before this point");
      counters.submits++;
      // The page layer owns the mutation's status codes (400 bad text, 409 a busy page / a
      // composer we must not disturb / a refusal to press Enter, 504 an unconfirmed turn). The
      // router forwards them rather than flattening everything into 500.
      const result = await ops.submit(body);
      record({ m: method, e: pathname, outcome: result.body?.ok ? "posted" : "not-posted", status: result.status, chars: String(body?.text ?? "").length, detail: result.body?.detail ?? null });
      return { status: result.status, audited: true, body: result.body };
    }

    if (pathname === "/disconnect") {
      const result = await ops.teardown();
      record({ m: method, e: pathname, outcome: "disconnect", browserTouched: result.browserTouched === true });
      return { status: 200, audited: true, body: result };
    }

    record({ m: method, e: pathname, outcome: "not-found" });
    return { status: 404, audited: true, body: { ok: false, error: `no endpoint ${pathname}` } };
  }

  return { handle, counters };
}

/**
 * A pin's host must be one we are allowed to drive. Checked before locating so a malformed pin
 * cannot even cause a page to be enumerated.
 */
function pinHostProblem(config, pin) {
  if (!pin) return null; // "no pin" is handled by the caller's read-only rule or by adopt-logs
  let host = null;
  try {
    host = new URL(pin).hostname;
  } catch {
    return `pin "${pin}" is not a URL`;
  }
  const allowed = isPerplexityHost(host) || (config.allowHost && config.allowHost === host);
  return allowed ? null : `pin url host "${host}" is not perplexity.ai`;
}
