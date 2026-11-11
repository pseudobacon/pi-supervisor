/**
 * End-to-end test of the Perplexity chat relay.
 *
 * A fake pplx-proxy listens on an ephemeral localhost port inside this test
 * process and answers `POST /v1/responses` the way the real proxy does: it keeps
 * a server-side history per `conversation` id, sets `previous_response_id` when a
 * turn continues, and returns the answer in `output_text`. The loaded extension
 * talks to it over real HTTP with real fetch — no model key, no network.
 *
 * What these tests pin down is the user-visible contract: one conversation, the
 * supervisor's prose arriving at the worker unchanged, the worker's own answer
 * arriving back in the same conversation, and the run ending on a marker and
 * nothing else.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import registerExtension from "../src/index.js";
import { resolveMcpSettings } from "../src/mcp/config.js";
import { resolveRelay } from "../src/relay/config.js";
import { GOAL_AS_SUBMITTED, REPLY_1, REPLY_2 } from "./fixtures/relay-transcript.js";
import { createMockCtx, createMockPi, type MockCtx, type MockPi } from "./harness.js";
import { allowOrigin } from "./helpers/network-guard.js";

interface ProxyTurn {
  input: string;
  conversation: string;
  model: string;
  store: boolean;
  authorization?: string;
}

interface QueuedReply {
  text?: string;
  status?: number;
  body?: string;
}

interface FakeProxy {
  url: string;
  turns: ProxyTurn[];
  /** Messages the proxy holds per conversation — continuation happens here. */
  history: (conversation: string) => string[];
  queue: (replies: Array<QueuedReply | string>) => void;
  delay: (ms: number) => void;
  /** Bearer tokens the proxy saw, so tests can prove none were sent. */
  authHeaders: string[];
  /** Forget every turn: tests share one server, so isolation is explicit. */
  reset: () => void;
  close: () => Promise<void>;
}

async function startProxy(): Promise<FakeProxy> {
  const turns: ProxyTurn[] = [];
  const histories = new Map<string, string[]>();
  let queued: QueuedReply[] = [];
  let delayMs = 0;
  let counter = 0;
  const authHeaders: string[] = [];

  const httpServer: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      const conversation = String(body.conversation ?? "");
      const input = String(body.input ?? "");
      turns.push({
        input,
        conversation,
        model: String(body.model ?? ""),
        store: body.store === true,
        authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      });
      authHeaders.push(typeof req.headers.authorization === "string" ? req.headers.authorization : "");

      const prior = histories.get(conversation) ?? [];
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));

      const next = queued.shift() ?? { text: "(no reply queued)" };
      if (next.status) {
        res.statusCode = next.status;
        res.end(next.body ?? JSON.stringify({ error: { message: "proxy exploded" } }));
        return;
      }
      histories.set(conversation, [...prior, input, next.text ?? ""]);
      counter++;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: `resp-${counter}`,
          object: "response",
          status: "completed",
          model: "fake-pro",
          conversation: { id: conversation },
          previous_response_id: prior.length ? `resp-${counter - 1}` : null,
          output_text: next.text ?? "",
          output: [{ type: "message", content: [{ type: "output_text", text: next.text ?? "" }] }],
        })
      );
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  // Bound first, then registered: the guard admits this exact origin and nothing else.
  const unregister = allowOrigin(`http://127.0.0.1:${port}`);

  return {
    url: `http://127.0.0.1:${port}`,
    turns,
    history: (conversation) => histories.get(conversation) ?? [],
    queue: (replies) => {
      queued = replies.map((r) => (typeof r === "string" ? { text: r } : r));
    },
    delay: (ms) => {
      delayMs = ms;
    },
    authHeaders,
    reset: () => {
      turns.length = 0;
      authHeaders.length = 0;
      histories.clear();
      queued = [];
      delayMs = 0;
    },
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      unregister(); // the port is gone, so the permission is gone with it
    },
  };
}

interface Harness {
  cwd: string;
  pi: MockPi;
  mock: MockCtx;
  sent: () => string[];
  notifications: Array<{ message: string; level: string }>;
  command: (args: string) => Promise<void>;
  fire: (event: string, evt?: any) => Promise<void>;
  /** Append what the worker said, then let its run settle. */
  workerRun: (text: string, extra?: any[]) => Promise<void>;
  text: () => string;
  dispose: () => Promise<void>;
}

