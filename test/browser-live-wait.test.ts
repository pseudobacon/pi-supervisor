/**
 * The /wait response captured from the live adapter on 2026-11-09, fed through the real
 * validators. This file exists because that first live response was REJECTED: it carried
 * every field the relay needs except `ok`, which `parseAdapterAnswer` requires, so a
 * correctly-read answer paused the run with `adapter field "ok" is not a boolean`.
 *
 * The adapter and its contract were written separately, and the endpoint was hand-checked
 * with curl, which never validated the shape. A payload captured from the running adapter
 * and parsed by the client that will read it is the only check that catches this class.
 */
import { describe, expect, it } from "vitest";
import { parseAdapterAnswer, toReplyBlocks } from "../src/browser/protocol.js";
import { assessCapture, decideConversationCompletion, extractMarkedInstruction } from "../src/relay/instruction.js";

/** Verbatim /wait response from http://127.0.0.1:8731 (thread id removed). */
const LIVE_WAIT = {
  "ok": true,
  "answerText": "text\nNEXT AGENT INSTRUCTION\nUpdate README.md so its documentation accurately states that `node hello.js` prints `Hello, World!`. Do not change hello.js. After editing, run `node hello.js` again and report the exact output.",
  "blocks": [
    {
      "label": "text",
      "content": "NEXT AGENT INSTRUCTION\nUpdate README.md so its documentation accurately states that `node hello.js` prints `Hello, World!`. Do not change hello.js. After editing, run `node hello.js` again and report the exact output."
    }
  ],
  "status": "Idle",
  "generating": false,
  "distanceFromBottom": 237,
  "stableReads": 6,
  "turnId": "4"
};

describe("the live /wait response of 2026-11-09", () => {
  it("is accepted by the real validator — the absence of `ok` paused a run once", () => {
    const answer = parseAdapterAnswer(LIVE_WAIT as never);
    expect(answer.ok).not.toBe(false);
    expect(answer.status).toBe("Idle");
    expect(answer.generating).toBe(false);
    expect(answer.blocks.length).toBe(1);
  });

  it("still refuses a response that drops `ok`, so this cannot regress silently", () => {
    const missingOk = { ...LIVE_WAIT } as Record<string, unknown>;
    delete missingOk.ok;
    expect(() => parseAdapterAnswer(missingOk as never)).toThrow(/"ok"/);
  });

  it("holds the next instruction, exactly where the backend looks for it", () => {
    const answer = parseAdapterAnswer(LIVE_WAIT as never);
    const picked = extractMarkedInstruction(toReplyBlocks(answer), "NEXT AGENT INSTRUCTION");
    expect(picked.kind).toBe("instruction");
    if (picked.kind !== "instruction") return;
    expect(picked.text.length).toBeGreaterThan(20);
    expect(picked.text).not.toMatch(/NEXT AGENT INSTRUCTION/);
  });

  it("is refused by the capture gate as written, because this payload predates `answerComplete`", () => {
    // Verbatim history: the adapter of 2026-11-09 reported no completion signal at all. Under
    // the rule that a confirmed reply is required before anything is dispatched OR completed,
    // this response is neither — it pauses. Asserting that keeps the gate honest about the
    // payload that actually shipped, rather than quietly re-defining it as confirmed.
    const answer = parseAdapterAnswer(LIVE_WAIT as never);
    const picked = extractMarkedInstruction(toReplyBlocks(answer), "NEXT AGENT INSTRUCTION");
    const verdict = decideConversationCompletion(picked, assessCapture(answer));
    expect(verdict.action).toBe("stalled");
    expect(verdict.action === "stalled" && verdict.reason).toMatch(/did not confirm the reply finished/);
  });

  it("dispatches the moment the same response carries the confirmation the adapter now emits", () => {
    const confirmed = parseAdapterAnswer({ ...LIVE_WAIT, answerComplete: true } as never);
    expect(confirmed.answerComplete).toBe(true);
    const picked = extractMarkedInstruction(toReplyBlocks(confirmed), "NEXT AGENT INSTRUCTION");
    const capture = assessCapture(confirmed);
    expect(capture.state).toBe("complete");
    expect(decideConversationCompletion(picked, capture).action).toBe("instruct");
  });
});
