/**
 * mcp/config — where the MCP supervisor gets its endpoint, tool, and limits.
 *
 * Resolution order (first hit wins), documented in README.md:
 *   1. values set this session with `/supervise mcp …`
 *   2. `mcp` section of <cwd>/.pi/supervisor-config.json
 *   3. a server entry in pi's own mcp.json (user-level, then project-level),
 *      read ONLY — this extension never writes mcp.json
 *   4. built-in defaults
 *
 * Credentials never come from, or get written to, repository files, session
 * entries, or logs. Header values may only be `${ENV_VAR}` references, which are
 * expanded at call time and dropped from every summary.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactUrl } from "../redact.js";

export interface McpSettings {
  /** Name of a server in pi's mcp.json. Ignored when `url` is set. */
  server?: string;
  /** Explicit Streamable HTTP endpoint. Wins over `server`. */
  url?: string;
  /** Selected supervisor tool, e.g. the tool that answers a single question. */
  tool?: string;
  /** Which discovered argument carries the report. Auto-detected when unset. */
  promptArg?: string;
  /** Static tool arguments (defaults / mapping), validated against the tool schema. */
  args?: Record<string, unknown>;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /** Extra attempts for transient transport failures only (0–3). */
  retries: number;
  /** Cap on supervisor iterations. */
  maxIterations: number;
  /** Wall-clock cap for one supervision run, in ms. */
  maxDurationMs: number;
  /** Hard cap on the report sent to the supervisor. */
  maxReportChars: number;
  /** Report composition. All four default on; failures survive trimming anyway. */
  sendToolCalls: boolean;
  sendToolResults: boolean;
  sendAssistantOutput: boolean;
  sendChangedFiles: boolean;

  // ---- chat relay: the pplx-proxy conversation this backend keeps open ----

  /** Proxy origin, e.g. http://127.0.0.1:8892. Discovered from mcp.json when unset. */
  relayBaseUrl?: string;
  /** Name of the env var holding the proxy bearer token. Never the token itself. */
  relayApiKeyEnv?: string;
  /** Proxy model alias for the supervisor side of the relay. */
  relayModel?: string;
  /** Intro template file. Empty means .pi/SUPERVISOR.RELAY.md, then ~/.pi/agent/. */
  relayIntroFile?: string;
  /** Cap on the worker text forwarded into the conversation per turn. */
  maxWorkerChars?: number;

  // ---- browser relay: the same loop, with the operator's browser as the pipe ----

  /**
   * Which pipe the chat relay uses. "proxy" posts to pplx-proxy's Responses API;
   * "browser" goes through the loopback adapter attached to the operator's logged-in
   * Perplexity tab. Defaults to "proxy" — the shipped behaviour.
   */
  relayTransport?: "proxy" | "browser";
  /** Loopback origin of the browser adapter process, e.g. http://127.0.0.1:8731 */
  browserAdapterUrl?: string;
  /** Exact perplexity.ai conversation URL to pin. Empty means "the new (zero-turn) chat". */
  browserSessionUrl?: string;
  /** First line of the code block that carries the worker's next instruction. */
  instructionMarker?: string;
  /** How long the rendered answer must stop changing before it counts as completed. */
  browserStableMs?: number;
  /** Ceiling on waiting for one answer; over it the run pauses rather than guessing. */
  browserMaxWaitMs?: number;
  /** Hard cap on Perplexity requests this run may make through the browser. */
  browserMaxAttempts?: number;
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  timeoutMs: 120_000,
  retries: 2,
  maxIterations: 12,
  maxDurationMs: 45 * 60_000,
  maxReportChars: 24_000,
  sendToolCalls: true,
  sendToolResults: true,
  sendAssistantOutput: true,
  sendChangedFiles: true,
  relayApiKeyEnv: "PPLX_PROXY_API_KEY",
  relayModel: "auto",
  relayIntroFile: "",
  maxWorkerChars: 24_000,
  relayTransport: "proxy",
  browserAdapterUrl: "http://127.0.0.1:8731",
  browserSessionUrl: "",
  instructionMarker: "NEXT AGENT INSTRUCTION",
  browserStableMs: 8_000,
  browserMaxWaitMs: 240_000,
  browserMaxAttempts: 12,
};

