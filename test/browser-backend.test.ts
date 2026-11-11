/**
 * The browser relay's decisions, against a fake page.
 *
 * These are the rules the operator actually agreed to, so they are asserted here rather
 * than left to the end-to-end path: the first instruction is the operator's own words and
 * costs zero requests; the worker's text leaves as it was written; the next instruction is
 * the marked code block; and completion follows the conversation in this thread — a confirmed
 * reply with no instruction block ends the run, while anything the adapter could not confirm
 * pauses instead of guessing. The worker's todo list is not an authority here; a live run on
 * 2026-11-09 showed what that cost. The fake adapter never contacts a browser.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserRelayBackend } from "../src/backends/browser-backend.js";
import type { BackendOutcome, SupervisorRequest } from "../src/backends/types.js";
import { SupervisorUnavailableError } from "../src/backends/types.js";
import type { BrowserTurn } from "../src/browser/client.js";
import type { AdapterAnswer, AdapterPinResult } from "../src/browser/protocol.js";
import { DEFAULT_MCP_SETTINGS, type McpSettings } from "../src/mcp/config.js";
import type { SupervisorState } from "../src/types.js";

const MARKER = "NEXT AGENT INSTRUCTION";
const SESSION = "https://www.perplexity.ai/session/abcdef";

let cwd = "";
let settings: McpSettings;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-browser-backend-"));
  settings = { ...DEFAULT_MCP_SETTINGS, relayTransport: "browser", browserSessionUrl: SESSION, instructionMarker: MARKER };
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const pinResult: AdapterPinResult = { ok: true, url: SESSION, threadNodes: 4, composerReady: true, detail: "pinned by url" };

function answer(over: Partial<AdapterAnswer> & { answerText?: string; blocks?: AdapterAnswer["blocks"] } = {}): AdapterAnswer {
  return {
    answerText: over.answerText ?? "",
    blocks: over.blocks ?? [],
    status: over.status ?? "Finished",
    distanceFromBottom: over.distanceFromBottom ?? 0,
    generating: over.generating ?? false,
    // Default confirmed, so the content tests are about content. The "adapter never confirmed"
    // and "not finished" shapes are built explicitly in the capture tests below.
    answerComplete: over.answerComplete ?? true,
    stableReads: over.stableReads ?? 4,
    turnId: over.turnId ?? "1",
  };
}

function turnFor(a: AdapterAnswer, turn = 1): BrowserTurn {
  return { answer: a, submit: { ok: true, postedText: "posted", url: SESSION, detail: "confirmed by the newest user turn" }, turn, detail: `fake turn ${turn}` };
}

const CLEAR = { pending: 0, inProgress: 0, source: "todo: 3 item(s)" };

function requestFor(over: Partial<SupervisorRequest> = {}): SupervisorRequest {
  const state = {
    active: true,
    outcome: "Make the relay forward text verbatim",
    provider: "pi",
    modelId: "worker",
    sensitivity: "balanced",
    interventions: [],
    startedAt: 0,
    turnCount: 0,
    backend: "mcp",
  } as unknown as SupervisorState;
  return { kind: "review", state, report: "a bounded redacted report", agentIsIdle: true, stagnating: false, workerText: "All green: 326 passed.", workerTodos: CLEAR, ...over };
}

/** A backend wired to a fake page, recording what it sent. */
function withPage(next: (text: string) => AdapterAnswer, options: { throws?: Error } = {}) {
  const sent: string[] = [];
  let reads = 0;
  let disconnects = 0;
  const backend = new BrowserRelayBackend({
    settings,
    cwd,
    transport: {
      send: async (text: string) => {
        if (options.throws) throw options.throws;
        sent.push(text);
        // Verbatim: callers hand back a complete AdapterAnswer. Re-filling defaults here once
        // turned an explicitly-unconfirmed answer into a confirmed one, which hid a capture-gate
        // bug from the very test meant to catch it.
        return turnFor(next(text));
      },
      read: async () => {
        // peek() must go through the same parse as a turn, so the fake answers with the
        // shape a real page would: prose plus a marked block.
        reads += 1;
        return answer({ answerText: "as-is", blocks: [marked("next")] });
      },
      pin: async () => pinResult,
      disconnect: async () => {
        disconnects += 1;
      },
    },
  });
  return { backend, sent, reads: () => reads, disconnects: () => disconnects };
}

