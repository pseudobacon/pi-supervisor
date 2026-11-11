/**
 * The browser relay's instruction contract: which code block of a rendered answer is
 * the worker's next instruction, what happens when that is undecidable, and when the
 * run may be called complete. No browser, no worker, no network — these are the rules
 * the transport is built out of, and they are the rules that were verified against the
 * live page on 2026-11-08 (rendered answers carry no markdown fences; the language
 * label arrives in a figcaption and cannot be relied on; the answer's own `code`
 * element is the only clean content).
 */
import { describe, expect, it } from "vitest";
import {
  assessCapture,
  buildBrowserResultMessage,
  DEFAULT_INSTRUCTION_MARKER,
  decideConversationCompletion,
  extractMarkedInstruction,
  isMarkerLine,
  type ReplyBlock,
} from "../src/relay/instruction.js";
import { truncateMiddle } from "../src/relay/protocol.js";

const block = (label: string, content: string): ReplyBlock => ({ label, content });

describe("isMarkerLine", () => {
  it("accepts the marker as the whole line, case-insensitively, with an optional trailing colon", () => {
    expect(isMarkerLine(DEFAULT_INSTRUCTION_MARKER, DEFAULT_INSTRUCTION_MARKER)).toBe(true);
    expect(isMarkerLine("next agent instruction", DEFAULT_INSTRUCTION_MARKER)).toBe(true);
    expect(isMarkerLine("  Next Agent Instruction:  ", DEFAULT_INSTRUCTION_MARKER)).toBe(true);
  });

  it("rejects a line that only mentions the marker inside other text", () => {
    // A coding chat explains the convention in prose all the time. That is not a verdict.
    expect(isMarkerLine("Use NEXT AGENT INSTRUCTION to mark the block", DEFAULT_INSTRUCTION_MARKER)).toBe(false);
    expect(isMarkerLine("NEXT AGENT INSTRUCTION then refactor", DEFAULT_INSTRUCTION_MARKER)).toBe(false);
    expect(isMarkerLine("", DEFAULT_INSTRUCTION_MARKER)).toBe(false);
  });

  it("refuses to match a blank marker, which would make every block a candidate", () => {
    expect(isMarkerLine("anything", "  ")).toBe(false);
  });
});

describe("extractMarkedInstruction", () => {
  it("takes the single marker block and strips only the marker line", () => {
    const picked = extractMarkedInstruction([block("text", `${DEFAULT_INSTRUCTION_MARKER}\nRefactor send() to return the posted text.\nThen run the gate.`)]);
    expect(picked).toEqual({
      kind: "instruction",
      text: "Refactor send() to return the posted text.\nThen run the gate.",
      blockIndex: 0,
      blockLabel: "text",
    });
  });

  it("picks the marker block over a decoy code block that sits first", () => {
    // The shape actually observed: a reply that shows the patch it wants written,
    // then the instruction. Language labels proved unreliable, so the marker decides.
    const picked = extractMarkedInstruction([
      block("ts", "function send() { /* the code to write */ }"),
      block("text", `${DEFAULT_INSTRUCTION_MARKER}:\nWrite that function, then run npm test.`),
    ]);
    expect(picked.kind).toBe("instruction");
    if (picked.kind !== "instruction") return;
    expect(picked.blockIndex).toBe(1);
    expect(picked.text).toBe("Write that function, then run npm test.");
  });

  it("never guesses between two marker blocks", () => {
    const picked = extractMarkedInstruction([block("text", `${DEFAULT_INSTRUCTION_MARKER}\nA`), block("text", `${DEFAULT_INSTRUCTION_MARKER}\nB`)]);
    expect(picked).toEqual({ kind: "ambiguous", candidates: [0, 1] });
  });

  it("reports no instruction when nothing is marked, including when there are no blocks at all", () => {
    expect(extractMarkedInstruction([])).toEqual({ kind: "none", blocks: 0 });
    expect(extractMarkedInstruction([block("ts", "const x = 1;")])).toEqual({ kind: "none", blocks: 1 });
    // Explaining the convention is not the same as using it.
    expect(extractMarkedInstruction([block("text", `I will put it under ${DEFAULT_INSTRUCTION_MARKER} next time.`)])).toEqual({
      kind: "none",
      blocks: 1,
    });
  });

  it("reports an empty instruction block instead of returning a blank dispatch", () => {
    expect(extractMarkedInstruction([block("text", `${DEFAULT_INSTRUCTION_MARKER}\n\n   \n`)]).kind).toBe("empty");
  });

  it("ignores a marker that is not the block's first content line", () => {
    // A block that leads with prose and ends with the marker is not the instruction
    // block; honouring it would dispatch the prose above it as an instruction.
    const picked = extractMarkedInstruction([block("text", `Some commentary first.\n${DEFAULT_INSTRUCTION_MARKER}\nDo the thing.`)]);
    expect(picked).toEqual({ kind: "none", blocks: 1 });
  });

  it("tolerates leading blank lines and CRLF, and keeps the instruction's own body intact", () => {
    const picked = extractMarkedInstruction([block("text", `\r\n\r\n${DEFAULT_INSTRUCTION_MARKER}\n\nstep one\n  step two, indented\n\nstep four\n\n`)]);
    expect(picked.kind).toBe("instruction");
    if (picked.kind !== "instruction") return;
    // Outer whitespace goes (it is an artefact of removing the marker); the body's own
    // blank lines and indentation are the instruction's and stay exactly as written.
    expect(picked.text).toBe("step one\n  step two, indented\n\nstep four");
  });
});

