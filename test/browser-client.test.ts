/**
 * The browser transport's contract: the loopback guard, the adapter-reply validators,
 * and the client's attempt accounting. Nothing here opens a browser or needs a page —
 * the fake adapter is a real loopback HTTP server, bound first and then registered with
 * the suite's default-deny guard, exactly like the proxy relay's fake.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SupervisorUnavailableError } from "../src/backends/types.js";
import { BrowserChat } from "../src/browser/client.js";
import {
  assertLoopbackOrigin,
  parseAdapterAnswer,
  parseAdapterJson,
  parseAdapterPin,
  parseAdapterSubmit,
  toReplyBlocks,
} from "../src/browser/protocol.js";
import { allowOrigin, disallowOrigin, network } from "./helpers/network-guard.js";

const answerPayload = {
  ok: true,
  answerText: "Here is the patch.\n\nNEXT AGENT INSTRUCTION\nWrite it.",
  blocks: [{ label: "TEXT", content: "NEXT AGENT INSTRUCTION\nWrite it." }],
  status: "Finished",
  distanceFromBottom: 0,
  generating: false,
  stableReads: 4,
  turnId: "20",
};

describe("assertLoopbackOrigin", () => {
  it("accepts literal loopback origins and drops the trailing slash", () => {
    expect(assertLoopbackOrigin("http://127.0.0.1:8731")).toBe("http://127.0.0.1:8731");
    expect(assertLoopbackOrigin("http://localhost:8731/")).toBe("http://localhost:8731");
    expect(assertLoopbackOrigin("http://[::1]:9999")).toBe("http://[::1]:9999");
    expect(assertLoopbackOrigin("http://127.8.9.1:1")).toBe("http://127.8.9.1:1"); // any 127/8
  });

  it("refuses anything that could carry both halves of the exchange off this machine", () => {
    for (const bad of [
      "https://127.0.0.1:8731", // the adapter is plain http on loopback
      "http://perplexity.ai",
      "http://192.168.1.20:8731",
      "http://10.0.0.5:1",
      "http://localhost.localdomain:1", // resolves to loopback, resolution is not ours
      "http://127.0.0.1.nip.io:1",
      "not a url",
      "",
    ]) {
      expect(() => assertLoopbackOrigin(bad), bad).toThrow(SupervisorUnavailableError);
      try {
        assertLoopbackOrigin(bad);
      } catch (error) {
        expect((error as SupervisorUnavailableError).kind, bad).toBe("config");
      }
    }
  });

  it("refuses an origin carrying a path, because the adapter owns its routes", () => {
    expect(() => assertLoopbackOrigin("http://127.0.0.1:1/proxy")).toThrow(/without a path/);
  });
});

describe("adapter reply validation", () => {
  it("refuses non-JSON and non-object replies instead of reading undefined", () => {
    expect(() => parseAdapterJson("not json")).toThrow(/not JSON/);
    expect(() => parseAdapterJson("[1,2]")).toThrow(/not an object/);
    expect(() => parseAdapterJson("null")).toThrow(/not an object/);
  });

  it("requires every field that drives a decision", () => {
    expect(parseAdapterAnswer(answerPayload).blocks[0].label).toBe("text"); // normalised
    const { answerText: _drop, ...missing } = answerPayload;
    expect(() => parseAdapterAnswer(missing)).toThrow(/answerText/);
    expect(() => parseAdapterAnswer({ ...answerPayload, blocks: "nope" })).toThrow(/blocks/);
    expect(() => parseAdapterAnswer({ ...answerPayload, blocks: [{ label: "text" }] })).toThrow(/content/);
    expect(() => parseAdapterAnswer({ ...answerPayload, generating: "false" })).toThrow(/generating/);
  });

  it("keeps a null turnId as null rather than the string 'null'", () => {
    expect(parseAdapterAnswer({ ...answerPayload, turnId: null }).turnId).toBeNull();
    expect(parseAdapterAnswer(answerPayload).turnId).toBe("20");
  });

  it("turns an ok:false answer into an error that carries the adapter's own reason", () => {
    expect(() => parseAdapterAnswer({ ...answerPayload, ok: false, error: "no perplexity tab is open" })).toThrow(/no perplexity tab is open/);
  });

  it("states plainly that a failed submission was not retried", () => {
    try {
      parseAdapterSubmit({ ok: false, error: "the composer still holds the text" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/composer still holds the text/);
      expect((error as Error).message).toMatch(/NOT retried/);
      expect((error as SupervisorUnavailableError).kind).toBe("transport");
    }
  });

  it("requires a confirmed pin to report the url, the turn count, and the composer", () => {
    expect(parseAdapterPin({ ok: true, url: "https://www.perplexity.ai/session/x", threadNodes: 0, composerReady: true, detail: "fresh chat" }).threadNodes).toBe(0);
    expect(() => parseAdapterPin({ ok: true, url: "https://www.perplexity.ai/session/x", threadNodes: 0, composerReady: true })).toThrow(/detail/);
    expect(() => parseAdapterPin({ ok: false, error: "two perplexity tabs are open" })).toThrow(/two perplexity tabs/);
  });

  it("hands blocks to the instruction rule with labels already lower-cased", () => {
    const blocks = toReplyBlocks(parseAdapterAnswer(answerPayload));
    expect(blocks).toEqual([{ label: "text", content: "NEXT AGENT INSTRUCTION\nWrite it." }]);
  });
});

describe("BrowserChat against a fake adapter", () => {
  const settings = {
    baseUrl: "", // filled in per test from the bound port
    sessionUrl: "https://www.perplexity.ai/session/abc",
    timeoutMs: 2_000,
    stableMs: 400,
    maxWaitMs: 1_000,
  };
  const make = (overrides: Partial<typeof settings> = {}) => ({ ...settings, ...overrides });

  let server: Server;
  let origin = "";
  let unregister: (() => void) | null = null;
  let routes: string[];
  let seen: Record<string, unknown> = {};
  type Reply = { status: number; json?: unknown; raw?: string };
  let responder: (route: string, body: unknown) => Reply;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const route = req.url ?? "";
        routes.push(route);
        const name = route.replace(/^\//, "");
        const out = responder(name, raw ? JSON.parse(raw) : {});
        if (name !== "disconnect") seen[name] = raw ? JSON.parse(raw) : {};
        res.writeHead(out.status, { "content-type": "application/json" });
        // `raw` sends a body that is not JSON at all; JSON.stringify of a string is
        // perfectly valid JSON, so that is how a non-JSON reply has to be produced.
        res.end(out.raw ?? JSON.stringify(out.json));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no loopback port");
    origin = `http://127.0.0.1:${address.port}`;
    unregister = allowOrigin(origin); // bound first, then registered — the guard's required order
  });

  afterAll(async () => {
    unregister?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const submitPayload = {
    ok: true,
    postedText: "the worker's own words",
    url: "https://www.perplexity.ai/session/abc",
    detail: "confirmed by the newest user turn",
  };

  beforeEach(() => {
    routes = [];
    seen = {};
    responder = (route) => ({
      status: 200,
      json: route === "submit" ? submitPayload : route === "pin" ? { ok: true, url: "https://www.perplexity.ai/session/abc", threadNodes: 2, composerReady: true, detail: "pinned" } : answerPayload,
    });
  });

  it("refuses to build a request at all for a non-loopback origin", async () => {
    const before = network.transportCalls();
    expect(() => new BrowserChat(make({ baseUrl: "http://192.168.1.7:1" }))).toThrow(/not loopback/);
    expect(network.transportCalls()).toBe(before); // proof the refusal precedes the transport
  });

  it("refuses a pinned conversation that is not a Perplexity thread", () => {
    expect(() => new BrowserChat(make({ baseUrl: origin, sessionUrl: "https://example.com/session/x" }))).toThrow(/perplexity\.ai URL/);
    expect(() => new BrowserChat(make({ baseUrl: origin, sessionUrl: null }))).not.toThrow();
  });

  it("sends once, waits once, and reports the turn", async () => {
    const chat = new BrowserChat(make({ baseUrl: origin }));
    const turn = await chat.send("the worker's own words");

    expect(routes).toEqual(["/submit", "/wait"]); // exactly one send, one poll-to-settle
    expect(turn.turn).toBe(1);
    expect(turn.submit.detail).toBeDefined();
    expect(turn.answer.blocks[0].content).toContain("NEXT AGENT INSTRUCTION");
    expect(turn.detail).toMatch(/2 stable reads|4 stable reads/);
    expect(turn.detail).toMatch(/status Finished/);
    expect(chat.turnCount).toBe(1);
  });

  it("sends the worker's bytes as they are, with nothing added around them", async () => {
    const workerText = "verbatim ✔ 🙈\n\n  indented, and a fence:\n```ts\ncode\n```";
    responder = (route) =>
      route === "submit" ? { status: 200, json: { ...submitPayload, postedText: workerText } } : { status: 200, json: answerPayload };
    const chat = new BrowserChat(make({ baseUrl: origin }));
    const turn = await chat.send(workerText);

    // The proof is at the wire: the submit body's text is byte-identical to what the
    // worker wrote. No header, no notes, no envelope — that is the product.
    expect((seen.submit as { text: string }).text).toBe(workerText);
    // And the wait request carries only the polling knobs, never a re-send.
    expect(seen.wait).toEqual({ stableMs: 400, maxWaitMs: 1000 });
    expect(turn.submit.postedText).toBe(workerText);
  });

  it("spends the attempt budget before the submit, and refuses without sending when it is spent", async () => {
    let used = 0;
    const budget = { cap: 2, used: () => used, record: () => void used++ };

    const first = new BrowserChat(make({ baseUrl: origin }), undefined, budget);
    await first.send("a");
    expect(used).toBe(1);

    const second = new BrowserChat(make({ baseUrl: origin }), undefined, budget);
    await second.send("b");
    expect(used).toBe(2);

    routes = [];
    const third = new BrowserChat(make({ baseUrl: origin }), undefined, budget);
    await expect(third.send("c")).rejects.toThrow(/attempts are used up \(2 of 2\)/);
    expect(routes).toEqual([]); // no request was built at all
    expect(used).toBe(2); // and the budget was not pushed past the cap
  });

  it("reports a refused or failed submit as a pause, and never sends again", async () => {
    responder = (route) => (route === "submit" ? { status: 200, json: { ok: false, error: "the composer still holds the text" } } : { status: 200, json: answerPayload });
    const chat = new BrowserChat(make({ baseUrl: origin }));
    await expect(chat.send("x")).rejects.toThrow(/NOT retried/);
    expect(routes).toEqual(["/submit"]); // the /wait never ran
    expect(chat.turnCount).toBe(0);
  });

  it("treats an HTTP failure and a malformed body as transport/protocol pauses", async () => {
    responder = () => ({ status: 500, json: { detail: "adapter exploded" } });
    await expect(new BrowserChat(make({ baseUrl: origin })).send("x")).rejects.toThrow(/HTTP 500/);

    responder = () => ({ status: 200, raw: "the adapter threw a stack trace" });
    await expect(new BrowserChat(make({ baseUrl: origin })).send("x")).rejects.toThrow(/not JSON/);

    responder = () => ({ status: 200, json: ["an", "array"] });
    await expect(new BrowserChat(make({ baseUrl: origin })).send("x")).rejects.toThrow(/not an object/);
  });

  it("refuses a redirect rather than following the worker's output somewhere else", async () => {
    await new Promise<void>((resolve, reject) => {
      const redirector = createServer((_req, res) => {
        res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
        res.end();
        resolve();
      });
      redirector.listen(0, "127.0.0.1", () => {
        const addr = redirector.address();
        if (addr === null || typeof addr === "string") return reject(new Error("no port"));
        const redirectOrigin = `http://127.0.0.1:${addr.port}`;
        allowOrigin(redirectOrigin);
        new BrowserChat(make({ baseUrl: redirectOrigin }))
          .send("x")
          .then(() => reject(new Error("expected the redirect to be refused")))
          .catch((error: Error) => {
            disallowOrigin(redirectOrigin);
            redirector.close(() => resolve());
            expect(error.message).toMatch(/redirects on this transport are refused/);
          })
          .catch(reject);
      });
    });
  });

  it("passes an abort through as an abort, not as an adapter failure", async () => {
    // Cancelled work must be dropped, not reported as an unreachable adapter: stop and
    // session-switch depend on that distinction.
    const controller = new AbortController();
    controller.abort();
    const observingFetch = (url: string, init: RequestInit) =>
      init.signal?.aborted
        ? Promise.reject(new DOMException("This operation was aborted", "AbortError"))
        : Promise.reject(new Error(`unexpected request reached the transport: ${url}`));
    await expect(new BrowserChat(make({ baseUrl: origin }), observingFetch).send("x", controller.signal)).rejects.toThrow(/aborted/);
  });

  it("is covered by the suite's default-deny guard, because it speaks fetch", async () => {
    // A second loopback port, bound and deliberately left unregistered. Reaching it
    // fails the test outright, so the refusal is proven to happen before the socket.
    const probe = await new Promise<{ origin: string; close: () => Promise<void> }>((resolve, reject) => {
      const server = createServer(() => reject(new Error("an unregistered loopback adapter must never be reached")));
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr === null || typeof addr === "string") return reject(new Error("no port"));
        resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((done) => server.close(() => done())) });
      });
    });
    const before = network.transportCalls();
    await expect(new BrowserChat(make({ baseUrl: probe.origin })).send("x")).rejects.toThrow(/blocked by default/);
    expect(network.transportCalls()).toBe(before);
    await probe.close();
  });

  it("pins, reads, and disconnects without ever submitting", async () => {
    responder = (route) =>
      route === "pin"
        ? { status: 200, json: { ok: true, url: "https://www.perplexity.ai/session/abc", threadNodes: 2, composerReady: true, detail: "pinned by url" } }
        : route === "read"
          ? { status: 200, json: answerPayload }
          : { status: 200, json: { ok: true } };
    const chat = new BrowserChat(make({ baseUrl: origin }));
    const pin = await chat.pin();
    expect(pin.url).toContain("perplexity.ai");
    expect(chat.pinnedTab?.detail).toBe("pinned by url");
    const read = await chat.read();
    expect(read.status).toBe("Finished");
    await chat.disconnect();
    expect(routes).toEqual(["/pin", "/read", "/disconnect"]);
    expect(chat.turnCount).toBe(0); // reading the page is never a Perplexity turn
  });

  it("still disconnects cleanly when the adapter has gone away", async () => {
    responder = () => ({ status: 500, json: {} });
    await expect(new BrowserChat(make({ baseUrl: origin })).disconnect()).resolves.toBeUndefined();
  });
});