/** One code block with the marker on its first line, as the adapter delivers it. */
const marked = (body: string) => ({ label: "text", content: `${MARKER}\n${body}` });

describe("the first instruction", () => {
  it("is the operator's own prompt, forwarded with zero requests to the chat", async () => {
    const { backend, sent, reads } = withPage(() => answer({}));
    const outcome = await backend.review(requestFor({ kind: "initial" }));

    expect(outcome.decision.action).toBe("steer");
    expect(outcome.decision.message).toBe("Make the relay forward text verbatim");
    expect(sent).toEqual([]); // nothing was sent…
    expect(reads()).toBe(0); // …and nothing was read either
    expect(outcome.terminal).toBeUndefined(); // a first instruction is not a verdict
    expect(outcome.detail).toMatch(/0 requests/);
  });

  it("refuses to invent one when the run has no goal", async () => {
    const { backend, sent } = withPage(() => answer({}));
    const request = requestFor({ kind: "initial" });
    (request.state as unknown as { outcome: string }).outcome = "   ";
    await expect(backend.review(request)).rejects.toThrow(/without a goal/);
    expect(sent).toEqual([]);
  });
});

describe("what leaves for the chat", () => {
  it("is the worker's text as it was written — no header, no notes", async () => {
    const workerText = "All green: 326 passed.\nNothing committed.";
    const { backend, sent } = withPage(() => answer({ answerText: "carry on", blocks: [marked("do the next thing")] }));
    await backend.review(requestFor({ workerText }));
    expect(sent).toEqual([workerText]);
    expect(sent[0]).not.toMatch(/Local coding agent result|extension|Additional context/i);
  });

  it("pauses rather than posting an empty message when the worker said nothing", async () => {
    const { backend, sent } = withPage(() => answer({}));
    await expect(backend.review(requestFor({ workerText: "   " }))).rejects.toThrow(SupervisorUnavailableError);
    expect(sent).toEqual([]); // an empty relay message would be a message the worker never wrote
  });
});

describe("reading the next instruction", () => {
  it("takes the marked block and ignores the other code in the reply", async () => {
    const { backend } = withPage(() =>
      answer({
        answerText: "Here is the patch and the next step.",
        blocks: [{ label: "ts", content: "function send() {}" }, marked("Refactor send() and run the gate.")],
      })
    );
    const outcome = await backend.review(requestFor());
    expect(outcome.decision.action).toBe("steer");
    expect(outcome.decision.message).toBe("Refactor send() and run the gate.");
    expect(outcome.terminal).toBeUndefined();
    expect(backend.turns).toBe(1);
  });

  it("keeps the reply verbatim as `raw`, so a later repair round sees what the page really said", async () => {
    const { backend } = withPage(() => answer({ answerText: "prose plus a block", blocks: [marked("work")] }));
    const outcome: BackendOutcome = await backend.review(requestFor());
    expect(outcome.raw).toBe("prose plus a block");
  });
});

