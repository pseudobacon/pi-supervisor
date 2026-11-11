/**
 * The browser transport's settings, and — the point of this file — that every one of
 * them survives the loader.
 *
 * `loadMcpSettings` rebuilds its object field by field, so a key that is not named
 * there is silently dropped and the code falls through to its default. That is not
 * hypothetical here: it is the bug that once sent a test suite's "fake proxy" to a
 * developer's live pplx-proxy and billed real Perplexity quota. For the browser
 * transport the same class of bug is worse in one direction and better in another — a
 * dropped `relayTransport` silently chooses the **proxy** path (safe, but not what was
 * configured), while a dropped `browserAdapterUrl` silently chooses the **default port**
 * (harmless only because that port is refused by the loopback guard rather than because
 * anyone was lucky). So each key is written to disk and read back, and the fall-through
 * cases are asserted too.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MCP_SETTINGS, loadMcpSettings, NUMERIC_SETTINGS } from "../src/mcp/config.js";
import { describeRelay, relayConfigIssues, resolveRelay } from "../src/relay/config.js";

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-browser-config-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeConfig(mcp: Record<string, unknown>): void {
  writeFileSync(join(cwd, ".pi", "supervisor-config.json"), JSON.stringify({ backend: "mcp", mcp }, null, 2));
}

/** Merge over the defaults the way the extension does, so assertions see real values. */
function resolve(mcp: Record<string, unknown>) {
  writeConfig(mcp);
  const merged = { ...DEFAULT_MCP_SETTINGS, ...loadMcpSettings(cwd) };
  return { loaded: loadMcpSettings(cwd), relay: resolveRelay(merged, cwd), issues: relayConfigIssues(merged, cwd) };
}

const SESSION = "https://www.perplexity.ai/session/4913f532-66e6-48f2-96cb-927dc70f5643";
const BROWSER = { relayTransport: "browser", browserAdapterUrl: "http://127.0.0.1:9911", browserSessionUrl: SESSION };

describe("the browser settings survive the loader", () => {
  it("reads every string key back from disk", () => {
    const { loaded } = resolve({ ...BROWSER, instructionMarker: "AGENT: DO THIS" });
    expect(loaded.relayTransport).toBe("browser");
    expect(loaded.browserAdapterUrl).toBe("http://127.0.0.1:9911");
    expect(loaded.browserSessionUrl).toBe(SESSION);
    expect(loaded.instructionMarker).toBe("AGENT: DO THIS");
  });

  it("reads every numeric key back, and names each one in the bounds table", () => {
    const { loaded } = resolve({ ...BROWSER, browserStableMs: 12_000, browserMaxWaitMs: 600_000, browserMaxAttempts: 5 });
    expect(loaded.browserStableMs).toBe(12_000);
    expect(loaded.browserMaxWaitMs).toBe(600_000);
    expect(loaded.browserMaxAttempts).toBe(5);
    // A numeric key that is absent from NUMERIC_SETTINGS is never read at all.
    for (const key of ["browserStableMs", "browserMaxWaitMs", "browserMaxAttempts"]) {
      expect(NUMERIC_SETTINGS[key], key).toBeDefined();
    }
  });

  it("clamps a rogue number into the range the transport can actually honour", () => {
    const { loaded } = resolve({ ...BROWSER, browserStableMs: 10_000_000, browserMaxAttempts: -4 });
    expect(loaded.browserStableMs).toBe(NUMERIC_SETTINGS.browserStableMs.max);
    expect(loaded.browserMaxAttempts).toBe(NUMERIC_SETTINGS.browserMaxAttempts.min);
  });

  it("surfaces each default rather than letting a caller invent one", () => {
    const { relay } = resolve({ relayTransport: "browser" });
    expect(relay.adapterUrl).toBe(DEFAULT_MCP_SETTINGS.browserAdapterUrl);
    expect(relay.marker).toBe(DEFAULT_MCP_SETTINGS.instructionMarker);
    expect(relay.stableMs).toBe(DEFAULT_MCP_SETTINGS.browserStableMs);
    expect(relay.maxWaitMs).toBe(DEFAULT_MCP_SETTINGS.browserMaxWaitMs);
    expect(relay.maxAttempts).toBe(DEFAULT_MCP_SETTINGS.browserMaxAttempts);
    expect(relay.sessionUrl).toBe("");
  });

  it("falls back to a non-blank marker when the configured one is whitespace", () => {
    const { relay } = resolve({ ...BROWSER, instructionMarker: "   " });
    expect(relay.marker).toBe(DEFAULT_MCP_SETTINGS.instructionMarker);
  });
});