describe("buildBrowserResultMessage", () => {
  it("sends the worker's text as is — no header, no notes, nothing added", () => {
    const built = buildBrowserResultMessage("All green: 326 passed.\nNothing committed.", { truncate: truncateMiddle });
    expect(built.text).toBe("All green: 326 passed.\nNothing committed.");
    expect(built.text).not.toMatch(/Local coding agent result/);
    expect(built.text).not.toMatch(/extension/i);
    expect(built.omitted).toBe(0);
  });

  it("keeps a message exactly at the ceiling untouched, and says so when it does cut", () => {
    const at = "x".repeat(50);
    expect(buildBrowserResultMessage(at, { maxChars: 50, truncate: truncateMiddle })).toEqual({ text: at, omitted: 0 });

    const long = `${"head".repeat(40)} middle ${"tail".repeat(40)}`;
    const cut = buildBrowserResultMessage(long, { maxChars: 120, truncate: truncateMiddle });
    // The count is the point: the message says exactly what is missing, and the number
    // it prints is the number it reports. A tautological assertion here proves nothing.
    expect(cut.omitted).toBe(long.length - 120);
    expect(cut.text).toContain(`[[TRUNCATED: ${cut.omitted} of ${long.length} characters omitted`);
    expect(cut.text.startsWith("headhead")).toBe(true);
    expect(cut.text.endsWith("tailtail")).toBe(true);
  });

  it("passes an empty worker text through as empty rather than inventing a substitute", () => {
    // The relay's contract is the worker's own words; a placeholder would be the
    // extension putting words in the agent's mouth. The loop pauses on empty instead.
    const built = buildBrowserResultMessage("", { maxChars: 100, truncate: truncateMiddle });
    expect(built.text).toBe("");
  });
});

describe("assessCapture — a reply has to be confirmed before it can mean anything", () => {
  const confirmed = { answerText: "hi", blocks: [], generating: false, answerComplete: true, status: "Finished", stableReads: 8 };

  it("accepts a confirmed, non-empty answer", () => {
    expect(assessCapture(confirmed)).toEqual({ state: "complete", text: "hi" });
  });

  it("calls a still-generating answer incomplete", () => {
    expect(assessCapture({ ...confirmed, generating: true, status: "Generating" }).state).toBe("incomplete");
  });

  it("treats an adapter that never confirmed as unconfirmed — never as finished", () => {
    const { answerComplete: _omit, ...silent } = confirmed;
    expect(assessCapture(silent).state).toBe("incomplete");
    expect(assessCapture({ ...confirmed, answerComplete: false }).state).toBe("incomplete");
  });

  it("keeps 'no reply extracted' apart from 'a reply that contains no instruction block'", () => {
    // The distinction the operator drew, stated in the reason itself so it cannot be lost in a
    // log line: an empty extraction is a failure to read, never evidence that a chat fell silent.
    for (const answerText of ["", "   ", "\n\u200b "]) {
      const verdict = assessCapture({ ...confirmed, answerText });
      expect(verdict.state).toBe("unreadable");
      expect(verdict.state === "unreadable" && verdict.reason).toMatch(/NOT the same as a reply that contains no instruction block/);
    }
  });
});

describe("decideConversationCompletion — the conversation contract, and nothing else", () => {
  const settled = { state: "complete", text: "All done." } as const;
  const instruction = { kind: "instruction", text: "do it", blockIndex: 0, blockLabel: "text" } as const;

  it("dispatches the block it was given", () => {
    expect(decideConversationCompletion(instruction, settled)).toEqual({ action: "instruct", text: "do it" });
  });

  it("completes on a confirmed reply with no block, and returns the reply for display", () => {
    expect(decideConversationCompletion({ kind: "none", blocks: 1 }, { state: "complete", text: "  Nothing remains open.  " })).toEqual({
      action: "complete",
      reply: "Nothing remains open.",
    });
  });

  it("never completes on an answer it cannot vouch for", () => {
    for (const capture of [
      { state: "unreadable", reason: "no answer could be read" } as const,
      { state: "incomplete", reason: "the reply is still streaming" } as const,
    ]) {
      expect(decideConversationCompletion({ kind: "none", blocks: 0 }, capture)).toEqual({ action: "stalled", reason: capture.reason });
    }
  });

  it("will not dispatch from an unfinished answer either — half an instruction is worse than none", () => {
    // The capture gate comes first for exactly this case: a block read mid-stream is the first
    // half of a sentence the model had not finished writing.
    expect(decideConversationCompletion(instruction, { state: "incomplete", reason: "still generating" })).toEqual({
      action: "stalled",
      reason: "still generating",
    });
  });

  it("refuses to choose between two instruction blocks", () => {
    const verdict = decideConversationCompletion({ kind: "ambiguous", candidates: [0, 2] }, settled);
    expect(verdict.action).toBe("ambiguous");
    expect(verdict.action === "ambiguous" && verdict.reason).toContain("blocks 1, 3");
  });

  it("never dispatches an empty instruction block", () => {
    expect(decideConversationCompletion({ kind: "empty", blockIndex: 1 }, settled).action).toBe("empty");
  });
});