async function setup(proxyUrl: string, mcpConfig: Record<string, unknown> = {}): Promise<Harness> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-relay-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "supervisor-config.json"),
    JSON.stringify(
      {
        backend: "mcp",
        mcp: { relayBaseUrl: proxyUrl, relayApiKeyEnv: "", maxIterations: 4, timeoutMs: 4000, retries: 0, ...mcpConfig },
      },
      null,
      2
    )
  );

  // Guard: a relay setting that failed to load would silently fall back to
  // pplx-proxy's usual port — the developer's live proxy — and spend real
  // Perplexity quota from a test run. Resolve the endpoint before anything can
  // talk to it, and refuse to proceed if it is not the fake proxy.
  const resolved = resolveRelay(resolveMcpSettings(cwd), cwd).endpoint.baseUrl;
  if (resolved !== proxyUrl) {
    throw new Error(`relay endpoint resolved to ${resolved}, not the fake proxy ${proxyUrl} — no test may reach a live proxy`);
  }

  const pi = createMockPi();
  const mock = createMockCtx({ cwd, apiKeyProviders: [] });
  await registerExtension(pi.api, mock.ctx);

  const command = (args: string) => pi.command("supervise").handler(args, mock.ctx);
  const fire = (event: string, evt: any = { type: event }) => pi.fire(event, evt, mock.ctx);

  return {
    cwd,
    pi,
    mock,
    sent: () => pi.sentMessages.map((m) => m.text),
    notifications: mock.notifications,
    command,
    fire,
    workerRun: async (text, extra = []) => {
      mock.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }, ...extra);
      await fire("agent_start");
      await fire("agent_settled", { type: "agent_settled", aborted: false });
    },
    text: () => mock.notifications.map((n) => n.message).join("\n"),
    dispose: async () => {
      await fire("session_shutdown", { type: "session_shutdown", reason: "logout" }).catch(() => {});
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

/** An assistant entry, as the real session branch carries it. */
function assistant(text: string) {
  return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

let proxy: FakeProxy;

beforeAll(async () => {
  proxy = await startProxy();
});

afterAll(async () => {
  await proxy?.close();
});

beforeEach(() => {
  proxy.reset();
});

describe("chat relay end to end", () => {
  it("opens one conversation with the goal, then sends its prose to the worker unchanged", async () => {
    proxy.queue(["Write the failing test for the race condition first."]);
    const h = await setup(proxy.url);
    try {
      await h.command("make the flaky test deterministic");

      expect(proxy.turns).toHaveLength(1);
      const opening = proxy.turns[0];
      // The setup message: the relay explanation plus the user's own goal.
      expect(opening.input).toContain("relay");
      expect(opening.input).toContain("Goal:\nmake the flaky test deterministic");
      expect(opening.input).toContain("[[PPLX_DONE]]");
      expect(opening.input).toContain("[[PPLX_BLOCKED]]");
      expect(opening.conversation).toMatch(/^pi-sup-/);
      expect(opening.store).toBe(true);
      expect(h.text()).toContain("Supervisor active (Perplexity relay)");

      // Forwarded verbatim — no envelope, no rewriting.
      expect(h.sent()).toEqual(["Write the failing test for the race condition first."]);
    } finally {
      await h.dispose();
    }
  });

  it("keeps one conversation and sends only the new message each turn", async () => {
    proxy.queue(["step 1", "step 2", "Both parts are proven. Goal met.\n[[PPLX_DONE]]"]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship it");
      await h.workerRun("I wrote the test; it fails as expected.");
      await h.workerRun("I fixed the race and the suite is green.");

      const conversations = new Set(proxy.turns.map((t) => t.conversation));
      expect(conversations.size).toBe(1); // one conversation for the whole run
      expect(proxy.turns).toHaveLength(3);

      // Only the new message crosses the wire; the proxy holds the history.
      expect(proxy.turns[1].input).not.toContain("Goal:\nship it");
      expect(proxy.turns[1].input).toContain("Local coding agent result:");
      expect(proxy.turns[1].input).toContain("I wrote the test; it fails as expected.");
      expect(proxy.history([...conversations][0])).toHaveLength(6);

      expect(h.sent()).toEqual(["step 1", "step 2"]);
    } finally {
      await h.dispose();
    }
  });

  it("sends the agent's own final response, not a summary, and reports truncation", async () => {
    proxy.queue(["step 1", "done now.\n[[PPLX_DONE]]"]);
    const h = await setup(proxy.url, { maxWorkerChars: 2000 });
    try {
      await h.command("ship it");
      const long = `HEAD ${"x".repeat(2000)} TAIL`;
      await h.workerRun(long);

      const forwarded = proxy.turns[1].input;
      expect(forwarded.startsWith("Local coding agent result:\nHEAD")).toBe(true);
      expect(forwarded).toContain("[[TRUNCATED:");
      expect(forwarded).toContain("of 2010 characters omitted");
      expect(forwarded.length).toBeLessThan(2300);
      // The tail survives too, so "the last line" is still visible to the supervisor.
      expect(forwarded.endsWith("TAIL")).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it("stops on [[PPLX_DONE]] without dispatching anything else", async () => {
    proxy.queue(["step 1", "Tests, lint, and build all pass in this checkout. Goal met.\n[[PPLX_DONE]]"]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship it");
      await h.workerRun("done");

      expect(h.sent()).toEqual(["step 1"]); // no further instruction
      expect(h.text()).toContain("goal met");
      expect(h.text()).toContain("Tests, lint, and build all pass");
      expect(h.text()).not.toContain("[[PPLX_DONE]]"); // the marker is not shown as content

      await h.command("status");
      expect(h.text()).toContain("complete");
      expect(h.text()).toContain("attached");
      // The hard budget spent two of its five attempts: one initial, one review.
      expect(h.text()).toContain("attempts 2/5");
    } finally {
      await h.dispose();
    }
  });

  it("pauses on [[PPLX_BLOCKED]] and waits for the human", async () => {
    proxy.queue(["step 1", "I need the staging credentials — the worker cannot get them.\n[[PPLX_BLOCKED]]"]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship it");
      await h.workerRun("done");

      expect(h.sent()).toEqual(["step 1"]);
      expect(h.text()).toContain("staging credentials");
      expect(h.text()).toContain("resume");

      await h.command("status");
      expect(h.text()).toContain("paused");
      expect(h.text()).toContain("blocked");
    } finally {
      await h.dispose();
    }
  });

  it("does not treat a marker quoted inside the agent's output as completion", async () => {
    // The worker is told about the markers in its instruction, so it quotes one
    // while talking about them. Only the supervisor's own final line counts.
    proxy.queue(
      [
        'Add the completion marker to the end of a run once the evidence is in.',
        "Good. Now add a test that a marker in the middle of a reply is ignored.",
      ]
    );
    const h = await setup(proxy.url);
    try {
      await h.command("ship it");
      await h.workerRun("I handled [[PPLX_DONE]] as you asked.\n\nIt is on the last line now.\n[[PPLX_DONE]]");

      // Still running: the loop is waiting for the supervisor's next instruction.
      expect(proxy.turns).toHaveLength(2);
      expect(proxy.turns[1].input).toContain("[[PPLX_DONE]]"); // quoted worker text, unmodified
      expect(h.sent()[0]).toContain("Add the completion marker");
      // The loop kept going and dispatched the supervisor's next instruction:
      // a marker inside the agent's own text ended nothing.
      expect(h.sent()).toHaveLength(2);
      expect(h.sent()[1]).toContain("ignored");
      expect(h.text()).not.toContain("goal met");
    } finally {
      await h.dispose();
    }
  });

  it("sends the relay setup once, however many worker runs follow", async () => {
    proxy.queue(["a", "b", "c", "finished.\n[[PPLX_DONE]]"]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship it");
      await h.workerRun("one");
      await h.workerRun("two");
      await h.workerRun("three");

      const withSetup = proxy.turns.filter((t) => t.input.includes("Goal:\nship it"));
      expect(withSetup).toHaveLength(1);
      expect(h.sent()).toEqual(["a", "b", "c"]);
    } finally {
      await h.dispose();
    }
  });

  it("adds failing tools to the turn only when the agent did not mention them", async () => {
    proxy.queue(["step 1", "keep going", "ok now.\n[[PPLX_DONE]]"]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship it");
      await h.workerRun("Everything passes.", [
        {
          type: "message",
          message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "exit 1" }] },
        },
      ]);
      expect(proxy.turns[1].input).toContain("bash reported a failure");

      await h.workerRun("bash failed with exit 1, so I retried and it passed.");
      expect(proxy.turns[2].input).not.toContain("Additional context from the extension");
    } finally {
      await h.dispose();
    }
  });

  it("dispatches nothing when the conversation fails, and says so", async () => {
    proxy.queue([{ status: 500, body: '{"error":{"message":"upstream cookie expired"}}' }]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship it");

      expect(h.sent()).toEqual([]);
      expect(h.text()).toContain("HTTP 500");
      expect(h.text()).not.toContain("cookie expired"); // proxy body is not shown verbatim

      await h.command("status");
      expect(h.text()).toContain("paused");
    } finally {
      await h.dispose();
    }
  });

  it("pauses on an empty reply instead of forwarding nothing", async () => {
    proxy.queue([{ text: "   " }]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship it");
      expect(h.sent()).toEqual([]);
      expect(h.text()).toMatch(/no text|empty reply/);
      await h.command("status");
      expect(h.text()).toContain("paused");
    } finally {
      await h.dispose();
    }
  });

  it("drops a reply that arrives after the user stopped the run", async () => {
    proxy.delay(120);
    proxy.queue(["too late"]);
    const h = await setup(proxy.url);
    try {
      const starting = h.command("ship it");
      await new Promise((r) => setTimeout(r, 30)); // the request is in flight
      await h.command("stop");
      await starting;

      expect(proxy.turns).toHaveLength(1); // the request did go out
      expect(h.sent()).toEqual([]); // but its answer is never dispatched
      await h.command("status");
      expect(h.text()).toContain("stopped");
    } finally {
      proxy.delay(0);
      await h.dispose();
    }
  });

  it("refuses to start, and says what is missing, when the relay is misconfigured", async () => {
    const h = await setup("not-an-origin");
    try {
      await h.command("ship it");
      expect(h.text()).toContain("Cannot start the relay");
      expect(proxy.turns).toHaveLength(0);

      await h.command("status");
      expect(h.text()).toContain("Configuration incomplete");
    } finally {
      await h.dispose();
    }
  });

  it("reports every phase through the registered status handler", async () => {
    const h = await setup(proxy.url);
    try {
      // idle
      await h.command("status");
      expect(h.text()).toContain("Supervisor: idle");
      expect(h.text()).toContain("pplx-proxy chat relay");
      expect(h.text()).toContain("Nothing is being supervised");

      // awaiting Perplexity (the first request is still in flight)
      proxy.delay(120);
      proxy.queue(["step 1"]);
      const starting = h.command("ship it");
      await new Promise((r) => setTimeout(r, 30));
      await h.command("status");
      expect(h.text()).toContain("awaiting Perplexity");
      expect(h.text()).toContain("setup not yet delivered");
      await starting;
      proxy.delay(0);

      // worker running
      mockIdle(h, false);
      await h.command("status");
      expect(h.text()).toContain("worker running");

      // conversation attached, with its id and turn count
      expect(h.text()).toContain("attached");
      expect(h.text()).toContain("turn 1");

      // paused with the reason
      await h.command("stop");
      await h.command("status");
      // An explicit stop ends the run rather than pausing it, and says so.
      expect(h.text()).toContain("stopped");
    } finally {
      mockIdle(h, true);
      await h.dispose();
    }
  });

  it("never sends a credential it was not given, and never prints one", async () => {
    proxy.queue(["step 1\n[[PPLX_DONE]]"]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship it");
      expect(proxy.authHeaders.every((a) => a === "")).toBe(true);
      await h.command("mcp status");
      expect(h.text()).toContain("PPLX_PROXY_API_KEY");
      expect(h.text()).not.toMatch(/authorization:|bearer /i);
    } finally {
      await h.dispose();
    }
  });

  it("continues the saved conversation on resume without resending the setup", async () => {
    proxy.queue(["step 1", "resume and finish it.", "finished.\n[[PPLX_DONE]]"]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship it");
      await h.fire("agent_start");
      await h.fire("agent_settled", { type: "agent_settled", aborted: true });
      // An interrupted worker pauses the loop; resume continues the same
      // conversation rather than opening one or repeating the setup.
      await h.command("status");
      expect(h.text()).toContain("paused");
      expect(h.text()).toContain("interrupted");

      await h.command("resume");
      expect(new Set(proxy.turns.map((t) => t.conversation)).size).toBe(1);
      const setups = proxy.turns.filter((t) => t.input.includes("Goal:\nship it"));
      expect(setups).toHaveLength(1);
    } finally {
      await h.dispose();
    }
  });
});

/** Flip the host's idle flag the way a real session does between runs. */
function mockIdle(h: Harness, idle: boolean): void {
  h.mock.ctx.isIdle = () => idle;
}

/** Keep the helper honest: assistant() matches what summarizeWorker reads. */
describe("relay test fixtures", () => {
  it("produces session entries the reporter understands", () => {
    const entries = [assistant("hello")];
    expect((entries[0] as any).message.content[0].text).toBe("hello");
  });
});

/**
 * Regressions from the 2026-11-07 21:30 run in this workspace (session
 * 01a1b7eb-7423-74fc-9721-fce9c4e1d1d9). Everything in it went wrong the way the
 * fixture shows: a status request that became a goal, two blocked verdicts that were
 * dispatched to the worker as instructions, and an empty worker run that was relayed to
 * Perplexity as an ordinary result — after which the worker failed again on the same
 * 404. Each test below asserts the *counts*: requests made, instructions injected.
 */
describe("transcript regressions — 2026-11-07", () => {
  it("a multi-line status submission starts nothing, injects nothing, asks nothing", async () => {
    proxy.queue([REPLY_1]);
    const h = await setup(proxy.url);
    try {
      await h.command(GOAL_AS_SUBMITTED);

      expect(h.sent()).toEqual([]);
      expect(proxy.turns).toHaveLength(0);
      expect(h.text()).toMatch(/not treated as a goal/);
      expect(h.text()).toMatch(/nothing was started/i);

      // …and the saved goal really is unchanged: there is nothing to report.
      await h.command("status");
      expect(h.text()).toContain("Nothing is being supervised");
    } finally {
      await h.dispose();
    }
  });

  it("pauses on the transcript's blocked reply: nothing injected, no second request", async () => {
    proxy.queue([REPLY_1]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship the fix");

      expect(proxy.turns).toHaveLength(1);
      // The blocked reason is shown, never forwarded to the worker.
      expect(h.sent()).toEqual([]);
      // The blocked state is visible in its own words, not buried in a log.
      expect(h.text()).toMatch(/Supervisor is blocked/i);
      expect(h.text()).toMatch(/\/supervise resume once it is resolved/);
      expect(h.text()).toContain("Please provide a concise status report");

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(proxy.turns).toHaveLength(1); // nothing asked automatically afterwards

      await h.command("status");
      expect(h.text()).toMatch(/paused —/);
      expect(h.text()).toContain("Resume with: /supervise resume");
    } finally {
      await h.dispose();
    }
  });

  it("pauses on the second transcript reply too, once the run gets that far", async () => {
    proxy.queue(["step 1", REPLY_2]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship the fix");
      expect(h.sent()).toEqual(["step 1"]);

      await h.workerRun("I inspected the repository and reported the branch state.");
      expect(h.sent()).toEqual(["step 1"]); // REPLY_2 never dispatched
      expect(proxy.turns).toHaveLength(2);
      expect(h.text()).toContain("Do not begin implementation yet");
    } finally {
      await h.dispose();
    }
  });

  it("refuses a reply whose marker does not end the reply — no dispatch, no auto-repair", async () => {
    proxy.queue(["Never write [[PPLX_DONE]] early.\nNow run the suite and show the output."]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship it");

      expect(h.sent()).toEqual([]);
      expect(h.text()).toContain("Supervisor paused (protocol)");

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(proxy.turns).toHaveLength(1); // exactly one request; no repair attempt
    } finally {
      await h.dispose();
    }
  });

  it("pauses when the worker run ended in error instead of answering, and asks nobody", async () => {
    proxy.queue(["step 1"]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship the fix");
      expect(h.sent()).toEqual(["step 1"]);
      const requests = proxy.turns.length;

      // Exactly what the transcript recorded: an assistant message that ended with an
      // API error and no text — the worker's own model was a 404 model_not_found.
      h.mock.branch.push({
        type: "message",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "404 model_not_found" },
      });
      await h.fire("agent_start");
      await h.fire("agent_settled", { type: "agent_settled", aborted: false });

      expect(h.sent()).toHaveLength(1); // no new instruction
      expect(proxy.turns).toHaveLength(requests); // and no automatic turn either
      expect(h.text()).toMatch(/interrupted or stopped with an error|without a final response/);

      await h.command("status");
      expect(h.text()).toMatch(/paused — worker run incomplete/);
    } finally {
      await h.dispose();
    }
  });

  it("pauses visibly on an empty final response rather than inventing a chat turn", async () => {
    proxy.queue(["step 1"]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship the fix");
      const requests = proxy.turns.length;

      h.mock.branch.push(assistant(""));
      await h.fire("agent_start");
      await h.fire("agent_settled", { type: "agent_settled", aborted: false });

      expect(proxy.turns).toHaveLength(requests);
      expect(h.sent()).toHaveLength(1);
      expect(h.text()).toContain("ended without a final response");
    } finally {
      await h.dispose();
    }
  });

  it("a reasoning-only stop pauses visibly, asks nobody, and waits for an explicit resume", async () => {
    proxy.queue(["step 1", "understood — try the check again."]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship the fix");
      const requests = proxy.turns.length;

      // The exact shape the session recorded: one assistant message whose content is a
      // thinking block only, stopReason "stop" — no text, no tool call, no error.
      h.mock.branch.push({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "(reasoning omitted in fixture)" }],
          stopReason: "stop",
        },
      });
      await h.fire("agent_start");
      await h.fire("agent_settled", { type: "agent_settled", aborted: false });

      expect(proxy.turns).toHaveLength(requests); // no automatic Perplexity request
      expect(h.sent()).toHaveLength(1); // and no further worker instruction
      expect(h.text()).toContain("ended without a final response"); // the pause, visible

      // Silence is not a result: nothing moves until the user acts, and one explicit
      // resume sends exactly one turn that says so.
      await h.command("resume");
      expect(proxy.turns).toHaveLength(requests + 1);
      expect(proxy.turns[requests].input).toMatch(/no final response/);
    } finally {
      await h.dispose();
    }
  });

  it("a completed run that reports failures is a result, and it still travels on", async () => {
    proxy.queue(["step 1", "fix the failing test, then run it twice."]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship the fix");
      await h.workerRun("npm test failed: 2 of 57 tests failed.", [
        {
          type: "message",
          message: {
            role: "toolResult",
            toolName: "bash",
            isError: true,
            content: [{ type: "text", text: "2 failed" }],
          },
        },
      ]);

      expect(h.sent()).toEqual(["step 1", "fix the failing test, then run it twice."]);
      expect(proxy.turns[1].input).toContain("npm test failed: 2 of 57 tests failed.");
    } finally {
      await h.dispose();
    }
  });

  it("only an explicit resume explains the interruption to Perplexity", async () => {
    proxy.queue(["step 1", "understood — try the check again."]);
    const h = await setup(proxy.url);
    try {
      await h.command("ship the fix");
      h.mock.branch.push({
        type: "message",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "404 model_not_found" },
      });
      await h.fire("agent_start");
      await h.fire("agent_settled", { type: "agent_settled", aborted: false });
      expect(proxy.turns).toHaveLength(1);

      await h.command("resume");

      expect(proxy.turns).toHaveLength(2);
      expect(proxy.turns[1].input).toContain("Local coding agent result");
      expect(proxy.turns[1].input).toMatch(/no final response|interrupted/);
    } finally {
      await h.dispose();
    }
  });

  it("a stop mid-turn dispatches nothing late and reviews nothing afterwards", async () => {
    proxy.delay(120);
    proxy.queue(["step 1"]);
    const h = await setup(proxy.url);
    try {
      const starting = h.command("ship the fix");
      await new Promise((resolve) => setTimeout(resolve, 40));
      await h.command("stop");
      await starting;
      proxy.delay(0);
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(h.sent()).toEqual([]); // the late reply was discarded
      await h.fire("agent_settled", { type: "agent_settled", aborted: false });
      expect(proxy.turns).toHaveLength(1); // and the settle did not reopen it
      expect(h.sent()).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  it("status is read from local state in every phase — no request, no injection", async () => {
    proxy.queue(["step 1", "still working.", "done.\n[[PPLX_DONE]]"]);
    const h = await setup(proxy.url);
    try {
      const attempts = () => (globalThis as unknown as { __networkAttempts: string[] }).__networkAttempts.length;

      // idle
      await h.command("status");
      expect(h.text()).toContain("Supervisor: idle");
      expect(proxy.turns).toHaveLength(0);
      expect(h.sent()).toEqual([]);
      const baseline = attempts();

      // awaiting Perplexity → worker running
      await h.command("ship the fix");
      await h.workerRun("the change is in");
      expect(h.sent()).toEqual(["step 1", "still working."]);
      const during = proxy.turns.length;
      mockIdle(h, false); // the instruction is in the worker's hands now, not ours

      await h.command("status");
      expect(h.text()).toContain("worker running");
      expect(h.text()).toContain("ship the fix"); // the goal it was asked about
      expect(proxy.turns).toHaveLength(during);
      expect(h.sent()).toEqual(["step 1", "still working."]);

      // paused, by an interrupted worker run
      h.mock.branch.push({
        type: "message",
        message: { role: "assistant", content: [], stopReason: "aborted" },
      });
      await h.fire("agent_start");
      await h.fire("agent_settled", { type: "agent_settled", aborted: true });
      const pausedAt = proxy.turns.length;
      await h.command("status");
      expect(h.text()).toMatch(/paused — /);
      expect(proxy.turns).toHaveLength(pausedAt);

      // completed
      await h.command("resume");
      await new Promise((resolve) => setTimeout(resolve, 60));
      const doneAt = proxy.turns.length;
      await h.command("status");
      expect(h.text()).toContain("Goal met");
      // the terminal reply is a verdict, not an instruction: nothing new was dispatched

      // Every status call was local: three turns of conversation, three fetches — no
      // hidden request, and no instruction that was not a verdict's successor.
      expect(proxy.turns).toHaveLength(doneAt);
      expect(proxy.turns.length).toBe(3);
      expect(attempts()).toBe(baseline + 3);
    } finally {
      await h.dispose();
    }
  });
});

describe("host run mode", () => {
  it("refuses to start in print mode: no request, no dispatch, no state", async () => {
    proxy.queue(["Do the first step."]);
    const h = await setup(proxy.url);
    try {
      h.mock.ctx.mode = "print";
      await h.command("make the flaky test deterministic");

      expect(proxy.turns).toHaveLength(0); // nothing reached the proxy
      expect(h.sent()).toHaveLength(0); // no worker dispatch
      expect(h.text()).toContain("Cannot start the relay here");

      // Local subcommands still work in print mode.
      await h.command("status");
      expect(proxy.turns).toHaveLength(0);
      expect(h.text()).toContain("Nothing is being supervised");
    } finally {
      await h.dispose();
    }
  });

  it("refuses to resume in print mode, even when a run is paused", async () => {
    proxy.queue([
      "Write the failing test first.",
      "I cannot continue without a product decision: [[PPLX_BLOCKED]]",
    ]);
    const h = await setup(proxy.url);
    try {
      await h.command("make the flaky test deterministic");
      await h.workerRun("I wrote the test; it fails as expected.");

      // The blocked reply pauses the relay: the run is preserved, the relay waits.
      expect(h.text()).toMatch(/Supervisor is blocked/);
      const turnsBefore = proxy.turns.length;
      const dispatchesBefore = h.sent().length;

      h.mock.ctx.mode = "print";
      await h.command("resume");

      expect(proxy.turns).toHaveLength(turnsBefore); // no new request
      expect(h.sent()).toHaveLength(dispatchesBefore); // no new dispatch
      expect(h.text()).toContain("Cannot resume the relay here");
    } finally {
      await h.dispose();
    }
  });
});

describe("a run whose state was lost", () => {
  it("says so explicitly in status and resume instead of generic text", async () => {
    const h = await setup(proxy.url);
    try {
      // The transcript contains the goal but no supervisor-state entry: the host
      // died before the state was ever persisted.
      h.mock.branch.push({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "/supervise make the flaky test deterministic" }],
        },
      });
      await h.fire("session_start");

      await h.command("status");
      expect(h.text()).toContain("Nothing is being supervised");
      expect(h.text()).toContain("state was lost");
      expect(h.text()).toContain("can be restored");

      await h.command("resume");
      expect(h.text()).toContain("Nothing to resume");
      expect(h.text()).toContain("state was lost");
      expect(proxy.turns).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  });
});
