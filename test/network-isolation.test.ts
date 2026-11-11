/**
 * The guard, attacked the way it would actually be attacked.
 *
 * The suite-wide guard (test/helpers/network-guard.ts, installed by test/setup.ts) denies
 * every outbound request unless a fake server registered that exact origin. These tests
 * exist because "allow loopback" was not a guard at all: the developer's real pplx-proxy
 * is `http://127.0.0.1:8892`, so a loopback allow-list was an allow-list for the one
 * endpoint the suite must never touch. Nothing here contacts that address — the request is
 * refused before a socket exists, which is exactly what these tests measure.
 */
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { PerplexityChat } from "../src/relay/chat.js";
import { allowOrigin, NetworkGuardError, network, originOf } from "./helpers/network-guard.js";


/** Set variables for the duration of one assertion, then restore them exactly. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The developer's live proxy. Named once, never contacted. */
const LIVE_PROXY = "http://127.0.0.1:8892";

/** A server that answers, counts its own hits, and can bounce you somewhere else. */
async function startFake(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server: Server = createServer((req, res) => {
    count++;
    const target = new URL(req.url ?? "/", "http://127.0.0.1");
    if (target.pathname === "/redirect") {
      const to = target.searchParams.get("to");
      if (!to) {
        res.writeHead(400).end("missing ?to=");
        return;
      }
      res.writeHead(302, { location: to }).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("landed");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("default deny", () => {
  it("the allow-list starts empty, so an ordinary request goes nowhere", async () => {
    expect(network.registered()).toEqual([]);
    const before = network.transportCalls();
    await expect(fetch("https://api.perplexity.ai/chat/completions")).rejects.toThrow(NetworkGuardError);
    expect(network.transportCalls()).toBe(before);
  });

  it("refuses the live proxy endpoint before the transport is reached", async () => {
    const before = network.transportCalls();
    await expect(
      fetch(`${LIVE_PROXY}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "x" }) })
    ).rejects.toThrow(/blocked by default/);
    // The proof: nothing reached the real client, so nothing could reach 127.0.0.1:8892.
    expect(network.transportCalls()).toBe(before);
    expect(network.denied()).toContain(`${LIVE_PROXY}/v1/responses`);
  });

  it("the relay itself is refused that endpoint, key or no key", async () => {
    // The exact regression that burned quota: settings lost their keys, the relay fell back
    // to the built-in default, and a test POSTed to the developer's proxy with their API key.
    // A key in the environment is not a permission: it travels with the request, and the
    // request never leaves the process. This is the regression that burned quota — settings
    // lost their keys, the relay fell back to the built-in default, and a test POSTed there.
    const chat = withEnv({ PPLX_PROXY_API_KEY: "sk-inherited-never-used" }, () =>
      new PerplexityChat(
        { baseUrl: LIVE_PROXY, apiKeyEnv: "PPLX_PROXY_API_KEY", model: "search_xsearch_pro", timeoutMs: 5000, retries: 0 },
        "pi-sup-offline"
      )
    );
    const before = network.transportCalls();
    let why = "";
    try {
      const turn = await chat.send("goal");
      why = turn.kind === "error" ? turn.message : JSON.stringify(turn).slice(0, 80);
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
    }
    expect(why).toMatch(/blocked by default/);
    expect(network.transportCalls()).toBe(before);

  });

  it("an inherited proxy URL cannot be registered as an allow-list entry", () => {
    // Inherited configuration is data. It does not, by itself, authorize live traffic.
    withEnv({ PPLX_PROXY_URL: LIVE_PROXY, PPLX_PROXY_API_KEY: "sk-inherited" }, () => {
      expect(() => allowOrigin(LIVE_PROXY)).toThrow(/refusing to register http:\/\/127\.0\.0\.1:8892/);
      expect(() => allowOrigin(`${LIVE_PROXY}/mcp/mcp`)).toThrow(NetworkGuardError);
      expect(network.registered()).toEqual([]);
    });
  });

  it("localhost and IPv6 loopback are not aliases for a registered origin", async () => {
    const fake = await startFake();
    const unregister = allowOrigin(fake.url); // http://127.0.0.1:<port> — this port, this host, only
    try {
      const before = network.transportCalls();
      // Same port, different host spelling: both refused, and neither opens a socket.
      await expect(fetch(`${fake.url.replace("127.0.0.1", "localhost")}/`)).rejects.toThrow(/blocked by default/);
      await expect(fetch(`http://[::1]:${new URL(fake.url).port}/`)).rejects.toThrow(/blocked by default/);
      expect(network.transportCalls()).toBe(before);
      expect(await (await fetch(`${fake.url}/`)).text()).toBe("landed");
    } finally {
      unregister();
      await fake.close();
    }
  });

  it("unregistering closes the door again", async () => {
    const fake = await startFake();
    const unregister = allowOrigin(fake.url);
    await fake.close(); // the port no longer exists; neither should the permission
    unregister();
    expect(network.registered()).toEqual([]);
    const before = network.transportCalls();
    await expect(fetch(`${fake.url}/`)).rejects.toThrow(/blocked by default/);
    expect(network.transportCalls()).toBe(before);
  });

  it("normalizes an origin exactly: default ports explicit, host strings verbatim", () => {
    expect(originOf("http://127.0.0.1:8892/v1/responses")).toBe("http://127.0.0.1:8892");
    expect(originOf("http://example.com/x")).toBe("http://example.com:80");
    expect(originOf("https://example.com")).toBe("https://example.com:443");
    expect(originOf("http://localhost:9")).not.toBe(originOf("http://127.0.0.1:9"));
    expect(originOf("http://[::1]:9")).not.toBe(originOf("http://127.0.0.1:9"));
  });
});

describe("a registered origin is exactly that origin", () => {
  it("a fake server answers on its registered port; a second loopback port does not", async () => {
    const a = await startFake();
    const b = await startFake(); // bound, not registered
    const unregisterA = allowOrigin(a.url);
    try {
      expect(await (await fetch(`${a.url}/`)).text()).toBe("landed");
      const before = network.transportCalls();
      await expect(fetch(`${b.url}/`)).rejects.toThrow(/blocked by default/);
      expect(network.transportCalls()).toBe(before);
      expect(b.hits()).toBe(0);
    } finally {
      unregisterA();
      await a.close();
      await b.close();
    }
  });

  it("a redirect to an unregistered origin is refused, and that origin is never contacted", async () => {
    const a = await startFake();
    const b = await startFake(); // exists, deliberately unregistered
    const unregisterA = allowOrigin(a.url);
    try {
      const before = network.transportCalls();
      await expect(fetch(`${a.url}/redirect?to=${encodeURIComponent(`${b.url}/landed`)}`)).rejects.toThrow(
        /blocked by default/
      );
      expect(network.transportCalls()).toBe(before + 1); // the hop out of `a`, and no further
      expect(b.hits()).toBe(0);
    } finally {
      unregisterA();
      await a.close();
      await b.close();
    }
  });

  it("a redirect is followed when every hop is registered, including across ports", async () => {
    const a = await startFake();
    const b = await startFake();
    const unregisterA = allowOrigin(a.url);
    const unregisterB = allowOrigin(b.url);
    try {
      const offList = await startFake(); // a third port, still unregistered
      const target = `${b.url}/landed`;
      const response = await fetch(`${a.url}/redirect?to=${encodeURIComponent(target)}`, { redirect: "follow" });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("landed");
      expect(b.hits()).toBe(1);
      expect(offList.hits()).toBe(0);
      await offList.close();
    } finally {
      unregisterA();
      unregisterB();
      await a.close();
      await b.close();
    }
  });

  it("a caller that asked for redirect: \"manual\" gets the 3xx — and the target stays untouched", async () => {
    const a = await startFake();
    const b = await startFake(); // unregistered, as before
    const unregisterA = allowOrigin(a.url);
    try {
      const before = network.transportCalls();
      const response = await fetch(`${a.url}/redirect?to=${encodeURIComponent(`${b.url}/landed`)}`, {
        redirect: "manual",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`${b.url}/landed`);
      expect(network.transportCalls()).toBe(before + 1); // only the hop to `a`
      expect(b.hits()).toBe(0);
    } finally {
      unregisterA();
      await a.close();
      await b.close();
    }
  });

  it("a Request object is guarded the same way as a url", async () => {
    const before = network.transportCalls();
    const request = new Request(`${LIVE_PROXY}/v1/responses`, { method: "POST", body: "{}" });
    await expect(fetch(request)).rejects.toThrow(/blocked by default/);
    expect(network.transportCalls()).toBe(before);
  });
});
