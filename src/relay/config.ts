/**
 * relay/config — where the chat relay talks to, and what it is allowed to send.
 *
 * The relay talks to pplx-proxy's own Responses API, so it needs an origin, a
 * model alias, and a token *name*. The origin is discovered rather than
 * demanded: an explicit setting wins, then PPLX_PROXY_URL, then the origin of
 * the MCP server already configured in pi's mcp.json (the same proxy process
 * serves both), then the proxy's default port. Nothing here stores a secret —
 * `relayApiKeyEnv` names an environment variable, and its value is read at
 * request time by relay/chat.ts.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

import { loadPiMcpServers, type McpSettings, pickServer } from "../mcp/config.js";
import { CONFIG_DIR, GLOBAL_AGENT_DIR, RELAY_FILE } from "./protocol.js";

export const PROXY_DEFAULT_ORIGIN = "http://127.0.0.1:8892";

export interface RelayEndpoint {
  /** Origin without a trailing slash. */
  baseUrl: string;
  /** Where that origin came from, for `/supervise status`. Never secret. */
  source: string;
}

/** Explicit setting → PPLX_PROXY_URL → the configured proxy's MCP origin → default. */
export function discoverRelayEndpoint(settings: McpSettings, cwd: string): RelayEndpoint {
  const explicit = (settings.relayBaseUrl ?? "").trim();
  if (explicit) return { baseUrl: stripOrigin(explicit) ?? explicit.replace(/\/+$/, ""), source: "supervisor-config.json" };

  const fromEnv = (process.env.PPLX_PROXY_URL ?? "").trim();
  if (fromEnv) {
    const origin = stripOrigin(fromEnv);
    if (origin) return { baseUrl: origin, source: "env PPLX_PROXY_URL" };
  }

  try {
    const server = pickServer(loadPiMcpServers(cwd), settings.server);
    const url = server?.url?.trim();
    if (url && !url.includes("${")) {
      const origin = stripOrigin(url);
      if (origin) return { baseUrl: origin, source: `mcp.json[${server?.name ?? "server"}]` };
    }
  } catch {
    // A broken mcp.json must not hide the fallback; status reports the default.
  }
  return { baseUrl: PROXY_DEFAULT_ORIGIN, source: "default (pplx-proxy's usual port)" };
}

/** `http://host:port/anything` → `http://host:port`; anything else → null. */
export function stripOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export interface ResolvedRelay {
  /** Which pipe this run uses. Defaults to the shipped proxy path. */
  transport: "proxy" | "browser";
  endpoint: RelayEndpoint;
  model: string;
  apiKeyEnv: string;
  /** Absolute path of the intro template in use, or null for the built-in. */
  introPath: string | null;
  /** True when `relayIntroFile` was configured but is not readable. */
  introMissing: boolean;
  maxWorkerChars: number;
  timeoutMs: number;
  retries: number;

  // Browser transport only. Validated in browser/protocol.ts at use time, so a bad
  // value surfaces as a visible configuration pause rather than a silent default.
  /** Loopback origin of the adapter process. */
  adapterUrl: string;
  /** Exact conversation URL to pin; empty means "target the zero-turn chat". */
  sessionUrl: string;
  /** First line of the code block carrying the worker's next instruction. */
  marker: string;
  /** How long the rendered answer must hold still before it is treated as finished. */
  stableMs: number;
  /** Ceiling on waiting for one answer. */
  maxWaitMs: number;
  /** Hard cap on Perplexity requests this run may make through the browser. */
  maxAttempts: number;
}

