/**
 * backends/mcp-backend — ask a remote MCP tool to supervise.
 *
 * One call per review: connect → initialize → tools/list (cached) → tools/call →
 * close. The proxy's tools take one question string and expose no conversation
 * id, so every call re-sends the goal, the criteria, and this iteration's
 * activity — server-side memory is never assumed.
 *
 * Transport failures are retried up to `retries` times; a reply that is not a
 * valid decision gets exactly one repair round, then the loop pauses.
 */

import { decisionFromStructured, parseSupervisorReply, validateDecision } from "../decision.js";
import {
  connectWithRetry,
  defaultConnectionFactory,
  isTransientError,
  type McpConnection,
  type McpConnectionFactory,
  type McpToolDescriptor,
  McpTransportError,
  sleep,
} from "../mcp/client.js";
import {
  describeMcp,
  McpConfigError,
  type McpSettings,
  type ResolvedEndpoint,
  resolveEndpoint,
} from "../mcp/config.js";
import { assembleRepairPrompt, assembleSupervisorPrompt, loadMcpSystemPrompt } from "../mcp/prompt.js";
import { buildToolArguments, SchemaError, selectPromptArg, selectTool } from "../mcp/schema.js";
import { redactDecision, redactSecrets } from "../redact.js";
import type { BackendOutcome, SupervisorBackend, SupervisorRequest } from "./types.js";
import { SupervisorUnavailableError } from "./types.js";

/** Classify a failure so the loop pauses for the right reason, in the right words. */
function toUnavailable(error: unknown): Error {
  if (error instanceof SupervisorUnavailableError) return error;
  if (error instanceof McpConfigError) return new SupervisorUnavailableError(error.message, "config");
  if (error instanceof SchemaError) return new SupervisorUnavailableError(error.message, "config");
  if (error instanceof McpTransportError) return new SupervisorUnavailableError(error.message, "transport");
  return new SupervisorUnavailableError(error instanceof Error ? error.message : String(error), "transport");
}

export interface McpBackendOptions {
  settings: McpSettings;
  cwd: string;
  /** Injectable for tests; defaults to the official MCP SDK over Streamable HTTP. */
  connectionFactory?: McpConnectionFactory;
  /** Overrides SUPERVISOR.MCP.md discovery; used by tests. */
  systemPrompt?: string;
  clientInfo?: { name: string; version: string };
}

export interface McpDiscovery {
  endpoint: ResolvedEndpoint;
  tools: McpToolDescriptor[];
  server?: { name?: string; version?: string };
}

export class McpSupervisorBackend implements SupervisorBackend {
  readonly id = "mcp" as const;

  private tools: McpToolDescriptor[] | null = null;
  private connection: McpConnection | null = null;
  private closing = false;

  constructor(private readonly opts: McpBackendOptions) {}

  get settings(): McpSettings {
    return this.opts.settings;
  }

  get label(): string {
    return describeMcp(this.opts.settings, this.opts.cwd);
  }

  /** Connect once and report what the server actually offers. */
  async discover(signal?: AbortSignal): Promise<McpDiscovery> {
    const connection = await this.openConnection(signal);
    try {
      const tools = await connection.listTools({ signal, timeoutMs: this.opts.settings.timeoutMs });
      this.tools = tools;
      return {
        endpoint: this.endpoint(),
        tools,
        server: connection.serverInfo,
      };
    } finally {
      await this.resetConnection();
    }
  }

