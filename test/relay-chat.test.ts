/**
 * The transport for one persistent Perplexity conversation.
 *
 * `fetch` is injected, so every case here is deterministic: no sockets, no
 * retries burning wall clock, no chance of reaching the developer's live proxy.
 * What is under test is that a turn is addressed to the right conversation, that
 * a reply that cannot be delivered never becomes a worker instruction, and that
 * nothing secret leaves or comes back.
 */
import { describe, expect, it } from "vitest";
import { SupervisorUnavailableError } from "../src/backends/types.js";
import { extractResponseText, type FetchLike, newConversationId, PerplexityChat } from "../src/relay/chat.js";

const settings = { baseUrl: "http://proxy.test:8892", apiKeyEnv: "", model: "auto", timeoutMs: 1000, retries: 0 };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function recordedFetch(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

function ok(text: string, previousResponseId: string | null = null) {
  return jsonResponse({ id: "resp-1", conversation: { id: "conv" }, previous_response_id: previousResponseId, output_text: text });
}

describe("conversation identity", () => {
  it("is derived from the workspace and stable for a seed", () => {
    const a = newConversationId("/home/dev/my-project", 1234);
    expect(a).toBe(newConversationId("/home/dev/my-project/", 1234));
    expect(a.startsWith("pi-sup-my-project-")).toBe(true);
    expect(a).not.toContain("/");
    expect(a).not.toContain("home");
  });

  it("differs between runs, so a new goal cannot reuse an old conversation", () => {
    expect(newConversationId("/w/a", 1)).not.toBe(newConversationId("/w/a", 2));
    expect(newConversationId("/w/a", 1)).not.toBe(newConversationId("/w/b", 1));
  });
});

describe("sending a turn", () => {
  it("addresses the proxy's Responses API with the conversation and nothing else", async () => {
    const { fetchImpl, calls } = recordedFetch(ok("do the thing"));
    const chat = new PerplexityChat(settings, "pi-sup-run-1", fetchImpl);

    const turn = await chat.send("Goal: do the thing", new AbortController().signal);

    expect(calls[0].url).toBe("http://proxy.test:8892/v1/responses");
    expect(calls[0].body).toEqual({ model: "auto", input: "Goal: do the thing", conversation: "pi-sup-run-1", store: true });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(turn.text).toBe("do the thing");
    expect(turn.turn).toBe(1);
    expect(turn.continued).toBe(false);
    expect(turn.lostContext).toBe(false);
    expect(turn.detail).toContain("opened");
  });

  it("continues the same conversation, and notices when the proxy stopped continuing it", async () => {
    const { fetchImpl, calls } = recordedFetch(ok("first"), ok("second", "resp-1"), ok("third"));
    const chat = new PerplexityChat(settings, "pi-sup-run-1", fetchImpl);

    await chat.send("one");
    const continued = await chat.send("two");
    const expired = await chat.send("three");

    expect(calls.every((c) => c.body.conversation === "pi-sup-run-1")).toBe(true);
    expect(calls[1].body.input).toBe("two"); // only the new message goes out
    expect(continued.continued).toBe(true);
    expect(continued.detail).toContain("continued");
    expect(expired.lostContext).toBe(true); // the proxy forgot; status will say so
    expect(expired.detail).toContain("started fresh");
  });

  it("sends the bearer token from the named environment variable, and never repeats it", async () => {
    process.env.PI_RELAY_TEST_TOKEN = "sekret-token-value";
    try {
      const { fetchImpl, calls } = recordedFetch(ok("done"));
      const chat = new PerplexityChat({ ...settings, apiKeyEnv: "PI_RELAY_TEST_TOKEN" }, "c1", fetchImpl);
      const turn = await chat.send("hi");
      expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sekret-token-value");
      expect(turn.detail).not.toContain("sekret-token-value");
    } finally {
      delete process.env.PI_RELAY_TEST_TOKEN;
    }
  });

  it("redacts credential-shaped text from a reply before the worker sees it", async () => {
    const { fetchImpl } = recordedFetch(ok("Use sk-abcdefghijklmnopqrstuvwx to deploy"));
    const chat = new PerplexityChat(settings, "c1", fetchImpl);
    const turn = await chat.send("hi");
    expect(turn.text).toContain("[REDACTED sk- key]");
    expect(turn.text).not.toContain("abcdefghijklmnopqrstuvwx");
  });
});

describe("failure handling", () => {
  it("retries a transport failure and succeeds within the allowance", async () => {
    const { fetchImpl, calls } = recordedFetch(jsonResponse({ error: 1 }, 500), ok("recovered"));
    const chat = new PerplexityChat({ ...settings, retries: 1 }, "c1", fetchImpl);
    const turn = await chat.send("hi");
    expect(turn.text).toBe("recovered");
    expect(calls).toHaveLength(2);
  });

  it("does not retry a refusal, and names the environment variable to fix", async () => {
    const { fetchImpl, calls } = recordedFetch(jsonResponse({ error: { message: "no" } }, 401));
    const chat = new PerplexityChat({ ...settings, apiKeyEnv: "PPLX_PROXY_API_KEY" }, "c1", fetchImpl);
    await expect(chat.send("hi")).rejects.toMatchObject({ kind: "config", message: expect.stringContaining("PPLX_PROXY_API_KEY") });
    expect(calls).toHaveLength(1);
  });

  it("explains an expired conversation instead of pretending it continued", async () => {
    const { fetchImpl } = recordedFetch(jsonResponse({ error: { message: "gone" } }, 404));
    const chat = new PerplexityChat(settings, "pi-sup-gone-1", fetchImpl);
    await expect(chat.send("hi")).rejects.toThrow(/pi-sup-gone-1/);
  });

  it("treats a reply with no text as a failure, not an empty instruction", async () => {
    const { fetchImpl } = recordedFetch(jsonResponse({ id: "r", output_text: "  \n" }));
    const chat = new PerplexityChat(settings, "c1", fetchImpl);
    await expect(chat.send("hi")).rejects.toThrow(/no text/);
  });

  it("reports the proxy's own rejection without echoing its body", async () => {
    const { fetchImpl } = recordedFetch(jsonResponse({ error: { message: "PPLX_COOKIE is broken" } }, 400));
    const chat = new PerplexityChat(settings, "c1", fetchImpl);
    await expect(chat.send("hi")).rejects.toThrow(/rejected the request \(HTTP 400\)/);
  });

  it("gives up on a cancelled request without calling the proxy", async () => {
    const { fetchImpl, calls } = recordedFetch(ok("never"));
    const controller = new AbortController();
    controller.abort();
    const chat = new PerplexityChat(settings, "c1", fetchImpl);
    await expect(chat.send("hi", controller.signal)).rejects.toThrow(/cancelled/);
    expect(calls).toHaveLength(0);
  });

  it("aborts a hanging request at the configured timeout", async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const signal = init.signal as AbortSignal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("aborted");
    };
    const chat = new PerplexityChat({ ...settings, timeoutMs: 20, retries: 0 }, "c1", fetchImpl);
    await expect(chat.send("hi")).rejects.toThrow(/timed out after/);
  });

  it("surfaces an unreachable proxy with the URL it tried", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const chat = new PerplexityChat({ ...settings, retries: 0 }, "c1", fetchImpl);
    await expect(chat.send("hi")).rejects.toThrow(/Cannot reach pplx-proxy at http:\/\/proxy.test:8892\/v1\/responses/);
  });

  it("is a SupervisorUnavailableError so the loop pauses with a reason", async () => {
    const { fetchImpl } = recordedFetch(jsonResponse({ error: 1 }, 503));
    const chat = new PerplexityChat(settings, "c1", fetchImpl);
    const error = await chat.send("hi").catch((e) => e);
    expect(error).toBeInstanceOf(SupervisorUnavailableError);
    expect(error.kind).toBe("transport");
  });
});