/** Numeric settings, with the bounds this extension enforces. */
export const NUMERIC_SETTINGS: Record<string, { min: number; max: number }> = {
  timeoutMs: { min: 1_000, max: 600_000 },
  retries: { min: 0, max: 3 },
  maxIterations: { min: 1, max: 100 },
  maxDurationMs: { min: 60_000, max: 24 * 60 * 60_000 },
  maxReportChars: { min: 2_000, max: 200_000 },
  maxWorkerChars: { min: 2_000, max: 90_000 },
  browserStableMs: { min: 1_500, max: 60_000 },
  browserMaxWaitMs: { min: 15_000, max: 1_800_000 },
  browserMaxAttempts: { min: 1, max: 100 },
};

export interface PiMcpServer {
  name: string;
  url?: string;
  /** Unexpanded header values, e.g. `{Authorization: "Bearer ${TOKEN}"}`. */
  headers?: Record<string, string>;
  /** Where the entry came from — "user", "project", or "extension". */
  source: string;
}

export interface ResolvedEndpoint {
  url: string;
  headers: Record<string, string>;
  /** Human-readable, secret-free provenance, e.g. `mcp.json[perplexity]`. */
  source: string;
  /** Header names whose `${VAR}` did not expand — surfaced, never the values. */
  missingEnv: string[];
}

export class McpConfigError extends Error {}

const PI_DIR = ".pi";
const AGENT_DIR = join(homedir(), ".pi", "agent");

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---- Workspace settings ---------------------------------------------------

export function loadMcpSettings(cwd: string): Partial<McpSettings> {
  const raw = readJsonFile(join(cwd, PI_DIR, "supervisor-config.json"))?.mcp;
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<McpSettings> = {};
  const strings = [
    "server",
    "url",
    "tool",
    "promptArg",
    "relayBaseUrl",
    "relayApiKeyEnv",
    "relayModel",
    "relayIntroFile",
    "browserAdapterUrl",
    "browserSessionUrl",
    "instructionMarker",
  ] as const;
  // A transport selector is not a free-form string: an unrecognised value must not
  // silently mean "browser" (which writes into a live chat) or "proxy" by accident.
  if (src.relayTransport === "proxy" || src.relayTransport === "browser") out.relayTransport = src.relayTransport;
  for (const key of strings) {
    if (typeof src[key] === "string" && src[key]) (out as any)[key] = (src[key] as string).trim();
  }
  for (const key of ["sendToolCalls", "sendToolResults", "sendAssistantOutput", "sendChangedFiles"] as const) {
    if (typeof src[key] === "boolean") (out as any)[key] = src[key];
  }
  if (src.args && typeof src.args === "object" && !Array.isArray(src.args)) out.args = { ...(src.args as Record<string, unknown>) };
  for (const key of Object.keys(NUMERIC_SETTINGS) as Array<keyof typeof NUMERIC_SETTINGS>) {
    const value = src[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      const { min, max } = NUMERIC_SETTINGS[key];
      (out as any)[key] = Math.min(max, Math.max(min, Math.round(value)));
    }
  }
  return out;
}

