/**
 * Offline by default: a request is answered only if a test registered that exact origin.
 *
 * Why not "allow loopback": the developer's real pplx-proxy **is** loopback, at
 * `http://127.0.0.1:8892`. A guard that permits the loopback range permits the one
 * endpoint a test must never reach, and a settings regression (which really happened —
 * see HANDOFF.md) turns the suite into a quota burner. So the default is deny, and a
 * fake server opts its own allocated port in, by exact origin, for as long as it lives.
 *
 * ── What this intercepts ─────────────────────────────────────────────────────────────
 *   • `globalThis.fetch` — which covers this extension's only outbound paths:
 *       - the chat relay (`src/relay/chat.ts`, whose `fetchImpl` parameter defaults to
 *         the global `fetch`, resolved per call, so the guard is what it sees);
 *       - the MCP client: `@modelcontextprotocol/sdk` builds its transport fetch with
 *         `createFetchWithInit(baseFetch = fetch, …)` (`shared/transport.js:24`), i.e.
 *         the global, unless a caller injects its own.
 *   • Redirects are followed **by this guard**, one hop at a time, with every hop
 *     re-checked against the registry (the real fetch is called with `redirect: "manual"`).
 *     A 3xx to an unregistered origin is a denial, not a hop.
 *
 * ── What it does NOT cover (deliberately; this is not a network sandbox) ─────────────
 *   • `node:http` / `node:https` request APIs, raw `net.connect` / `tls.connect`,
 *     `dgram`, UNIX sockets, WebSocket, or any native DNS lookup. Nothing in this repo
 *     uses them as a client today — `node:http` appears only to *serve* the fakes — but
 *     if a dependency ever dials out through one of those, this guard will not notice.
 *   • Child processes (`curl`, `git`, `npm`) and any out-of-process proxying.
 *   • Injected transports. A test that passes its own `fetch` implementation (the relay
 *     and the model backend take one) never touches the network, and never touches this
 *     guard — that is the preferred pattern; sockets are the exception.
 *
 * So: a strong, documented check on the two routes this codebase actually uses, not a
 * general-purpose firewall. The endpoint assertions in the suites that do use sockets
 * (`resolveRelay(...) must equal the fake proxy`) are the second lock on that door.
 */

/** Thrown instead of performing a request. Named so tests can match on the class. */
export class NetworkGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkGuardError";
  }
}

const registrations = new Set<string>();
const attempted: string[] = [];
const denied: string[] = [];
let transportCalls = 0;

const realFetch = globalThis.fetch;
const MAX_REDIRECT_HOPS = 5;

/** The origin a request would be sent to — exact host string, explicit default port. */
export function originOf(target: string | URL | Request): string {
  const href =
    typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new NetworkGuardError(`not a usable URL, so not sending it: ${href}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NetworkGuardError(`only http(s) is allowed out of a test; refusing ${url.protocol}//${href}`);
  }
  // Hostnames are compared verbatim: `localhost` is not an alias for `127.0.0.1`, and
  // neither is an alias for `[::1]`. A registered port does not open the others.
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  return `${url.protocol}//${url.hostname}:${url.port || defaultPort}`;
}

/**
 * Origins a test may not register, because they belong to the developer's machine rather
 * than to the test: pplx-proxy's documented port, and whatever the inherited environment
 * points at. Registering one is the only way a test could reach live quota, so it takes an
 * operator-level decision (`PI_SUPERVISOR_ALLOW_LIVE_PROXY=1`), never a line of test code.
 */
function forbiddenOrigins(): Set<string> {
  const out = new Set(["http://127.0.0.1:8892", "https://127.0.0.1:8892", "http://localhost:8892", "http://[::1]:8892"]);
  for (const raw of [process.env.PPLX_PROXY_URL, process.env.PI_SUPERVISOR_LIVE_URL]) {
    if (!raw) continue;
    try {
      out.add(originOf(raw));
    } catch {
      // Not a URL we can reason about; leave it out — the default deny already covers it.
    }
  }
  return out;
}

/**
 * Register one exact origin (`http://127.0.0.1:41235`) for the lifetime of a fake server.
 * Bind first, then register — a test cannot register a port it has not actually opened.
 * Returns the un-register function; call it in cleanup.
 */
export function allowOrigin(origin: string): () => void {
  const normalized = originOf(`${origin}${origin.endsWith("/") ? "" : "/"}`);
  if (!process.env.PI_SUPERVISOR_ALLOW_LIVE_PROXY && forbiddenOrigins().has(normalized)) {
    throw new NetworkGuardError(
      `refusing to register ${normalized}: that is the developer's live proxy origin (or the one inherited ` +
        "from PPLX_PROXY_URL / PI_SUPERVISOR_LIVE_URL). A test cannot enable live access; only the operator can, " +
        "with PI_SUPERVISOR_ALLOW_LIVE_PROXY=1."
    );
  }
  registrations.add(normalized);
  return () => registrations.delete(normalized);
}

export function disallowOrigin(origin: string): void {
  registrations.delete(originOf(`${origin}/`));
}

/** Introspection for assertions. */
export const network = {
  attempts: () => attempted.slice(),
  denied: () => denied.slice(),
  /** Requests that actually reached the real transport. Must stay 0 in offline tests. */
  transportCalls: () => transportCalls,
  registered: () => [...registrations].sort(),
  reset(): void {
    registrations.clear();
    attempted.length = 0;
    denied.length = 0;
    transportCalls = 0;
  },
};

function hrefOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Install the guard over `globalThis.fetch`. Idempotent per test file. */
export function installNetworkGuard(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = hrefOf(input);

    // Normalize a Request into (url, init) once, so a later hop can be re-sent at all.
    let hopInit: RequestInit | undefined = init;
    if (input instanceof Request) {
      const body = input.body && !input.bodyUsed ? await input.clone().arrayBuffer() : undefined;
      hopInit = {
        method: input.method,
        headers: input.headers,
        credentials: input.credentials,
        mode: input.mode,
        signal: input.signal,
        redirect: input.redirect,
        ...(body === undefined ? {} : { body }),
        ...hopInit,
      };
    }

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const origin = originOf(url);
      attempted.push(url);

      if (!registrations.has(origin)) {
        denied.push(url);
        throw new NetworkGuardError(
          `blocked by default: no test registered ${origin} (attempted ${url}). ` +
            "The suite sends nothing anywhere unless a fake server bound that exact origin first; " +
            `registered origins: ${[...registrations].join(", ") || "none"}.`
        );
      }

      transportCalls++;
      // Every hop is a plain (url, init) call — a Request was normalized above.
      // `redirect` in the init wins over a Request's own value, so one path handles both.
      const response = await realFetch(url, {
        ...(hopInit as RequestInit),
        redirect: "manual",
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      // A caller that asked to see redirects itself gets the 3xx — from a registered
      // origin, and without the guard dialling the target on its behalf.
      if (!location || hopInit?.redirect === "manual") return response;

      url = new URL(location, url).href;
      if (response.status === 303) hopInit = { ...(hopInit as RequestInit), method: "GET", body: undefined };
    }

    throw new NetworkGuardError(`gave up after ${MAX_REDIRECT_HOPS} redirects from ${url}`);
  }) as typeof fetch;

  // Read by assertions that a code path must not talk to anybody.
  (globalThis as unknown as { __networkAttempts: string[] }).__networkAttempts = attempted;
}
