/**
 * The adapter's safety rules, exercised without a browser.
 *
 * These are the assertions the read-only verification plan depends on, so they are checked here
 * rather than trusted from a terminal. The trick is that `createApi` never touches a page: it
 * talks to an injected `ops`, and the fake below counts every call. "A rejected submission made
 * no page call" is then a number, not a promise.
 *
 * No network. No browser. The network guard stays armed and nothing here needs it disarmed.
 */
import { beforeEach, describe, expect, it } from "vitest";

interface CoreModule {
  parseConfig(argv: string[], env?: Record<string, string | undefined>): Record<string, unknown>;
  validateConfig(cfg: Record<string, unknown>): string[];
  fingerprint(answer: unknown): string;
  settleLoop(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  createApi(options: Record<string, unknown>): { handle: (a: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>; counters: Record<string, number> };
  pinRef(pin: string | null): string | null;
}

async function core(): Promise<CoreModule> {
  return (await import("../scripts/browser-adapter-core.mjs")) as unknown as CoreModule;
}

interface Recorded {
  call: string;
  args: unknown[];
}

/** A page that records everything anyone asks of it. The whole point is `calls`. */
function fakeOps(overrides: Record<string, unknown> = {}) {
  const calls: Recorded[] = [];
  const record = (call: string) => (...args: unknown[]) => {
    calls.push({ call, args });
  };
  const ops: Record<string, unknown> = {
    calls,
    status: async () => {
      record("status")();
      return { url: "https://www.perplexity.ai/session/abcdef", threadNodes: 3, attached: false, perplexityTabs: 1 };
    },
    pin: async (pin: string | null, options?: { raise?: boolean }) => {
      record("pin")(pin, options);
      return { url: "https://www.perplexity.ai/session/abcdef", threadNodes: 3, composerReady: true, detail: "pinned by url" };
    },
    ensureAttached: async (pin: string | null) => {
      record("ensureAttached")(pin);
      return { url: "https://www.perplexity.ai/session/abcdef", threadNodes: 3, composerReady: true, detail: "already attached" };
    },
    settle: async (input: Record<string, unknown>) => {
      record("settle")(input);
      return {
        answerText: "The task is complete. Nothing remains open.",
        blocks: [],
        chromeSkipped: 7,
        status: "Idle",
        generating: false,
        distanceFromBottom: 237,
        stableReads: 8,
        stableNeeded: 8,
        answerComplete: true,
        threadNodes: 4,
        fingerprint: "deadbeef",
        detail: "stable for 8 reads (8 needed)",
      };
    },
    submit: async (body: unknown) => {
      record("submit")(body);
      return { status: 200, body: { ok: true, postedText: (body as { text?: string }).text, detail: "confirmed" } };
    },
    teardown: async () => {
      record("teardown")();
      return { ok: true, closed: true, browserTouched: false, how: "adapter process exit" };
    },
  };
  for (const [key, value] of Object.entries(overrides)) ops[key] = value;
  return ops;
}

const CONFIG: Record<string, unknown> = {
  readOnly: true,
  maxReadMs: 30_000,
  readOnlyWaitTimeoutMs: 20_000,
  readOnlyWaitStableMs: 4_000,
  waitTimeoutMs: 240_000,
  waitStableMs: 8_000,
  pollMs: 500,
  stableReads: 3,
  allowHost: null,
};
const PIN = "https://www.perplexity.ai/session/abcdef";

let audit: Record<string, unknown>[] = [];
const collect = (entry: Record<string, unknown>) => audit.push(entry);

beforeEach(() => {
  audit = [];
});

describe("settings", () => {
  it("names every flag the adapter understands — an unlisted flag does not exist", async () => {
    const { parseConfig } = await core();
    const cfg = parseConfig(["--cdp=9333", "--port", "8731", "--url", PIN, "--read-only", "--max-read-ms=15000", "--ro-timeout", "9000", "--ro-stable-ms", "2000", "--poll=250", "--stable=5", "--allow-host=127.0.0.1", "--log=/tmp/a.jsonl", "--timeout=60000", "--stable-ms=3000"]);
    expect(cfg).toMatchObject({
      cdp: 9333, port: 8731, url: PIN, readOnly: true, maxReadMs: 15000, readOnlyWaitTimeoutMs: 9000,
      readOnlyWaitStableMs: 2000, pollMs: 250, stableReads: 5, allowHost: "127.0.0.1", logFile: "/tmp/a.jsonl", waitTimeoutMs: 60000, waitStableMs: 3000,
    });
  });

  it("defaults differ between normal and read-only mode, and only as documented", async () => {
    const { parseConfig } = await core();
    expect(parseConfig([])).toMatchObject({ readOnly: false, maxReadMs: 0, waitTimeoutMs: 240_000, waitStableMs: 8_000 });
    expect(parseConfig(["--read-only"])).toMatchObject({ readOnly: true, maxReadMs: 30_000, readOnlyWaitTimeoutMs: 20_000, readOnlyWaitStableMs: 4_000 });
  });

  it("refuses every configuration it has always refused, from code rather than terminal output", async () => {
    const { parseConfig, validateConfig } = await core();
    const problemsFor = (argv: string[]) => validateConfig(parseConfig(argv));
    expect(problemsFor(["--host=0.0.0.0"])[0]).toMatch(/refusing to bind "0\.0\.0\.0"/);
    expect(problemsFor(["--url=https://example.com"])[0]).toMatch(/not perplexity\.ai/);
    expect(problemsFor(["--url=not a url at all"])[0]).toMatch(/is not a URL/);
    expect(problemsFor(["--port=99999"])[0]).toMatch(/is not a port/);
    expect(problemsFor(["--cdp=0"])[0]).toMatch(/is not a port/);
    expect(problemsFor(["--poll=1"])[0]).toMatch(/below the 50ms floor/);
    expect(problemsFor(["--read-only", "--max-read-ms=0"])[0]).toMatch(/read-only mode requires a positive --max-read-ms/);
    expect(problemsFor(["--allow-host=evil.example"])[0]).toMatch(/loopback only/);
    expect(problemsFor([])).toEqual([]);
    expect(problemsFor(["--read-only", "--allow-host=127.0.0.1"])).toEqual([]);
  });
});

describe("read-only mode: the gate is above every page call", () => {
  it("rejects /submit before locating or interacting with a page — zero page calls", async () => {
    const { createApi } = await core();
    const ops = fakeOps();
    const api = createApi({ config: CONFIG, ops, audit: collect });
    const result = await api.handle({ method: "POST", pathname: "/submit", body: { text: "do the thing" } });

    expect(result.status).toBe(405);
    expect(result.body.error).toMatch(/read-only mode: \/submit is not available/);
    // The proof: not one of them happened. `submit` is the mutation, `pin`/`ensureAttached` are
    // page location, `settle` is polling the page. All of them are absent.
    expect((ops.calls as Recorded[]).length).toBe(0);
    expect(api.counters).toMatchObject({ submits: 0, submitRejected: 1 });
  });

  it("still refuses /submit when the caller supplies a pin and a well-formed body", async () => {
    const { createApi } = await core();
    const ops = fakeOps();
    const api = createApi({ config: CONFIG, ops, audit: collect });
    const result = await api.handle({ method: "POST", pathname: "/submit", body: { text: "x", pin: PIN } });
    expect(result.status).toBe(405);
    expect(ops.calls).toEqual([]);
  });

  it("requires an exact pin before any capture, on /pin and on /wait", async () => {
    const { createApi } = await core();
    const ops = fakeOps();
    const api = createApi({ config: CONFIG, ops, audit: collect });
    const pin = await api.handle({ method: "POST", pathname: "/pin", body: {} });
    const wait = await api.handle({ method: "POST", pathname: "/wait", body: {} });
    expect(pin.status).toBe(400);
    expect(pin.body.error).toMatch(/requires an exact conversation pin/);
    expect(wait.status).toBe(400);
    expect(wait.body.error).toMatch(/requires the exact conversation pin on \/wait/);
    // Refused without a pin means refused without looking at a tab.
    expect(ops.calls).toEqual([]);
  });

  it("never asks to raise the tab — no bringToFront in read-only mode", async () => {
    const { createApi } = await core();
    const ops = fakeOps();
    const api = createApi({ config: CONFIG, ops, audit: collect });
    await api.handle({ method: "POST", pathname: "/pin", body: { url: PIN } });
    await api.handle({ method: "POST", pathname: "/wait", body: { pin: PIN } });
    const pinCall = (ops.calls as Recorded[]).find((c) => c.call === "pin");
    expect(pinCall?.args[1]).toEqual({ raise: false });
    expect(api.counters.pins).toBe(1);
  });

  it("does ask to raise it outside read-only mode, so normal operation is unchanged", async () => {
    const { createApi } = await core();
    const ops = fakeOps();
    const api = createApi({ config: { ...CONFIG, readOnly: false }, ops, audit: collect });
    await api.handle({ method: "POST", pathname: "/pin", body: { url: PIN } });
    const pinCall = (ops.calls as Recorded[]).find((c) => c.call === "pin");
    expect(pinCall?.args[1]).toEqual({ raise: true });
  });

  it("refuses a pin aimed at some other site before touching a page", async () => {
    const { createApi } = await core();
    const ops = fakeOps();
    const api = createApi({ config: CONFIG, ops, audit: collect });
    const result = await api.handle({ method: "POST", pathname: "/wait", body: { pin: "https://evil.example/session/x" } });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/is not perplexity\.ai/);
    expect(ops.calls).toEqual([]);
  });

  it("clamps read timeouts to the ceiling, and reports that it did", async () => {
    const { createApi } = await core();
    const ops = fakeOps();
    const api = createApi({ config: CONFIG, ops, audit: collect });
    const result = await api.handle({ method: "POST", pathname: "/wait", body: { pin: PIN, timeoutMs: 600_000 } });
    expect(result.status).toBe(200);
    expect(result.body.bounds).toMatchObject({ timeoutMs: 30_000, maxReadMs: 30_000, clamped: true });
    const settleCall = (ops.calls as Recorded[]).find((c) => c.call === "settle");
    expect(settleCall?.args[0]).toMatchObject({ timeoutMs: 30_000, stableMs: 4_000 });
  });

  it("leaves normal mode at its historical 240s/8s defaults", async () => {
    const { createApi } = await core();
    const ops = fakeOps();
    const api = createApi({ config: { ...CONFIG, readOnly: false, maxReadMs: 0 }, ops, audit: collect });
    const result = await api.handle({ method: "POST", pathname: "/wait", body: {} });
    expect(result.body.bounds).toMatchObject({ timeoutMs: 240_000, stableMs: 8_000, clamped: false });
  });

  it("refuses unknown endpoints without touching a page", async () => {
    const { createApi } = await core();
    const ops = fakeOps();
    const api = createApi({ config: CONFIG, ops, audit: collect });
    expect((await api.handle({ method: "POST", pathname: "/refresh", body: {} })).status).toBe(404);
    expect(ops.calls).toEqual([]);
  });
});

describe("auditable capture", () => {
  it("reports chromeSkipped so excluded page chrome is visible rather than assumed", async () => {
    const { createApi } = await core();
    const api = createApi({ config: CONFIG, ops: fakeOps(), audit: collect });
    const result = await api.handle({ method: "POST", pathname: "/wait", body: { pin: PIN } });
    expect(result.body.chromeSkipped).toBe(7);
  });

  it("omits the field rather than inventing zero when an older adapter says nothing", async () => {
    const { createApi } = await core();
    const ops = fakeOps({
      settle: async () => ({ answerText: "x", blocks: [], status: "Idle", generating: false, distanceFromBottom: 0, stableReads: 8, stableNeeded: 8, answerComplete: true, threadNodes: 1, detail: "d" }),
    });
    const api = createApi({ config: CONFIG, ops, audit: collect });
    const result = await api.handle({ method: "POST", pathname: "/wait", body: { pin: PIN } });
    expect("chromeSkipped" in result.body).toBe(false);
  });

  it("logs method, endpoint, timestamp and outcome — and no chat content", async () => {
    const { createApi } = await core();
    const api = createApi({ config: CONFIG, ops: fakeOps(), audit: collect });
    await api.handle({ method: "POST", pathname: "/wait", body: { pin: PIN } });
    const line = audit.find((e) => e.e === "/wait");
    expect(line).toMatchObject({ e: "/wait", outcome: "captured", blocks: 0, chromeSkipped: 7 });
    expect(typeof line?.t).toBe("string");
    // The answer existed on the way through. It must not survive into the log.
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("Nothing remains open");
    expect(serialized).not.toContain("answerText");
    expect(serialized).not.toContain("abcdef"); // the conversation id, hashed instead
  });

  it("records a rejected submission as a rejection, so the audit trail is the evidence", async () => {
    const { createApi } = await core();
    const api = createApi({ config: CONFIG, ops: fakeOps(), audit: collect });
    await api.handle({ method: "POST", pathname: "/submit", body: { text: "secret worker report" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ e: "/submit", outcome: "rejected-read-only", interactions: 0 });
    expect(JSON.stringify(audit)).not.toContain("secret worker report");
  });

  it("hashes the conversation id rather than logging it", async () => {
    const { pinRef } = await core();
    expect(pinRef(PIN)).toMatch(/^[0-9a-f]{8}$/);
    expect(pinRef(PIN)).not.toContain("abcdef");
    expect(pinRef(null)).toBeNull();
    expect(pinRef(PIN)).toBe(pinRef(PIN)); // stable, so two runs can be compared
  });

  it("exposes submission counters so 'no submission endpoint was invoked' is checkable", async () => {
    const { createApi } = await core();
    const api = createApi({ config: CONFIG, ops: fakeOps(), audit: collect });
    await api.handle({ method: "GET", pathname: "/health" });
    expect(api.counters).toMatchObject({ submits: 0, submitRejected: 0, captures: 0, pins: 0 });
    await api.handle({ method: "POST", pathname: "/submit", body: { text: "x" } });
    const health = await api.handle({ method: "GET", pathname: "/health" });
    expect(health.body.counters).toMatchObject({ submits: 0, submitRejected: 1 });
    expect(health.body.readOnly).toBe(true);
  });
});

describe("teardown leaves the externally owned browser alone", () => {
  it("/disconnect reports browserTouched:false and asks for nothing on the browser", async () => {
    const { createApi } = await core();
    const ops = fakeOps();
    const api = createApi({ config: CONFIG, ops, audit: collect });
    const result = await api.handle({ method: "POST", pathname: "/disconnect" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, browserTouched: false });
    expect((ops.calls as Recorded[]).map((c) => c.call)).toEqual(["teardown"]);
  });
});

describe("stability is measured on content, not length", () => {
  const base = { blocks: [], generating: false, status: "Idle", threadNodes: 2, chromeSkipped: 0, distanceFromBottom: 0 };

  /**
   * Feed `answers` to the loop in order, cycling, on a clock that advances one poll per sleep.
   * A frozen clock would make a never-confirming answer an infinite loop — this one always ends,
   * which is what makes "it did not confirm" a result rather than a hang.
   */
  async function runWith(answers: Record<string, unknown>[], options: Record<string, unknown> = {}) {
    const { settleLoop } = await core();
    const pollMs = (options.pollMs as number) ?? 500;
    const timeoutMs = (options.timeoutMs as number) ?? 5_000;
    let i = 0;
    let clock = 0;
    const result = await settleLoop({
      // `i` advances per read: without it every read is the same answer and the loop would
      // confirm stability that was never supplied.
      read: async () => ({ ...base, ...answers[i++ % answers.length] } as Record<string, unknown>),
      now: () => clock,
      sleep: async () => {
        clock += pollMs;
      },
      pollMs,
      stableReads: 3,
      stableMs: 0,
      timeoutMs,
      ...options,
    });
    return { result, reads: i };
  }

  it("does NOT confirm when the text changed but its length did not", async () => {
    // The exact case a byte-length check cannot see: same length, different answer, and the
    // block content — the only thing that may be dispatched — has changed underneath it.
    const first = { answerText: "Hello, World!", blocks: [{ label: "text", content: "console.log(1)" }] };
    const second = { answerText: "Hello, World?", blocks: [{ label: "text", content: "console.log(2)" }] };
    expect(first.answerText.length).toBe(second.answerText.length);

    const { fingerprint } = await core();
    expect(fingerprint(first)).not.toBe(fingerprint(second));

    const { result } = await runWith([first, second]);
    expect(result.answerComplete).toBe(false);
    expect(result.detail).toMatch(/without both signals agreeing/);
  });

  it("confirms once the same content repeats, and reports how many reads it needed", async () => {
    const { result } = await runWith([{ answerText: "All done.", blocks: [] }]);
    expect(result.answerComplete).toBe(true);
    expect(result.stableReads).toBeGreaterThanOrEqual(3);
    expect(result.detail).toMatch(/stable for \d+ reads/);
  });

  it("counts a block-content change as instability even when prose and length are unchanged", async () => {
    const prose = "Here is the patch:";
    const a = { answerText: prose, blocks: [{ label: "diff", content: "+one" }] };
    const b = { answerText: prose, blocks: [{ label: "diff", content: "-one" }] };
    expect(JSON.stringify(a).length).toBe(JSON.stringify(b).length);
    const { result } = await runWith([a, b]);
    expect(result.answerComplete).toBe(false);
  });

  it("never confirms while a generation control is on screen, however steady the text looks", async () => {
    // Silence is not completion. Text holding still while a stop button is present is exactly
    // the truncated-answer trap, and the loop says so in its own detail.
    const steady = { answerText: "Writing…", blocks: [], generating: true };
    const { result } = await runWith([steady]);
    expect(result.answerComplete).toBe(false);
    expect(result.detail).toMatch(/stop button is still on screen/);
  });

  it("does not mistake an empty answer for a stable one", async () => {
    const { result } = await runWith([{ answerText: "", blocks: [] }]);
    expect(result.answerComplete).toBe(false);
  });

  it("stops polling when the caller aborts", async () => {
    const { settleLoop } = await core();
    let reads = 0;
    let clock = 0;
    await expect(
      settleLoop({
        read: async () => {
          reads++;
          return { ...base, answerText: "still here", generating: true };
        },
        now: () => clock,
        sleep: async () => {
          clock += 500;
        },
        signal: { aborted: true },
        pollMs: 500,
        stableReads: 3,
        timeoutMs: 5_000,
      })
    ).rejects.toThrow(/aborted/);
    expect(reads).toBe(1);
  });
});