describe("the conversation contract decides completion — and the capture gate decides that", () => {
  /** The verbatim closing reply of the 2026-11-09 live run. */
  const FINAL_REPLY =
    "The task is complete: hello.js prints Hello, World! with a trailing newline, and README.md now documents that behavior accurately. Nothing remains open.";

  it("completes on a confirmed reply that holds no instruction block", async () => {
    const { backend } = withPage(() => answer({ answerText: FINAL_REPLY, blocks: [] }));
    const outcome = await backend.review(requestFor());
    expect(outcome.decision.action).toBe("done");
    expect(outcome.terminal).toBe(true);
  });

  it("displays the reply itself rather than paraphrasing it", async () => {
    const { backend } = withPage(() => answer({ answerText: FINAL_REPLY, blocks: [] }));
    const outcome = await backend.review(requestFor());
    expect(outcome.decision.message).toBe(FINAL_REPLY);
    expect(outcome.raw).toBe(FINAL_REPLY);
  });

  it("makes no further submission once the reply has been read", async () => {
    // One send (the worker's report) and one read. Nothing is asked of the chat to confirm a
    // completion — that is how a blocked run gets sent back to work instead of ending.
    const { backend, sent, reads } = withPage(() => answer({ answerText: FINAL_REPLY, blocks: [] }));
    await backend.review(requestFor());
    // One send (the worker's report), and no extra poll to ask the chat whether it really meant
    // it. A completion is read off the reply that already arrived.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("All green: 326 passed.");
    expect(reads()).toBe(0);
  });

  it("dispatches no worker prompt: the verdict is terminal, not another instruction", async () => {
    const { backend } = withPage(() => answer({ answerText: FINAL_REPLY, blocks: [] }));
    const outcome = await backend.review(requestFor());
    expect(outcome.decision.action).toBe("done");
    // `steer` is the dispatch action; anything else carries no instruction to the worker.
    expect(outcome.decision.action).not.toBe("steer");
    expect("message" in outcome.decision ? outcome.decision.message : "").not.toMatch(/NEXT AGENT INSTRUCTION/);
  });

  it("completes when the worker has no todo tool at all — the plain pi 1.5.0 case", async () => {
    // The live run of 2026-11-09 stopped here and paused instead, on the theory that an
    // unreadable todo list was evidence of unfinished work. It is not evidence of anything: a
    // worker is not required to keep a todo list, and this mode's contract is the conversation.
    const { backend } = withPage(() => answer({ answerText: FINAL_REPLY, blocks: [] }));
    for (const workerTodos of [null, undefined, { pending: 7, inProgress: 3, source: "todo: 10 item(s)" }]) {
      const outcome = await backend.review(requestFor({ workerTodos }));
      expect(outcome.decision.action).toBe("done");
    }
  });

  it("mentions the worker's todos as information, never as the reason for finishing", async () => {
    const { backend } = withPage(() => answer({ answerText: FINAL_REPLY, blocks: [] }));
    const outcome = await backend.review(requestFor({ workerTodos: { pending: 4, inProgress: 2, source: "todo: 6 item(s)" } }));
    expect(outcome.detail).toMatch(/worker todos: 2 in progress, 4 pending \(informational\)/);
    expect(outcome.decision.reasoning).toMatch(/no block means the work is complete/);
    expect(outcome.decision.reasoning).not.toMatch(/todo/);
  });

  it("pauses when the adapter never confirmed the reply finished — the shape the live run returned", async () => {
    // Exactly the payload `/wait` produced on 2026-11-09: an answer with no code block. Under
    // the OLD rule that alone would have been "complete" had a todo list existed; under this
    // rule an unconfirmed answer is neither completion nor instruction — it is a pause.
    const unconfirmed = {
      answerText: FINAL_REPLY,
      blocks: [],
      status: "Idle",
      distanceFromBottom: 0,
      generating: false,
      stableReads: 0,
      turnId: null,
    } as AdapterAnswer;
    const { backend } = withPage(() => unconfirmed);
    await expect(backend.review(requestFor())).rejects.toThrow(/did not confirm the reply finished/);
  });

  it("pauses on an answer the adapter says is not finished", async () => {
    const { backend } = withPage(() => answer({ answerText: FINAL_REPLY, blocks: [], answerComplete: false, status: "Generating" }));
    await expect(backend.review(requestFor())).rejects.toThrow(/did not confirm the reply finished/);
  });

  it("pauses while the page is still generating, so a half-written block cannot be dispatched", async () => {
    const { backend } = withPage(() =>
      answer({
        answerText: "Working on it",
        blocks: [{ label: "text", content: `${MARKER}\nFinish the ` }],
        generating: true,
        answerComplete: false,
        status: "Generating",
      })
    );
    await expect(backend.review(requestFor())).rejects.toThrow(/still generating/);
  });

  it("pauses on an empty extraction, and says plainly that this is not a silent chat", async () => {
    // The distinction the whole safety of "no block means done" rests on.
    const { backend } = withPage(() => answer({ answerText: "", blocks: [] }));
    await expect(backend.review(requestFor())).rejects.toThrow(/NOT the same as a reply that contains no instruction block/);
  });

  it("pauses when the extraction is only invisible characters", async () => {
    // Zero-width spaces are not whitespace to String.trim, so this would otherwise read as an
    // answer — and under "no block means done" it would end a live run on nothing.
    const { backend } = withPage(() => answer({ answerText: "\u200b\ufeff  ", blocks: [] }));
    await expect(backend.review(requestFor())).rejects.toThrow(/NOT the same as a reply that contains no instruction block/);
  });

  it("never dispatches a worker prompt built from reply prose, only from the marked block", async () => {
    // Follow-up suggestions and other chrome are text, and text is never a dispatch source —
    // only a code block opening with the marker is (probe-level exclusion is tested in
    // browser-page-probe.test.ts, which runs the same function the page runs).
    const { backend } = withPage(() =>
      answer({ answerText: `All done.\nSuggested: NEXT AGENT INSTRUCTION\ntry adding tests`, blocks: [] })
    );
    const outcome = await backend.review(requestFor());
    expect(outcome.decision.action).toBe("done");
  });
});