export function resolveMcpSettings(cwd: string, overrides?: Partial<McpSettings>): McpSettings {
  return { ...DEFAULT_MCP_SETTINGS, ...loadMcpSettings(cwd), ...stripUndefined(overrides) };
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/**
 * Merge `patch` into <cwd>/.pi/supervisor-config.json under `mcp`.
 *
 * Unrelated keys (provider/modelId, or anything a user added by hand) are kept:
 * a previous version of this file replaced the whole object.
 * Returns false when `.pi/` does not exist, matching workspace-config behaviour.
 */
export function saveMcpSettings(cwd: string, patch: Partial<McpSettings>): boolean {
  const configPath = join(cwd, PI_DIR, "supervisor-config.json");
  if (!existsSync(join(cwd, PI_DIR))) return false;
  const existing = readJsonFile(configPath) ?? {};
  const mcp = { ...((existing.mcp as object) ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "headers") continue; // never persisted — see the header policy above
    (mcp as Record<string, unknown>)[key] = value;
  }
  existing.mcp = mcp;
  writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
  return true;
}

// ---- pi's own mcp.json (read-only) ---------------------------------------

/** Expand `${VAR}` / `$VAR` in header values. Unset variables are reported by name. */
export function expandValue(value: string, missing: string[], env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/gi, (_m, a?: string, b?: string) => {
    const name = a ?? b ?? "";
    const resolved = env[name];
    if (resolved === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    return resolved;
  });
}

function toServer(name: string, entry: unknown, source: string): PiMcpServer | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const url = typeof e.url === "string" ? e.url.trim() : undefined;
  if (!url) return null; // stdio servers cannot be reached as a streamable-HTTP endpoint
  const headers: Record<string, string> = {};
  if (e.headers && typeof e.headers === "object") {
    for (const [k, v] of Object.entries(e.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
  }
  return { name, url, headers: Object.keys(headers).length ? headers : undefined, source };
}

/**
 * Servers pi itself would connect, from `~/.pi/agent/mcp.json` then
 * `<cwd>/.pi/mcp.json` (a project entry replaces the user entry of the same
 * name). Files are only read, never created or modified.
 */
export function loadPiMcpServers(cwd: string): PiMcpServer[] {
  const byName = new Map<string, PiMcpServer>();
  for (const [path, source] of [
    [join(AGENT_DIR, "mcp.json"), "user"] as const,
    [join(cwd, PI_DIR, "mcp.json"), "project"] as const,
  ]) {
    const servers = readJsonFile(path)?.mcpServers;
    if (!servers || typeof servers !== "object") continue;
    for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
      const parsed = toServer(name, entry, source);
      const enabled = (entry as Record<string, unknown>)?.enabled;
      if (parsed && enabled !== false) byName.set(name, parsed);
    }
  }
  return [...byName.values()];
}

/** Servers whose tools could plausibly answer the supervisor (streamable HTTP). */
export function pickServer(servers: PiMcpServer[], configured?: string): PiMcpServer | undefined {
  if (configured) return servers.find((s) => s.name === configured);
  if (servers.length === 1) return servers[0];
  return undefined;
}

/** Resolve the endpoint to dial, expanding environment references. */
export function resolveEndpoint(
  settings: McpSettings,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): ResolvedEndpoint {
  const missing: string[] = [];

  if (settings.url) {
    return {
      url: settings.url,
      headers: expandHeaders({}, missing, env),
      source: "configured url",
      missingEnv: missing,
    };
  }

  const servers = loadPiMcpServers(cwd);
  const server = settings.server
    ? servers.find((s) => s.name === settings.server)
    : servers.length === 1
      ? servers[0]
      : undefined;

  if (!server) {
    const names = servers.map((s) => s.name).join(", ") || "none";
    throw new McpConfigError(
      settings.server
        ? `No streamable-HTTP server "${settings.server}" in mcp.json (known: ${names}). Set one with \`pi mcp add\`, or point at a URL with /supervise mcp url <url>.`
        : `No single HTTP MCP server to use (known: ${names}). Select one with /supervise mcp server <name> or set a URL with /supervise mcp url <url>.`
    );
  }

  return {
    url: server.url as string,
    headers: expandHeaders(server.headers ?? {}, missing, env),
    source: `mcp.json[${server.name}] (${server.source})`,
    missingEnv: missing,
  };
}

function expandHeaders(headers: Record<string, string>, missing: string[], env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    // `!command` values are pi's own dynamic-header syntax; this extension does
    // not run commands, so such a header is dropped rather than sent literally.
    if (value.startsWith("!")) {
      if (!missing.includes(name)) missing.push(name);
      continue;
    }
    const expanded = expandValue(value, missing, env).trim();
    if (expanded) out[name] = expanded;
  }
  return out;
}

/** One-line, secret-free description of the active MCP configuration. */
/**
 * One-line, secret-free summary of where worker reports are going. Shown in the
 * widget, `/supervise status`, and `/supervise mcp status` — the user should see
 * the host before they start a run, not after.
 */
export function describeMcp(settings: McpSettings, cwd: string): string {
  let target = settings.url ? redactUrl(settings.url) : settings.server ? `server ${settings.server}` : "mcp.json (single HTTP server)";
  try {
    const resolved = resolveEndpoint(settings, cwd);
    const host = redactUrl(resolved.url).replace(/^\w+:\/\//, "");
    target = settings.server && !settings.url ? `server ${settings.server} → ${host}` : host;
    if (resolved.missingEnv.length) target += ` (header env not set: ${resolved.missingEnv.join(", ")})`;
  } catch {
    // Unresolvable: keep the configured description. The caller reports the error.
  }
  const tool = settings.tool ?? "(auto-select)";
  return `${target} · tool ${tool} · ${Math.round(settings.timeoutMs / 1000)}s timeout · ${settings.retries} retries · max ${settings.maxIterations} iterations`;
}