export function resolveRelay(settings: McpSettings, cwd: string): ResolvedRelay {
  const endpoint = discoverRelayEndpoint(settings, cwd);
  const configuredIntro = (settings.relayIntroFile ?? "").trim();
  const introPath = configuredIntro
    ? isAbsolute(configuredIntro)
      ? configuredIntro
      : resolvePath(cwd, configuredIntro)
    : [join(cwd, CONFIG_DIR, RELAY_FILE), join(GLOBAL_AGENT_DIR, RELAY_FILE)].find((p) => existsSync(p)) ?? null;
  return {
    transport: settings.relayTransport === "browser" ? "browser" : "proxy",
    endpoint,
    model: (settings.relayModel ?? "auto").trim() || "auto",
    apiKeyEnv: (settings.relayApiKeyEnv ?? "PPLX_PROXY_API_KEY").trim(),
    introPath,
    introMissing: Boolean(configuredIntro && !existsSync(introPath ?? "")),
    maxWorkerChars: settings.maxWorkerChars ?? 24_000,
    timeoutMs: settings.timeoutMs,
    // The browser transport never retries: a resend is indistinguishable from a
    // second message to a chat with no idempotency key.
    retries: settings.relayTransport === "browser" ? 0 : settings.retries,
    adapterUrl: (settings.browserAdapterUrl ?? "http://127.0.0.1:8731").trim(),
    sessionUrl: (settings.browserSessionUrl ?? "").trim(),
    marker: (settings.instructionMarker ?? "NEXT AGENT INSTRUCTION").trim() || "NEXT AGENT INSTRUCTION",
    stableMs: settings.browserStableMs ?? 8_000,
    maxWaitMs: settings.browserMaxWaitMs ?? 240_000,
    maxAttempts: settings.browserMaxAttempts ?? 12,
  };
}

/**
 * What has to be true before a run can start. Anything here stops
 * `/supervise <goal>` with a message instead of failing on the first turn.
 */
export function relayConfigIssues(settings: McpSettings, cwd: string): string[] {
  const issues: string[] = [];
  const relay = resolveRelay(settings, cwd);
  if (!stripOrigin(relay.endpoint.baseUrl)) {
    issues.push(`relay base URL "${relay.endpoint.baseUrl}" is not an http(s) origin — /supervise mcp base-url <url>`);
  }
  if (relay.introMissing) issues.push(`configured intro template was not found — /supervise mcp intro <path>`);

  if (relay.transport === "browser") {
    // These checks duplicate browser/protocol.ts's own guards so `/supervise <goal>`
    // can refuse before a worker is dispatched. The guard is still the enforcement:
    // a caller that skips this check still cannot send off-loopback.
    let adapter: URL | null = null;
    try {
      adapter = new URL(relay.adapterUrl);
    } catch {
      adapter = null;
    }
    const host = adapter?.hostname.replace(/^\[|\]$/g, "") ?? "";
    const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    if (adapter?.protocol !== "http:" || !loopback) {
      issues.push(`browser adapter URL "${relay.adapterUrl}" must be a plain http loopback origin — /supervise mcp adapter-url http://127.0.0.1:<port>`);
    }
    if (relay.sessionUrl && !/^https:\/\/(www\.)?perplexity\.ai\/session\//.test(relay.sessionUrl)) {
      issues.push(`pinned conversation "${relay.sessionUrl}" is not a perplexity.ai /session/ URL — /supervise mcp session-url <url>, or clear it to target the new chat`);
    }
    if (relay.stableMs >= relay.maxWaitMs) {
      issues.push(`stability window (${relay.stableMs}ms) must be shorter than the answer wait ceiling (${relay.maxWaitMs}ms)`);
    }
  }
  return issues;
}

/** One secret-free line for the widget, status, and notices. */
export function describeRelay(settings: McpSettings, cwd: string): string {
  const relay = resolveRelay(settings, cwd);
  if (relay.transport === "browser") {
    const target = relay.sessionUrl ? new URL(relay.sessionUrl).pathname : "the new chat";
    return `browser relay ${relay.adapterUrl.replace(/^\w+:\/\//, "")} → ${target} · marker "${relay.marker}" · ${(relay.stableMs / 1000).toFixed(1)}s stable / ${Math.round(relay.maxWaitMs / 1000)}s ceiling · max ${relay.maxAttempts} requests`;
  }
  const host = relay.endpoint.baseUrl.replace(/^\w+:\/\//, "");
  const token = relay.apiKeyEnv ? (process.env[relay.apiKeyEnv] ? `auth ${relay.apiKeyEnv}=set` : `auth ${relay.apiKeyEnv} unset`) : "no auth";
  return `${host} · model ${relay.model} · ${token} · max ${settings.maxIterations} turns · ${Math.round(
    settings.timeoutMs / 1000
  )}s timeout`;
}
