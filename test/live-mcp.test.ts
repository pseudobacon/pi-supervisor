/**
 * Live verification against a real MCP server. OFF BY DEFAULT.
 *
 *   PI_SUPERVISOR_LIVE_MCP=1 npm run test:live
 *   PI_SUPERVISOR_LIVE_MCP=1 PI_SUPERVISOR_LIVE_URL=http://127.0.0.1:8892/mcp/mcp npm run test:live
 *
 * Without the opt-in flag this file collects no tests, so the normal suite
 * stays offline and deterministic. With it, the suite dials one server — the URL
 * given in the environment, otherwise the server the project's supervisor config
 * already names — and proves three things: the Streamable HTTP handshake works,
 * `tools/list` returns real tools with real schemas, and a `tools/call` round
 * trip is handled without leaking credential material.
 *
 * A general-purpose proxy (search, ask, research) answers in prose, not in the
 * decision JSON this extension requires. That is an expected outcome, recorded
 * below rather than papered over: it is the difference between "the transport
 * works" and "this particular server can act as a supervisor".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpSupervisorBackend } from "../src/backends/mcp-backend.js";
import { type SupervisorRequest, SupervisorUnavailableError } from "../src/backends/types.js";
import { DEFAULT_MCP_SETTINGS, resolveMcpSettings } from "../src/mcp/config.js";
import type { SupervisorState } from "../src/types.js";
import { allowOrigin } from "./helpers/network-guard.js";

const LIVE = process.env.PI_SUPERVISOR_LIVE_MCP === "1";
const URL_OVERRIDE = process.env.PI_SUPERVISOR_LIVE_URL;
const TOOL = process.env.PI_SUPERVISOR_LIVE_TOOL;
const CWD = process.env.PI_SUPERVISOR_LIVE_CWD ?? process.cwd();

/** Findings printed so a human can record them in HANDOFF.md. */
const findings: string[] = [];
function note(line: string): void {
  findings.push(line);
  console.log(`[live] ${line}`);
}

function request(report: string): SupervisorRequest {
  const state: SupervisorState = {
    active: true,
    outcome: "Confirm the live MCP server is reachable and answers supervisor requests",
    provider: "none",
    modelId: "none",
    sensitivity: "medium",
    interventions: [],
    startedAt: Date.now(),
    turnCount: 1,
    backend: "mcp",
    phase: "reviewing",
    acceptanceCriteria: ["the supervisor answers with a valid decision"],
  };
  return { kind: "review", state, report, agentIsIdle: true, stagnating: false };
}

let backend: McpSupervisorBackend | undefined;

beforeAll(() => {
  if (!LIVE) return;
  const settings = {
    ...resolveMcpSettings(CWD),
    ...(URL_OVERRIDE ? { url: URL_OVERRIDE } : {}),
    ...(TOOL ? { tool: TOOL } : {}),
    timeoutMs: Math.max(DEFAULT_MCP_SETTINGS.timeoutMs, 60_000),
    retries: 0,
  };
  // Two independent opt-ins, deliberately. This file collects nothing without
  // PI_SUPERVISOR_LIVE_MCP=1, and the guard still refuses to open the developer's live
  // proxy origin (or whatever PPLX_PROXY_URL / PI_SUPERVISOR_LIVE_URL inherit) unless the
  // operator *also* sets PI_SUPERVISOR_ALLOW_LIVE_PROXY=1. Inherited settings and
  // credentials are data: neither of them, alone, can spend live quota.
  try {
    allowOrigin(settings.url);
  } catch (e) {
    throw new Error(
      `${(e as Error).message}
A live run is an operator decision: set PI_SUPERVISOR_ALLOW_LIVE_PROXY=1 as well as
PI_SUPERVISOR_LIVE_MCP=1 when you really mean to use live quota.`
    );
  }
  backend = new McpSupervisorBackend({ settings, cwd: CWD });
  note(`endpoint: ${backend.label}`);
});

afterAll(async () => {
  await backend?.dispose();
});

describe.skipIf(!LIVE)("live pplx-proxy MCP supervisor", () => {
  it("completes the MCP handshake and lists real tools", async () => {
    const found = await backend!.discover();
    expect(found.tools.length).toBeGreaterThan(0);
    note(`server: ${found.server?.name ?? "(unnamed)"} ${found.server?.version ?? ""}`);
    note(`via: ${found.endpoint.source}`);
    if (found.endpoint.missingEnv.length) note(`header env vars not set: ${found.endpoint.missingEnv.join(", ")}`);
    for (const tool of found.tools) {
      const props = Object.entries((tool.inputSchema as { properties?: Record<string, { type?: string }> })?.properties ?? {});
      note(`tool: ${tool.name}(${props.map(([n, p]) => `${n}:${p.type ?? "?"}`).join(", ")})`);
    }
    // Names and descriptions come from the server; nothing here may look like a key.
    const transcript = JSON.stringify(found.tools);
    expect(transcript).not.toMatch(/sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}/);
  }, 120_000);

  it("round-trips one supervisor request and handles the answer cleanly", async () => {
    const report = [
      "SUPERVISION REPORT",
      "GOAL: Confirm the live MCP server is reachable and answers supervisor requests",
      "ITERATION: 1 of 3",
      "PREVIOUS INSTRUCTION: (none — first check)",
      "ACTIVITY SINCE LAST REVIEW:",
      "assistant: I connected to the MCP server to check the supervisor path.",
      "DECISION CONTRACT: reply with a single JSON object.",
    ].join("\n");

    try {
      const outcome = await backend!.review(request(report));
      note(`decision: ${outcome.decision.action}${outcome.repaired ? " (after one repair round)" : ""}`);
      note(`raw (redacted, first 160): ${outcome.raw.slice(0, 160).replace(/\s+/g, " ")}`);
      expect(["steer", "done", "blocked"]).toContain(outcome.decision.action);
      if (outcome.decision.action === "steer") expect(outcome.decision.message?.trim().length).toBeGreaterThan(0);
      if (outcome.decision.action === "done") {
        expect(outcome.decision.criteria?.length ?? 0).toBeGreaterThan(0);
        expect(outcome.decision.criteria?.every((c) => c.evidence.trim().length > 0)).toBe(true);
      }
    } catch (error) {
      if (error instanceof SupervisorUnavailableError) {
        // The transport worked and the server answered; it simply does not speak
        // the decision contract. Record which, and prove the failure is named.
        note(`refused as ${error.kind}: ${error.message.slice(0, 240)}`);
        expect(["config", "transport", "malformed"]).toContain(error.kind);
        if (error.kind === "transport") throw error; // unreachable is a real failure
      } else {
        throw error;
      }
    }
  }, 120_000);

  it("never put credential material in the transcript", () => {
    const joined = findings.join("\n");
    expect(joined).not.toMatch(/sk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key\s*[:=]\s*\S/i);
  });
});