describe("transport budget", () => {
  const budget = (cap: number, start = 0) => {
    let used = start;
    return { cap, used: () => used, record: () => used++ };
  };

  it("refuses the attempt over the cap locally, before the transport is touched", async () => {
    const { fetchImpl, calls } = recordedFetch(ok("one"), ok("two"), ok("three"), ok("four"));
    const chat = new PerplexityChat(settings, "c1", fetchImpl, budget(3));

    await chat.send("a");
    await chat.send("b");
    await chat.send("c");
    await expect(chat.send("d")).rejects.toThrow(/budget exhausted/);
    expect(calls).toHaveLength(3); // the fourth attempt was never sent
  });

  it("spends failures against the budget", async () => {
    const { fetchImpl, calls } = recordedFetch(new Error("ECONNREFUSED"), jsonResponse({ error: 1 }, 500), ok("up"));
    const chat = new PerplexityChat(settings, "c1", fetchImpl, budget(3));

    await expect(chat.send("a")).rejects.toThrow(/Cannot reach pplx-proxy/);
    await expect(chat.send("b")).rejects.toThrow(/HTTP 500/);
    await chat.send("c"); // the third attempt succeeds
    await expect(chat.send("d")).rejects.toThrow(/budget exhausted/);
    expect(calls).toHaveLength(3);
  });

  it("spends a timed-out attempt against the budget too", async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const signal = init.signal as AbortSignal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("aborted");
    };
    const b = budget(1);
    const chat = new PerplexityChat({ ...settings, timeoutMs: 20, retries: 0 }, "c1", fetchImpl, b);

    await expect(chat.send("hi")).rejects.toThrow(/timed out after/);
    expect(b.used()).toBe(1);
    await expect(chat.send("again")).rejects.toThrow(/budget exhausted/);
  });

  it("is not replenished when a run resumes with the counter restored", async () => {
    const { fetchImpl, calls } = recordedFetch(ok("never"));
    const chat = new PerplexityChat(settings, "c1", fetchImpl, budget(3, 3));

    await expect(chat.send("hi")).rejects.toThrow(/budget exhausted/);
    expect(calls).toHaveLength(0);
  });

  it("refuses to follow redirects", async () => {
    const { fetchImpl, calls } = recordedFetch(ok("moved"));
    const chat = new PerplexityChat(settings, "c1", fetchImpl);

    await chat.send("hi");
    expect(calls[0].init.redirect).toBe("error");
  });
});

describe("reading the answer out of the Responses payload", () => {
  it("prefers output_text", () => {
    expect(extractResponseText({ output_text: " plain " })).toBe("plain");
  });

  it("falls back to the output blocks when output_text is absent", () => {
    const payload = {
      output: [
        { type: "reasoning" },
        { type: "message", content: [{ type: "output_text", text: "first part" }, { type: "annotation" }, { type: "output_text", text: "second part" }] },
      ],
    };
    expect(extractResponseText(payload as unknown as Record<string, unknown>)).toBe("first part\nsecond part");
  });

  it("returns nothing rather than inventing an answer", () => {
    expect(extractResponseText({ output: [] })).toBe("");
    expect(extractResponseText({})).toBe("");
  });
});