describe("choosing the transport", () => {
  it("defaults to the proxy, and says so in the status line", () => {
    const { relay, loaded } = resolve({});
    expect(loaded.relayTransport).toBeUndefined();
    expect(relay.transport).toBe("proxy");
    const merged = { ...DEFAULT_MCP_SETTINGS, ...loaded };
    expect(describeRelay(merged, cwd)).not.toMatch(/browser/);
  });

  it("only accepts an exact value, so a typo cannot silently choose the browser write", () => {
    // "Browser", "browser ", and "broser" must NOT opt into a transport that types into
    // a live chat: the loader refuses to guess and the run stays on the proxy.
    for (const value of ["Browser", " browser", "broser", "chrome", 42, true, null]) {
      const { relay } = resolve({ relayTransport: value });
      expect(relay.transport, JSON.stringify(value)).toBe("proxy");
    }
  });

  it("forces retries to zero on the browser transport, and leaves the proxy's alone", () => {
    const browser = resolve({ ...BROWSER, retries: 2 });
    expect(browser.relay.retries).toBe(0); // a resend is a second message to the chat
    const proxy = resolve({ retries: 2 });
    expect(proxy.relay.retries).toBe(2);
  });
});

describe("refusing a browser run that cannot be safe", () => {
  it("accepts a well-formed browser configuration", () => {
    const { issues, relay } = resolve(BROWSER);
    expect(relay.transport).toBe("browser");
    expect(issues.filter((i) => /browser|adapter|conversation|stability/i.test(i))).toEqual([]);
  });

  it("refuses an adapter origin that is not plain http loopback", () => {
    for (const url of ["http://192.168.1.20:8731", "https://127.0.0.1:8731", "http://perplexity.ai", "not a url"]) {
      const { issues } = resolve({ ...BROWSER, browserAdapterUrl: url });
      expect(issues.join("\n"), url).toMatch(/loopback/);
    }
  });

  it("refuses a pinned conversation that is not a perplexity.ai /session/ url", () => {
    for (const url of ["https://example.com/session/x", "https://www.perplexity.ai/search/new/abc", "perplexity.ai/session/x"]) {
      const { issues } = resolve({ ...BROWSER, browserSessionUrl: url });
      expect(issues.join("\n"), url).toMatch(/perplexity\.ai \/session\//);
    }
    // An empty session URL is legitimate: it means the zero-turn (brand-new) chat.
    expect(resolve({ ...BROWSER, browserSessionUrl: "" }).issues.join("\n")).not.toMatch(/perplexity\.ai/);
  });

  it("refuses a stability window the answer ceiling can never satisfy", () => {
    const { issues } = resolve({ ...BROWSER, browserStableMs: 30_000, browserMaxWaitMs: 20_000 });
    expect(issues.join("\n")).toMatch(/stability window/);
  });

  it("never reports a browser problem for a proxy run", () => {
    const { issues } = resolve({ browserAdapterUrl: "http://perplexity.ai" }); // deliberately nonsense, transport is proxy
    expect(issues.join("\n")).not.toMatch(/browser adapter/);
  });
});

describe("describing the live configuration", () => {
  it("names the transport, the target thread, the marker and the two ceilings", () => {
    const { loaded } = resolve(BROWSER);
    const line = describeRelay({ ...DEFAULT_MCP_SETTINGS, ...loaded }, cwd);
    expect(line).toMatch(/^browser relay 127\.0\.0\.1:9911/);
    expect(line).toMatch(/\/session\/4913f532/);
    expect(line).toMatch(/marker "NEXT AGENT INSTRUCTION"/);
    expect(line).toMatch(/8\.0s stable \/ 240s ceiling/);
    expect(line).toMatch(/max 12 requests/);
  });

  it("says which thread a run will write into when none is pinned", () => {
    const { loaded } = resolve({ relayTransport: "browser" });
    const line = describeRelay({ ...DEFAULT_MCP_SETTINGS, ...loaded }, cwd);
    expect(line).toMatch(/→ the new chat/);
  });

  it("never leaks a token: no API-key variable appears on the browser line", () => {
    const { loaded } = resolve(BROWSER);
    const line = describeRelay({ ...DEFAULT_MCP_SETTINGS, ...loaded }, cwd);
    expect(line).not.toMatch(/PPLX_PROXY_API_KEY|Bearer|api[_-]?key/i);
  });
});
