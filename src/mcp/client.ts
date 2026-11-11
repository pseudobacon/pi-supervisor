/**
 * mcp/client — the extension-owned MCP client.
 *
 * pi's built-in MCP support hands tools to the *model* (codemode / tool_search /
 * direct exposure). The supervisor must not route its own calls through the
 * worker, and pi exposes no extension-facing "call this MCP tool" API — only
 * `registerMcpServer` / `getMcpServers`, which are for extensions that connect
 * servers themselves. So this module owns a separate connection, built on the
 * official TypeScript MCP SDK over Streamable HTTP; the protocol itself is never
 * hand-rolled.
 *
 * The SDK is imported lazily so the model backend (and `pi` itself) keeps working
 * when the dependency has not been installed in this checkout, and so tests can
 * inject a fake factory instead of speaking to a real server.
 */

export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** The tool's JSON Schema `inputSchema`, exactly as the server reported it. */
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  /** Concatenated `text` content blocks. */
  text: string;
  /** `structuredContent` when the server provided one. */
  structured?: unknown;
  /** True for MCP-level tool errors (`isError`). */
  isError: boolean;
}

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface McpConnection {
  listTools(options?: McpCallOptions): Promise<McpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>, options?: McpCallOptions): Promise<McpCallResult>;
  /** `name`/`version` reported by the server, for status output. */
  serverInfo?: { name?: string; version?: string };
  close(): Promise<void>;
}

export interface McpConnectOptions {
  url: string;
  headers: Record<string, string>;
  clientInfo: { name: string; version: string };
  requestTimeoutMs: number;
}

export type McpConnectionFactory = (options: McpConnectOptions) => Promise<McpConnection>;

/** Transport-level failure: worth retrying, unlike a tool-level error. */
export class McpTransportError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "McpTransportError";
  }
}

/** Statuses worth another attempt; mirrors what pi's own MCP client retries. */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_TEXT = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|timed? out|timeout|502|503|504|429|session (?:not found|expired)/i;

/** Classify an SDK/transport failure so the caller can retry only the transient ones. */
export function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String((error as any).code ?? "")}` : String(error ?? "");
  const status = (error as any)?.code ?? (error as any)?.status ?? (error as any)?.httpStatus;
  if (typeof status === "number" && TRANSIENT_STATUS.has(status)) return true;
  if (typeof status === "number" && status >= 400 && status < 500) return false;
  return TRANSIENT_TEXT.test(message);
}

let sdkPromise: Promise<McpConnectionFactory> | null = null;

async function loadSdkFactory(): Promise<McpConnectionFactory> {
  let sdk: any;
  let http: any;
  try {
    sdk = await import("@modelcontextprotocol/sdk/client/index.js");
    http = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  } catch (error) {
    throw new McpTransportError(
      'The MCP backend needs "@modelcontextprotocol/sdk". Run `npm install` in the pi-supervisor checkout, or keep using /supervise backend model.',
      false,
      { cause: error }
    );
  }

  return async ({ url, headers, clientInfo, requestTimeoutMs }) => {
    const parsed = new URL(url);
    const transport = new http.StreamableHTTPClientTransport(parsed, {
      requestInit: { headers },
      // The supervisor makes one call at a time; long backoff only delays the
      // pause message when the proxy is down.
      reconnectionOptions: { maxRetries: 1, initialReconnectionDelay: 200, maxReconnectionDelay: 1000 },
    });
    const client = new sdk.Client(clientInfo, { capabilities: {} });

    try {
      await client.connect(transport);
    } catch (error) {
      // McpError is exported from the SDK's types module, not this one; a failed
      // connect must not be masked by a broken instanceof against undefined.
      if ((error as { code?: unknown } | null)?.code !== undefined) throw error;
      throw new McpTransportError(`MCP connect failed: ${error instanceof Error ? error.message : String(error)}`, isTransientError(error), {
        cause: error,
      });
    }

    const serverVersion = typeof client.getServerVersion === "function" ? client.getServerVersion() : undefined;

    return {
      serverInfo: serverVersion ? { name: serverVersion.name, version: serverVersion.version } : undefined,

      async listTools(options) {
        try {
          const result = await client.listTools(undefined, { signal: options?.signal, timeout: options?.timeoutMs ?? requestTimeoutMs });
          const tools: McpToolDescriptor[] = (result.tools ?? []).map((tool: any) => ({
            name: String(tool.name),
            description: typeof tool.description === "string" ? tool.description : undefined,
            inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
          }));
          return tools;
        } catch (error) {
          throw asTransportError("tools/list", error);
        }
      },

      async callTool(name, args, options) {
        let result: any;
        try {
          result = await client.callTool(
            { name, arguments: args },
            undefined,
            { signal: options?.signal, timeout: options?.timeoutMs ?? requestTimeoutMs }
          );
        } catch (error) {
          throw asTransportError(`tools/call ${name}`, error);
        }
        const blocks = Array.isArray(result?.content) ? result.content : [];
        const text = blocks
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("\n");
        return {
          text,
          structured: result?.structuredContent,
          isError: result?.isError === true,
        };
      },

      async close() {
        try {
          await client.close();
        } catch {
          // Closing a dropped connection is not an error worth surfacing.
        }
      },
    };
  };
}

function asTransportError(what: string, error: unknown): Error {
  if (error instanceof McpTransportError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new McpTransportError(`MCP ${what} failed: ${message}`, isTransientError(error), { cause: error });
}

/** Cached, lazily loaded default factory (the official SDK). */
export async function defaultConnectionFactory(options: McpConnectOptions): Promise<McpConnection> {
  sdkPromise ??= loadSdkFactory();
  const factory = await sdkPromise;
  return factory(options);
}

/**
 * Connect with a bounded number of retries. Only transient transport failures
 * are retried; a tool error, a 4xx, or an abort surfaces immediately.
 */
export async function connectWithRetry(
  factory: McpConnectionFactory,
  options: McpConnectOptions,
  retries: number,
  signal?: AbortSignal,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = sleep
): Promise<McpConnection> {
  const attempts = Math.max(0, Math.min(3, retries));
  let lastError: unknown;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      return await factory(options);
    } catch (error) {
      lastError = error;
      const transient = error instanceof McpTransportError ? error.transient !== false : isTransientError(error);
      if (!transient || attempt === attempts || signal?.aborted) throw error;
      await wait(200 * 2 ** attempt, signal);
    }
  }
  throw lastError;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
