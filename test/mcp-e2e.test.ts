/**
 * End-to-end test of the MCP surface the relay still uses.
 *
 * The chat relay talks to pplx-proxy's Responses API, but MCP remains how this
 * extension *discovers* the proxy: `/supervise mcp tools` lists what the server
 * offers, and the settings verbs decide which endpoint and which limits the run
 * uses. A spec-complete MCP server (the official SDK's `McpServer`) listens on an
 * ephemeral localhost port here, exactly as pplx-proxy does, and the loaded
 * extension talks to it over Streamable HTTP. Nothing leaves the machine.
 *
 * The supervisor *decision* workflow that used to live here moved to
 * test/relay-e2e.test.ts: the proxy's five tools answer one question and forget
 * the answer, so they cannot carry a conversation — see the report in HANDOFF.md.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import registerExtension from "../src/index.js";
import { createMockCtx, createMockPi } from "./harness.js";
import { allowOrigin } from "./helpers/network-guard.js";

function makeMcpServer(): McpServer {
  const mcp = new McpServer({ name: "pplx-proxy-test", version: "1.30.0" });
  // Shaped like the real proxy's tools: one question in, one string out, and no
  // way to continue a conversation. Discovery has to work with exactly this.
  mcp.registerTool(
    "perplexity_search",
    {
      title: "Perplexity search",
      description: "Search the web with Perplexity.",
      inputSchema: { query: z.string().describe("The query"), language: z.string().optional() },
    },
    async () => ({ content: [{ type: "text" as const, text: "an answer" }] })
  );
  mcp.registerTool(
    "perplexity_ask",
    {
      title: "Perplexity ask",
      description: "Ask Perplexity a question.",
      inputSchema: { query: z.string().describe("The question"), language: z.string().optional() },
    },
    async () => ({ content: [{ type: "text" as const, text: "an answer" }] })
  );
  return mcp;
}

/** Multi-session Streamable HTTP endpoint, per the SDK's documented shape. */
async function startMcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sessions: StreamableHTTPServerTransport[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", async () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
        const header = req.headers["mcp-session-id"];
        let transport = typeof header === "string" ? transports.get(header) : undefined;

        if (!transport) {
          if (!(req.method === "POST" && body?.method === "initialize")) {
            res.statusCode = 400;
            res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null }));
            return;
          }
          const session: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => transports.set(id, session),
          });
          session.onclose = () => {
            if (session.sessionId) transports.delete(session.sessionId);
          };
          sessions.push(session);
          await makeMcpServer().connect(session);
          transport = session;
        }

        await transport.handleRequest(req, res, body);
      } catch {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  // Bound first, then registered: the guard admits this exact origin and nothing else.
  const unregister = allowOrigin(`http://127.0.0.1:${port}`);

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      for (const t of sessions) await t.close().catch(() => {});
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      unregister(); // the port is gone, so the permission is gone with it
    },
  };
}

interface Harness {
  cwd: string;
  command: (args: string) => Promise<void>;
  text: () => string;
  notifications: Array<{ message: string; level: string }>;
  config: () => Record<string, any>;
  dispose: () => Promise<void>;
}

async function setup(mcpConfig: Record<string, unknown>): Promise<Harness> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-supervisor-mcp-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "supervisor-config.json"), JSON.stringify({ backend: "mcp", mcp: mcpConfig }, null, 2));

  const pi = createMockPi();
  const mock = createMockCtx({ cwd, apiKeyProviders: [] });
  await registerExtension(pi.api, mock.ctx);

  return {
    cwd,
    command: (args: string) => pi.command("supervise").handler(args, mock.ctx),
    text: () => mock.notifications.map((n) => n.message).join("\n"),
    notifications: mock.notifications,
    config: () => JSON.parse(readFileSync(join(cwd, ".pi", "supervisor-config.json"), "utf8")),
    dispose: async () => {
      await pi.fire("session_shutdown", { type: "session_shutdown", reason: "logout" }, mock.ctx).catch(() => {});
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

let server: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  server = await startMcpServer();
});

afterAll(async () => {
  await server?.close();
});

describe("MCP discovery and relay configuration", () => {
  it("lists the proxy's tools through the registered command", async () => {
    const h = await setup({ url: server.url });
    try {
      await h.command("mcp tools");
      expect(h.text()).toContain("perplexity_search(query");
      expect(h.text()).toContain("perplexity_ask(query");
      expect(h.text()).toContain("pplx-proxy-test");
    } finally {
      await h.dispose();
    }
  });

  it("reports the endpoint and the relay settings without any credential material", async () => {
    const h = await setup({ url: server.url, relayBaseUrl: "http://relay.invalid:9999", relayModel: "sonnet" });
    try {
      await h.command("mcp status");
      const text = h.text();
      expect(text).toContain("relay.invalid:9999");
      expect(text).toContain("model sonnet");
      expect(text).toContain("endpoint from supervisor-config.json");
      expect(text).toContain("built-in"); // the intro template, until one is configured
      expect(text).toMatch(/Secrets:.*never stored or printed/);
      expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}|bearer\s+\S+/i);
    } finally {
      await h.dispose();
    }
  });

  it("writes each relay setting where the next read will find it", async () => {
    const h = await setup({ url: server.url });
    try {
      await h.command("mcp base-url http://127.0.0.1:8892");
      await h.command("mcp model sonnet");
      await h.command("mcp api-key-env MY_PROXY_TOKEN");
      await h.command("mcp intro .pi/custom-relay.md");
      await h.command("mcp worker-chars 30000");
      await h.command("mcp iterations 7");
      await h.command("mcp minutes 20");

      const mcp = h.config().mcp;
      expect(mcp.relayBaseUrl).toBe("http://127.0.0.1:8892");
      expect(mcp.relayModel).toBe("sonnet");
      expect(mcp.relayApiKeyEnv).toBe("MY_PROXY_TOKEN");
      expect(mcp.relayIntroFile).toBe(".pi/custom-relay.md");
      expect(mcp.maxWorkerChars).toBe(30000);
      expect(mcp.maxIterations).toBe(7);
      expect(mcp.maxDurationMs).toBe(20 * 60_000);

      // And they are what the status readout reflects.
      await h.command("mcp status");
      expect(h.text()).toContain("model sonnet");
      expect(h.text()).toContain("MY_PROXY_TOKEN");
      expect(h.text()).toContain("CONFIGURED FILE NOT FOUND"); // the intro file is real, but absent
      expect(h.text()).toContain("30000 characters");
      expect(h.text()).toContain("7 turns · 20 min");
    } finally {
      await h.dispose();
    }
  });

  it("keeps unrelated settings and the model backend choice intact", async () => {
    const h = await setup({ url: server.url });
    try {
      await h.command("backend model");
      await h.command("mcp model gpt");
      expect(h.config().backend).toBe("model");
      expect(h.config().mcp.relayModel).toBe("gpt");
      expect(h.config().mcp.url).toBe(server.url);
    } finally {
      await h.dispose();
    }
  });

  it("explains an unknown subcommand instead of doing nothing", async () => {
    const h = await setup({ url: server.url });
    try {
      await h.command("mcp nonsense");
      expect(h.text()).toContain("Unknown /supervise mcp subcommand");
      expect(h.text()).toContain("base-url");
    } finally {
      await h.dispose();
    }
  });
});
