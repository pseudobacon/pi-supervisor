/**
 * Where the relay talks to, what it may send, and what it must never print.
 *
 * The endpoint is discovered rather than demanded, so these tests pin the order
 * and the provenance label — plus the regression that mattered most: a relay
 * setting that is silently dropped falls back to pplx-proxy's usual port, which
 * is somebody's live proxy, and a test run would spend real quota against it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpSettings, resolveMcpSettings } from "../src/mcp/config.js";
import {
  describeRelay,
  discoverRelayEndpoint,
  PROXY_DEFAULT_ORIGIN,
  relayConfigIssues,
  resolveRelay,
  stripOrigin,
} from "../src/relay/config.js";

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-relay-config-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  delete process.env.PPLX_PROXY_URL;
});

function writeConfig(mcp: Record<string, unknown>): void {
  writeFileSync(join(cwd, ".pi", "supervisor-config.json"), JSON.stringify({ backend: "mcp", mcp }, null, 2));
}

function writeMcpJson(servers: Record<string, unknown>): void {
  writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

describe("finding the proxy", () => {
  it("prefers the explicit setting and says where it came from", () => {
    writeConfig({ relayBaseUrl: "https://proxy.example:8443/mcp/mcp" });
    const endpoint = discoverRelayEndpoint(resolveMcpSettings(cwd), cwd);
    expect(endpoint).toEqual({ baseUrl: "https://proxy.example:8443", source: "supervisor-config.json" });
  });

  it("takes PPLX_PROXY_URL next, so a shell can point a session elsewhere", () => {
    process.env.PPLX_PROXY_URL = "http://10.0.0.5:8892";
    writeConfig({});
    const endpoint = discoverRelayEndpoint(resolveMcpSettings(cwd), cwd);
    expect(endpoint.baseUrl).toBe("http://10.0.0.5:8892");
    expect(endpoint.source).toBe("env PPLX_PROXY_URL");
  });

  it("reuses the origin of the proxy already configured for MCP", () => {
    writeMcpJson({ "test-relay": { url: "http://127.0.0.1:9999/mcp/mcp", enabled: true } });
    writeConfig({ server: "test-relay" });
    const endpoint = discoverRelayEndpoint(resolveMcpSettings(cwd), cwd);
    expect(endpoint).toEqual({ baseUrl: "http://127.0.0.1:9999", source: "mcp.json[test-relay]" });
  });

  it("falls back to the proxy's usual port rather than refusing to run", () => {
    writeConfig({ server: "no-such-server" }); // no entry to take an origin from
    const endpoint = discoverRelayEndpoint(resolveMcpSettings(cwd), cwd);
    expect(endpoint.baseUrl).toBe(PROXY_DEFAULT_ORIGIN);
    expect(endpoint.source).toContain("default");
  });

  it("keeps only the origin out of a URL, and rejects things that are not one", () => {
    expect(stripOrigin("http://127.0.0.1:8892/mcp/mcp")).toBe("http://127.0.0.1:8892");
    expect(stripOrigin("https://pplx.internal/v1")).toBe("https://pplx.internal");
    expect(stripOrigin("ftp://host")).toBeNull();
    expect(stripOrigin("not-an-origin")).toBeNull();
  });

  it("loads every relay setting from disk, because an unread one would silently reach the live proxy", () => {
    writeConfig({
      relayBaseUrl: "http://127.0.0.1:7777",
      relayModel: "sonnet",
      relayApiKeyEnv: "MY_TOKEN",
      relayIntroFile: ".pi/relay.md",
      maxWorkerChars: 30000,
    });
    const loaded = loadMcpSettings(cwd);
    expect(loaded.relayBaseUrl).toBe("http://127.0.0.1:7777");
    expect(loaded.relayModel).toBe("sonnet");
    expect(loaded.relayApiKeyEnv).toBe("MY_TOKEN");
    expect(loaded.relayIntroFile).toBe(".pi/relay.md");
    expect(loaded.maxWorkerChars).toBe(30000);
    expect(resolveRelay(resolveMcpSettings(cwd), cwd).endpoint.baseUrl).toBe("http://127.0.0.1:7777");
  });

  it("clamps a nonsense worker-text limit into its usable range", () => {
    writeConfig({ maxWorkerChars: 5 });
    expect(resolveRelay(resolveMcpSettings(cwd), cwd).maxWorkerChars).toBe(2000);
  });
});

describe("the intro template", () => {
  it("uses the workspace file when there is one", () => {
    writeFileSync(join(cwd, ".pi", "SUPERVISOR.RELAY.md"), "custom setup");
    expect(resolveRelay(resolveMcpSettings(cwd), cwd).introPath).toBe(join(cwd, ".pi", "SUPERVISOR.RELAY.md"));
  });

  it("honours a configured path and reports it as missing when it is", () => {
    writeConfig({ relayIntroFile: "instructions/relay.md" });
    const relay = resolveRelay(resolveMcpSettings(cwd), cwd);
    expect(relay.introPath).toBe(join(cwd, "instructions/relay.md"));
    expect(relay.introMissing).toBe(true);
    expect(relayConfigIssues(resolveMcpSettings(cwd), cwd).join(" ")).toContain("intro template was not found");
  });
});

describe("refusing to start on a broken configuration", () => {
  it("names the setting to fix", () => {
    writeConfig({ relayBaseUrl: "not-an-origin" });
    const issues = relayConfigIssues(resolveMcpSettings(cwd), cwd);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("not an http(s) origin");
    expect(issues[0]).toContain("/supervise mcp base-url");
  });

  it("says nothing when the defaults are usable", () => {
    writeConfig({});
    expect(relayConfigIssues(resolveMcpSettings(cwd), cwd)).toEqual([]);
  });
});

describe("describing the relay without exposing it", () => {
  it("shows host, model, and limits", () => {
    writeConfig({ relayBaseUrl: "http://127.0.0.1:8892", relayModel: "gpt", maxIterations: 9 });
    const text = describeRelay(resolveMcpSettings(cwd), cwd);
    expect(text).toContain("127.0.0.1:8892");
    expect(text).toContain("model gpt");
    expect(text).toContain("9 turns");
    expect(text).toContain("auth PPLX_PROXY_API_KEY unset");
  });

  it("reports that a token is set without printing it", () => {
    process.env.PI_RELAY_DESCRIBE_TEST = "sup3r-secret-token";
    try {
      writeConfig({ relayApiKeyEnv: "PI_RELAY_DESCRIBE_TEST" });
      const text = describeRelay(resolveMcpSettings(cwd), cwd);
      expect(text).toContain("auth PI_RELAY_DESCRIBE_TEST=set");
      expect(text).not.toContain("sup3r-secret-token");
    } finally {
      delete process.env.PI_RELAY_DESCRIBE_TEST;
    }
  });
});
