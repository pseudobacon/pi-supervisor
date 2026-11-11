import { describe, expect, it, vi } from "vitest";
import { McpSupervisorBackend } from "../src/backends/mcp-backend.js";
import type { SupervisorRequest } from "../src/backends/types.js";
import { SupervisorUnavailableError } from "../src/backends/types.js";
import { type McpCallOptions, type McpConnection, type McpToolDescriptor, McpTransportError } from "../src/mcp/client.js";
import type { McpSettings } from "../src/mcp/config.js";
import type { SupervisorState } from "../src/types.js";

const TOOL: McpToolDescriptor = {
  name: "perplexity_reason",
  description: "Reason about a report",
  inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
};

type Reply = { text?: string; structured?: unknown; isError?: boolean; throws?: Error };

class FakeConnection implements McpConnection {
  calls: Array<{ tool: string; args: Record<string, unknown>; options?: McpCallOptions }> = [];
  listCalls = 0;
  closed = 0;
  serverInfo = { name: "pplx-proxy", version: "1.30.0" };

  constructor(private replies: Reply[]) {}

  async listTools(): Promise<McpToolDescriptor[]> {
    this.listCalls++;
    return [TOOL];
  }
  async callTool(name: string, args: Record<string, unknown>, options?: McpCallOptions) {
    this.calls.push({ tool: name, args, options });
    const reply = this.replies.shift() ?? { text: '{"action":"steer","instruction":"do it"}' };
    if (reply.throws) throw reply.throws;
    return { text: reply.text ?? "", structured: reply.structured, isError: reply.isError === true };
  }
  async close(): Promise<void> {
    this.closed++;
  }
}

function harness(replies: Reply[], overrides: Partial<McpSettings> = {}) {
  const connections: FakeConnection[] = [];
  const factory = vi.fn(async () => {
    const connection = new FakeConnection(replies);
    connections.push(connection);
    return connection;
  });
  const settings: McpSettings = {
    url: "http://127.0.0.1:1/mcp",
    tool: TOOL.name,
    timeoutMs: 5_000,
    retries: 0,
    maxIterations: 5,
    maxDurationMs: 60_000,
    maxReportChars: 5_000,
    sendToolCalls: true,
    sendToolResults: true,
    sendAssistantOutput: true,
    sendChangedFiles: true,
    ...overrides,
  };
  const backend = new McpSupervisorBackend({ settings, cwd: "/tmp", systemPrompt: "PROMPT", connectionFactory: factory });
  return { backend, connections, factory };
}

const state: SupervisorState = {
  active: true,
  outcome: "ship it",
  provider: "anthropic",
  modelId: "m",
  sensitivity: "medium",
  interventions: [],
  startedAt: 0,
  turnCount: 1,
  backend: "mcp",
  phase: "reviewing",
  acceptanceCriteria: ["tests pass"],
};

const request = (overrides: Partial<SupervisorRequest> = {}): SupervisorRequest => ({
  kind: "review",
  state,
  report: "GOAL: ship it",
  agentIsIdle: true,
  stagnating: false,
  ...overrides,
});