describe("ambiguous and empty instruction blocks", () => {
  it("pauses rather than choosing between two marked blocks", async () => {
    const { backend } = withPage(() =>
      answer({
        answerText: "two candidates",
        blocks: [marked("first"), marked("second")],
      })
    );
    await expect(backend.review(requestFor())).rejects.toThrow(/2 code blocks open with the instruction marker/);
  });

  it("pauses when the marked block is empty, because an empty instruction is not an instruction", async () => {
    const { backend } = withPage(() => answer({ answerText: "Here it is:", blocks: [{ label: "text", content: `${MARKER}\n\n  \n` }] }));
    await expect(backend.review(requestFor())).rejects.toThrow(/holds nothing after the marker/);
  });

  it("pauses with a protocol kind, so the loop never asks the chat to reformat itself", async () => {
    const { backend } = withPage(() => answer({ blocks: [marked("first"), marked("second")] }));
    try {
      await backend.review(requestFor());
      expect.unreachable();
    } catch (error) {
      expect((error as SupervisorUnavailableError).kind).toBe("protocol");
    }
  });
});

describe("the seam and the teardown", () => {
  it("keeps the persisted backend id, while the label names the real pipe", () => {
    const { backend } = withPage(() => answer({}));
    expect(backend.id).toBe("mcp"); // persisted-config and session compatibility
    expect(backend.label).toMatch(/browser chat relay/);
    expect(backend.label).toMatch(/\/session\/abcdef/);
    expect(backend.label).toMatch(/marker "NEXT AGENT INSTRUCTION"/);
  });

  it("disconnects the adapter and never closes the operator's browser", async () => {
    const { backend, disconnects } = withPage(() => answer({}));
    await backend.dispose();
    expect(disconnects()).toBe(1);
  });

  it("reads the page for status without spending a turn", async () => {
    const { backend, reads, sent } = withPage(() => answer({ answerText: "as-is", blocks: [marked("next")] }));
    const peek = await backend.peek();
    expect(peek.answer.answerText).toBe("as-is");
    expect(peek.picked.kind).toBe("instruction");
    expect(reads()).toBe(1);
    expect(sent).toEqual([]);
    expect(backend.turns).toBe(0);
  });

  it("lets a transport failure surface untouched, so the loop pauses with its reason", async () => {
    const { backend } = withPage(() => answer({}), { throws: new SupervisorUnavailableError("cannot reach the browser adapter at http://127.0.0.1:8731/submit", "transport") });
    await expect(backend.review(requestFor())).rejects.toThrow(/cannot reach the browser adapter/);
  });
});
