/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal ${ENV_VAR} references are the subject of these tests */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_SETTINGS,
  describeMcp,
  expandValue,
  loadMcpSettings,
  loadPiMcpServers,
  resolveEndpoint,
  resolveMcpSettings,
  saveMcpSettings,
} from "../src/mcp/config.js";

const root = mkdtempSync(join(tmpdir(), "pi-supervisor-mcp-"));
const workspace = join(root, "project");
mkdirSync(join(workspace, ".pi"), { recursive: true });

afterAll(() => rmSync(root, { recursive: true, force: true }));

function writeProjectMcp(servers: unknown): void {
  writeFileSync(join(workspace, ".pi", "mcp.json"), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

describe("loadMcpSettings / resolveMcpSettings", () => {
  it("returns defaults when nothing is configured", () => {
    expect(loadMcpSettings(join(root, "empty"))).toEqual({});
    const resolved = resolveMcpSettings(join(root, "empty"));
    expect(resolved).toMatchObject({ timeoutMs: DEFAULT_MCP_SETTINGS.timeoutMs, retries: DEFAULT_MCP_SETTINGS.retries });
  });

  it("reads the mcp section and clamps numbers into range", () => {
    writeFileSync(
      join(workspace, ".pi", "supervisor-config.json"),
      JSON.stringify({ mcp: { server: "pplx", timeoutMs: 999_999_999, retries: 99, sendToolResults: false } })
    );
    const settings = loadMcpSettings(workspace);
    expect(settings.server).toBe("pplx");
    expect(settings.timeoutMs).toBe(600_000); // clamped, not trusted
    expect(settings.retries).toBe(3);
    expect(settings.sendToolResults).toBe(false);
    rmSync(join(workspace, ".pi", "supervisor-config.json"));
  });

  it("ignores junk types instead of writing them into the runtime", () => {
    writeFileSync(join(workspace, ".pi", "supervisor-config.json"), JSON.stringify({ mcp: { tool: 42, retries: "two" } }));
    expect(loadMcpSettings(workspace)).toEqual({});
    rmSync(join(workspace, ".pi", "supervisor-config.json"));
  });
});

describe("saveMcpSettings", () => {
  it("creates the mcp section and preserves unrelated keys", () => {
    const configPath = join(workspace, ".pi", "supervisor-config.json");
    writeFileSync(configPath, JSON.stringify({ provider: "anthropic", modelId: "claude-x", backend: "mcp" }));

    expect(saveMcpSettings(workspace, { tool: "perplexity_reason", maxIterations: 7 })).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(saved.provider).toBe("anthropic");
    expect(saved.modelId).toBe("claude-x");
    expect(saved.backend).toBe("mcp");
    expect(saved.mcp.tool).toBe("perplexity_reason");
    expect(saved.mcp.maxIterations).toBe(7);
    rmSync(configPath);
  });

  it("merges across calls rather than replacing the section", () => {
    const configPath = join(workspace, ".pi", "supervisor-config.json");
    saveMcpSettings(workspace, { server: "pplx" });
    saveMcpSettings(workspace, { tool: "perplexity_ask" });
    expect(JSON.parse(readFileSync(configPath, "utf-8")).mcp).toMatchObject({ server: "pplx", tool: "perplexity_ask" });
    rmSync(configPath);
  });

  it("never persists headers, so a key cannot end up in the repository", () => {
    const configPath = join(workspace, ".pi", "supervisor-config.json");
    saveMcpSettings(workspace, { url: "http://127.0.0.1:8892/mcp/mcp", headers: { Authorization: "Bearerhunter" } } as never);
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).not.toContain("Bearerhunter");
    expect(JSON.parse(raw).mcp.headers).toBeUndefined();
    rmSync(configPath);
  });

  it("reports failure when .pi/ does not exist instead of creating one", () => {
    expect(saveMcpSettings(join(root, "no-pi-dir"), { tool: "x" })).toBe(false);
  });
});

describe("loadPiMcpServers", () => {
  it("reads project-level mcp.json and skips stdio servers", () => {
    writeProjectMcp({
      pplx: { url: "http://127.0.0.1:8892/mcp/mcp", headers: { Authorization: "Bearer ${PPLX_KEY}" } },
      localStdio: { command: "some-mcp-server" },
      off: { url: "https://example.invalid/mcp", enabled: false },
    });
    const servers = loadPiMcpServers(workspace).filter((s) => s.name !== "perplexity"); // ignore the real user config
    expect(servers.map((s) => s.name)).toEqual(["pplx"]);
    expect(servers[0].headers?.Authorization).toBe("Bearer ${PPLX_KEY}"); // unexpanded on purpose
    rmSync(join(workspace, ".pi", "mcp.json"));
  });
});

describe("expandValue", () => {
  it("expands ${VAR} and $VAR, and reports the names it could not resolve", () => {
    const missing: string[] = [];
    const out = expandValue("Bearer ${TOKEN}", missing, { TOKEN: "abc" });
    expect(out).toBe("Bearer abc");
    expect(missing).toEqual([]);

    const missing2: string[] = [];
    expandValue("Bearer ${NOT_SET}", missing2, {});
    expect(missing2).toEqual(["NOT_SET"]);
  });
});

describe("resolveEndpoint", () => {
  it("uses an explicit url when configured", () => {
    const resolved = resolveEndpoint({ ...DEFAULT_MCP_SETTINGS, url: "http://127.0.0.1:9/mcp" }, workspace);
    expect(resolved.url).toBe("http://127.0.0.1:9/mcp");
    expect(resolved.source).toMatch(/url/);
  });

  it("resolves a named server from mcp.json and expands its headers", () => {
    writeProjectMcp({ proj: { url: "http://127.0.0.1:1111/mcp", headers: { Authorization: "Bearer ${SUP_TEST_KEY}" } } });
    const resolved = resolveEndpoint({ ...DEFAULT_MCP_SETTINGS, server: "proj" }, workspace, { SUP_TEST_KEY: "shhh" });
    expect(resolved.url).toBe("http://127.0.0.1:1111/mcp");
    expect(resolved.headers.Authorization).toBe("Bearer shhh");
    expect(resolved.source).toContain("proj");
    rmSync(join(workspace, ".pi", "mcp.json"));
  });

  it("names a missing environment variable without inventing a value", () => {
    writeProjectMcp({ proj: { url: "http://127.0.0.1:1111/mcp", headers: { Authorization: "Bearer ${ABSENT_KEY}" } } });
    const resolved = resolveEndpoint({ ...DEFAULT_MCP_SETTINGS, server: "proj" }, workspace, {});
    expect(resolved.missingEnv).toEqual(["ABSENT_KEY"]);
    expect(resolved.headers.Authorization ?? "").toMatch(/^Bearer\s*$/);
    rmSync(join(workspace, ".pi", "mcp.json"));
  });

  it("refuses to guess between two configured servers", () => {
    writeProjectMcp({
      a: { url: "http://127.0.0.1:1/mcp" },
      b: { url: "http://127.0.0.1:2/mcp" },
    });
    expect(() => resolveEndpoint(DEFAULT_MCP_SETTINGS, workspace)).toThrow(/a|b/);
    rmSync(join(workspace, ".pi", "mcp.json"));
  });

  it("refuses to invent an endpoint for a server name that does not exist", () => {
    // A stale name must not silently fall through to some other configured server.
    expect(() => resolveEndpoint({ ...DEFAULT_MCP_SETTINGS, server: "definitely-not-configured" }, workspace)).toThrow(
      /definitely-not-configured/
    );
  });
});

describe("describeMcp", () => {
  it("shows host and port, never a key", () => {
    writeProjectMcp({ proj: { url: "http://127.0.0.1:8892/mcp/mcp", headers: { Authorization: "Bearer ${SUP_TEST_SECRET}" } } });
    const label = describeMcp({ ...DEFAULT_MCP_SETTINGS, server: "proj", tool: "perplexity_reason" }, workspace);
    // Where reports go, and which variable is missing — but never a value.
    expect(label).toContain("127.0.0.1:8892");
    expect(label).toContain("perplexity_reason");
    expect(label).toContain("SUP_TEST_SECRET");
    expect(label).not.toMatch(/Bearer\s+\S{6,}/);
    rmSync(join(workspace, ".pi", "mcp.json"));
  });
});