  async review(request: SupervisorRequest, signal?: AbortSignal): Promise<BackendOutcome> {
    const settings = this.opts.settings;
    const { prompt, source } = this.opts.systemPrompt
      ? { prompt: this.opts.systemPrompt, source: "provided" }
      : loadMcpSystemPrompt(this.opts.cwd);

    const text =
      request.kind === "repair" && request.repair
        ? assembleRepairPrompt(prompt, request.repair.raw, request.repair.summary)
        : assembleSupervisorPrompt(prompt, request.report);

    let outcome: { result: { text: string; structured?: unknown; isError: boolean }; tool: McpToolDescriptor; detail: string } | null = null;

    // Bounded retry over the whole request. Only transient transport failures
    // re-enter; a rejected tool call, a schema refusal, or an abort surfaces
    // immediately, so a decision is never asked for twice by accident.
    const attempts = Math.max(0, Math.min(3, settings.retries));
    for (let attempt = 0; ; attempt++) {
      try {
        const connection = await this.openConnection(signal);
        try {
          const tool = await this.resolveTool(connection, signal);
          const promptArg = selectPromptArg(tool, settings.promptArg);
          const args = buildToolArguments(tool, promptArg, text, settings.args ?? {}, {
            goal: request.state.outcome,
            systemPrompt: prompt,
          });
          const result = await connection.callTool(tool.name, args, { signal, timeoutMs: settings.timeoutMs });
          outcome = {
            result,
            tool,
            detail: `${tool.name} via ${this.endpoint().source}${source === "built-in prompt" ? "" : " · custom prompt"}`,
          };
        } finally {
          await this.resetConnection();
        }
        break;
      } catch (error) {
        if (signal?.aborted) throw error;
        // A transport error counts as retryable unless the client proved otherwise.
        const transient = error instanceof McpTransportError ? error.transient !== false : isTransientError(error);
        if (transient && attempt < attempts) {
          await sleep(200 * 2 ** attempt, signal);
          continue;
        }
        throw toUnavailable(error);
      }
    }



    const { result, tool, detail } = outcome;
    // Redaction rewrites text, and a supervisor instruction that quotes a command,
    // a URL, or a `key=value` pair is exactly the kind of text it can mangle. So
    // the decision is parsed from what the server actually sent; the redacted copy
    // is what gets stored, echoed back in a repair request, and shown to the user.
    const raw = redactSecrets(result.text);

    if (result.isError) {
      throw new SupervisorUnavailableError(`MCP tool "${tool.name}" reported an error: ${raw.slice(0, 500) || "(no text)"}`, "transport");
    }

    // structuredContent wins when it actually holds the decision; a server that
    // wraps its text answer in a `result` string is common, and stringifying that
    // wrapper would hide the decision from the parser entirely.
    const fromStructured = decisionFromStructured(result.structured);
    const validated = fromStructured ? validateDecision(fromStructured, false) : parseSupervisorReply(result.text);

    if (!validated.ok) {
      if (request.kind !== "repair") {
        // One repair round, asked of the same tool. A second bad reply pauses
        // the run — the loop never guesses at what the supervisor meant.
        const repaired = await this.review({ ...request, kind: "repair", repair: { raw, summary: validated.summary } }, signal);
        return { ...repaired, repaired: true };
      }
      throw new SupervisorUnavailableError(
        `Supervisor reply was not usable (${validated.summary}). It said: ${raw.slice(0, 300) || "(empty)"}`,
        "malformed"
      );
    }

    return { decision: redactDecision(validated.decision), raw, detail, repaired: request.kind === "repair" };
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await this.resetConnection();
  }

  // ---- internals ----

  private endpoint(): ResolvedEndpoint {
    return resolveEndpoint(this.opts.settings, this.opts.cwd);
  }

  private async openConnection(signal?: AbortSignal): Promise<McpConnection> {
    if (this.closing) throw new SupervisorUnavailableError("MCP backend is closed", "config");
    const endpoint = this.endpoint();
    const connection = await connectWithRetry(
      this.opts.connectionFactory ?? defaultConnectionFactory,
      {
        url: endpoint.url,
        headers: endpoint.headers,
        clientInfo: this.opts.clientInfo ?? { name: "pi-supervisor", version: "0.6.0" },
        requestTimeoutMs: this.opts.settings.timeoutMs,
      },
      this.opts.settings.retries,
      signal
    );
    this.connection = connection;
    return connection;
  }

  private async resolveTool(connection: McpConnection, signal?: AbortSignal): Promise<McpToolDescriptor> {
    if (!this.tools) this.tools = await connection.listTools({ signal, timeoutMs: this.opts.settings.timeoutMs });
    return selectTool(this.tools, this.opts.settings.tool).tool;
  }

  private async resetConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection) await connection.close();
  }
}
