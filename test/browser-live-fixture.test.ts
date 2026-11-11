/**
 * A real reply, captured from the live browser relay on 2026-11-09, run through the real
 * parser. This exists because unit tests written from assumptions about the DOM are worth
 * less than one test written from the DOM: the first live answer arrived with the language
 * chip leaked into `answerText` ("text\n" before the prose), with label `text` rather than
 * the requested one, and with the marker alone on its first line.
 *
 * The session URL is deliberately absent — an identifier for one operator thread has no
 * business in a test fixture.
 */
import { describe, expect, it } from "vitest";
import { toReplyBlocks } from "../src/browser/protocol.js";
import { assessCapture, decideConversationCompletion, extractMarkedInstruction } from "../src/relay/instruction.js";

const MARKER = "NEXT AGENT INSTRUCTION";

/** Exactly what /wait returned: answerText carrying the chip label, blocks carrying clean code. */
const LIVE = {
  answerText:
    "text\nNEXT AGENT INSTRUCTION\nModify hello.js so that, when run with `node hello.js`, it prints exactly `Hello, World!` followed by a newline. Do not add dependencies or change README.md. After making the change, run `node hello.js` and report the exact command output.",
  blocks: [
    {
      label: "text",
      content:
        "NEXT AGENT INSTRUCTION\nModify hello.js so that, when run with `node hello.js`, it prints exactly `Hello, World!` followed by a newline. Do not add dependencies or change README.md. After making the change, run `node hello.js` and report the exact command output.",
    },
  ],
};

describe("the live reply of 2026-11-09", () => {
  const picked = extractMarkedInstruction(toReplyBlocks(LIVE as never), MARKER);

  it("finds the instruction in the block, not in the prose", () => {
    expect(picked.kind).toBe("instruction");
    if (picked.kind !== "instruction") return;
    expect(picked.text).toBe(
      "Modify hello.js so that, when run with `node hello.js`, it prints exactly `Hello, World!` followed by a newline. Do not add dependencies or change README.md. After making the change, run `node hello.js` and report the exact command output."
    );
  });

  it("drops the marker line and nothing else — the instruction keeps its backticks and its sentences", () => {
    if (picked.kind !== "instruction") return;
    expect(picked.text).not.toMatch(/NEXT AGENT INSTRUCTION/);
    expect(picked.text).toContain("`Hello, World!`");
    expect(picked.text).toContain("report the exact command output");
  });

  it("is not confused by the leaked language chip in answerText", () => {
    // The chip lands in prose, never in a block, so an instruction can never start with it.
    if (picked.kind !== "instruction") return;
    expect(picked.text.startsWith("text")).toBe(false);
  });

  it("is NOT dispatched from the historical payload, because that adapter never confirmed the reply finished", () => {
    // The payload above is verbatim from 2026-11-09, before the adapter reported
    // `answerComplete`. Handing a block to the worker from an answer whose end was never
    // confirmed is the failure mode the capture gate exists to stop, so the honest assertion
    // about THIS fixture is that it pauses. The next test covers the confirmed shape.
    const verdict = decideConversationCompletion(picked, assessCapture({ ...LIVE, generating: false, status: "Idle", stableReads: 0 }));
    expect(verdict.action).toBe("stalled");
    expect(verdict.action === "stalled" && verdict.reason).toMatch(/did not confirm the reply finished/);
  });

  it("dispatches it once the adapter confirms the reply finished — which the adapter now does", () => {
    const confirmed = { ...LIVE, generating: false, status: "Finished", stableReads: 8, answerComplete: true };
    const verdict = decideConversationCompletion(picked, assessCapture(confirmed));
    expect(verdict.action).toBe("instruct");
    if (verdict.action !== "instruct") return;
    expect(verdict.text).toContain("node hello.js");
  });

  it("dispatches it whatever the worker's todo list says, because the todo list is not a party to this contract", () => {
    // There is no ranking to test any more: todos are not an input to this decision at all.
    const confirmed = { ...LIVE, generating: false, status: "Finished", stableReads: 8, answerComplete: true };
    expect(decideConversationCompletion(picked, assessCapture(confirmed)).action).toBe("instruct");
    // And the converse half of the convention, stated in the contract's own words.
    expect(decideConversationCompletion(extractMarkedInstruction([], MARKER), { state: "complete", text: "Nothing remains open." })).toEqual({
      action: "complete",
      reply: "Nothing remains open.",
    });
  });
});