describe("McpSupervisorBackend.review", () => {
  it("sends the system prompt plus the report to the discovered tool", async () => {
    const { backend, connections } = harness([{ text: '{"action":"steer","instruction":"add a test"}' }]);
    const outcome = await backend.review(request());

    expect(outcome.decision).toMatchObject({ action: "steer", message: "add a test" });
    expect(connections).toHaveLength(1);
    const sent = connections[0].calls[0];
    expect(sent.tool).toBe("perplexity_reason");
    expect(sent.args.prompt).toContain("PROMPT");
    expect(sent.args.prompt).toContain("GOAL: ship it");
    expect(outcome.detail).toContain("perplexity_reason");
  });

  it("closes its connection after every review", async () => {
    const { backend, connections } = harness([{ text: '{"action":"steer","instruction":"x"}' }]);
    await backend.review(request());
    expect(connections[0].closed).toBe(1);
  });

  it("prefers structuredContent over text when the server provides it", async () => {
    const { backend } = harness([{ text: "ignored prose", structured: { action: "done", criteria: [{ criterion: "c", evidence: "npm test → ok", met: true }] } }]);
    const outcome = await backend.review(request());
    expect(outcome.decision.action).toBe("done");
  });

  it("unwraps a server that returns the decision as a string inside structuredContent", async () => {
    // pplx-proxy does exactly this: its text answer is mirrored into
    // structuredContent under a single `result` key.
    const { backend } = harness([
      {
        text: '{"action":"steer","instruction":"run npm test","reasoning":"check"}\n\n[Remaining Pro Search: 115]',
        structured: { result: '{"action":"steer","instruction":"run npm test","reasoning":"check"}' },
      },
    ]);
    const outcome = await backend.review(request());
    expect(outcome.decision).toMatchObject({ action: "steer", message: "run npm test" });
  });

  it("parses the reply as sent, not as redacted — a quoted command is not a secret", async () => {
    const { backend } = harness([
      { text: '{"action":"steer","instruction":"run API_KEY=secret npm test --grep \\"login\\"","reasoning":"check"}' },
    ]);
    const outcome = await backend.review(request());
    expect(outcome.decision.action).toBe("steer");
    // The instruction still reaches the loop, and the copy we keep is redacted.
    expect(outcome.decision.message).toContain("API_KEY=[REDACTED secret]");
  });

  it("redacts secrets in the supervisor's own text before keeping it", async () => {
    const { backend } = harness([{ text: 'sorry my key is sk-abcdefghijkl123456 {"action":"steer","instruction":"x"}' }]);
    const outcome = await backend.review(request());
    expect(outcome.raw).not.toContain("sk-abcdefghijkl123456");
  });

  it("gets exactly one repair round for a malformed reply, then accepts the fix", async () => {
    const { backend, connections } = harness([{ text: "I think the worker is doing great!" }, { text: '{"action":"steer","instruction":"run npm test"}' }]);
    const outcome = await backend.review(request());

    expect(outcome.decision.message).toBe("run npm test");
    expect(outcome.repaired).toBe(true);
    expect(connections).toHaveLength(2);
    // The repair prompt quotes the rejected reply and the reason
    expect(connections[1].calls[0].args.prompt).toContain("doing great");
    expect(connections[1].calls[0].args.prompt).toMatch(/REJECTED|could not be used/);
  });

  it("gives up after the repair round instead of guessing", async () => {
    const { backend, connections } = harness([{ text: "still prose" }, { text: "still prose again" }]);
    await expect(backend.review(request())).rejects.toThrow(SupervisorUnavailableError);
    await expect(harness([{ text: "prose" }, { text: "prose" }]).backend.review(request())).rejects.toThrow(/not usable/);
    expect(connections.length).toBeLessThanOrEqual(4); // never an unbounded retry loop
  });

  it("surfaces a tool-level error rather than inventing a decision", async () => {
    const { backend } = harness([{ text: "upstream 502 from provider", isError: true }]);
    await expect(backend.review(request())).rejects.toThrow(/reported an error/);
  });

  it("retries transient transport failures up to the configured number of times", async () => {
    const { backend, connections } = harness(
      [{ throws: new McpTransportError("ECONNREFUSED", true) }, { text: '{"action":"steer","instruction":"go"}' }],
      { retries: 2 }
    );
    const outcome = await backend.review(request());
    expect(outcome.decision.message).toBe("go");
    expect(connections.length).toBe(2);
  });

  it("stops retrying once the budget is spent and reports the failure", async () => {
    const { backend, connections } = harness(
      [
        { throws: new McpTransportError("ECONNREFUSED", true) },
        { throws: new McpTransportError("ECONNREFUSED", true) },
        { throws: new McpTransportError("ECONNREFUSED", true) },
      ],
      { retries: 1 }
    );
    await expect(backend.review(request())).rejects.toThrow(/ECONNREFUSED/);
    expect(connections.length).toBe(2); // initial + 1 retry
  });

  it("does not retry a tool that rejects an invalid argument mapping", async () => {
    const { backend, connections } = harness([{ throws: new Error("input validation failed: prompt required") }]);
    await expect(backend.review(request())).rejects.toThrow(/input validation/);
    expect(connections.length).toBe(1);
  });

  it("reports an unresolvable endpoint as a configuration problem", async () => {
    const settings: McpSettings = {
      server: "definitely-not-configured-for-this-test",
      tool: TOOL.name,
      timeoutMs: 1000,
      retries: 0,
      maxIterations: 5,
      maxDurationMs: 1000,
      maxReportChars: 1000,
      sendToolCalls: true,
      sendToolResults: true,
      sendAssistantOutput: true,
      sendChangedFiles: true,
    };
    const backend = new McpSupervisorBackend({ settings, cwd: "/nonexistent-pi-supervisor-cwd", connectionFactory: async () => new FakeConnection([]) });
    const error = await backend.review(request()).catch((e) => e);
    expect(error).toBeInstanceOf(SupervisorUnavailableError);
    expect((error as SupervisorUnavailableError).kind).toBe("config");
  });

  it("honours an abort: no call is retried and the signal is passed through", async () => {
    const controller = new AbortController();
    controller.abort();
    const { backend, connections } = harness([{ throws: new McpTransportError("aborted") }]);
    await expect(backend.review(request(), controller.signal)).rejects.toThrow();
    expect(connections.length).toBeLessThanOrEqual(1);
  });

  it("passes the configured timeout down to the transport", async () => {
    const { backend, connections } = harness([{ text: '{"action":"steer","instruction":"x"}' }], { timeoutMs: 4_321 });
    await backend.review(request());
    expect(connections[0].calls[0].options?.timeoutMs).toBe(4_321);
    expect(connections[0].listCalls).toBe(1); // tool list is discovered, never assumed
  });

  it("refuses to reuse a disposed backend", async () => {
    const { backend } = harness([{ text: '{"action":"steer","instruction":"x"}' }]);
    await backend.dispose();
    await expect(backend.review(request())).rejects.toThrow(/closed/);
  });
});

describe("McpSupervisorBackend.discover", () => {
  it("reports the tools and server version it actually found", async () => {
    const { backend } = harness([]);
    const found = await backend.discover();
    expect(found.tools.map((t) => t.name)).toEqual(["perplexity_reason"]);
    expect(found.server).toMatchObject({ name: "pplx-proxy", version: "1.30.0" });
    expect(found.endpoint.source).toMatch(/url/);
  });
});

describe("retry policy", () => {
  it("does not retry a transport error marked non-transient", async () => {
    const { backend, connections } = harness([{ throws: new McpTransportError("400 bad request", false) }], { retries: 3 });
    await expect(backend.review(request())).rejects.toThrow(/400 bad request/);
    expect(connections.length).toBe(1);
  });
});
