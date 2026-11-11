/**
 * The chat relay's protocol: the setup message, the two terminal markers, and
 * how the worker's own words are put back into the conversation. No network, no
 * model — these are the rules the relay is built out of.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROXY_QUOTA_NOTICE } from "../src/relay/chat.js";
import {
  BLOCKED_MARKER,
  buildIntroPrompt,
  buildWorkerResultMessage,
  DEFAULT_RELAY_TEMPLATE,
  DONE_MARKER,
  detectRelayMarkers,
  GOAL_PLACEHOLDER,
  loadRelayTemplate,
  relayNotes,
  truncateMiddle,
  WORKER_RESULT_HEADER,
} from "../src/relay/protocol.js";
import { REPLY_1, REPLY_2 } from "./fixtures/relay-transcript.js";

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-relay-protocol-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const path = join(cwd, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

describe("the relay setup message", () => {
  it("is configurable without touching the source", () => {
    const path = write(join(".pi", "SUPERVISOR.RELAY.md"), `Custom relay.\n${GOAL_PLACEHOLDER}`);
    const loaded = loadRelayTemplate(cwd);
    expect(loaded.path).toBe(path);
    expect(loaded.builtin).toBe(false);
    expect(loaded.template).toBe(`Custom relay.\n${GOAL_PLACEHOLDER}`);
  });

  it("falls back to the built-in when nothing is configured", () => {
    const loaded = loadRelayTemplate(cwd);
    expect(loaded.path).toBeNull();
    expect(loaded.builtin).toBe(true);
    expect(loaded.template).toBe(DEFAULT_RELAY_TEMPLATE);
  });

  it("carries everything the operator asked the setup to establish", () => {
    const prompt = buildIntroPrompt("ship the relay", DEFAULT_RELAY_TEMPLATE);
    expect(prompt).toContain("verbatim"); // replies are forwarded as written
    expect(prompt).toContain("Local coding agent result:"); // results come back
    expect(prompt).toContain("No JSON"); // ordinary prose only
    expect(prompt).toContain("already complete"); // do not restart finished stages
    expect(prompt).toContain("own tools"); // the agent has its own tools and checks
    expect(prompt).toContain("evidence"); // ask for verification
    expect(prompt).toContain(DONE_MARKER);
    expect(prompt).toContain(BLOCKED_MARKER);
    expect(prompt).toContain(`Goal:\nship the relay`); // the user's goal, unchanged
  });

  it("substitutes {{GOAL}} when a custom template asks for it, and appends otherwise", () => {
    expect(buildIntroPrompt("goal text", `Template: ${GOAL_PLACEHOLDER}`)).toBe("Template: goal text");
    expect(buildIntroPrompt("goal text", "No placeholder here")).toBe("No placeholder here\n\nGoal:\ngoal text");
  });

  it("keeps the relay semantics the loop depends on in the built-in template", () => {
    const t = DEFAULT_RELAY_TEMPLATE;
    expect(t).toContain("forwarded to it verbatim"); // replies go out as written
    expect(t).toContain('as "Local coding agent result:"'); // the exact result header
    expect(t).toMatch(/do not restart a stage that is already complete/i);
    expect(t).toMatch(/never repeat an instruction/i);
    expect(t).toMatch(/grants permission/i); // the permission gate
    expect(t).toMatch(/name the command or check/i); // evidence, not claims
    expect(t).toMatch(/final line/i); // marker placement
    expect(t).toContain(DONE_MARKER);
    expect(t).toContain(BLOCKED_MARKER);
  });
});

describe("terminal markers", () => {
  it("reads a done marker on the final line, and returns the summary without it", () => {
    const verdict = detectRelayMarkers(`Tests and lint pass in this checkout.\n\n${DONE_MARKER}\n`);
    expect(verdict.action).toBe("done");
    expect(verdict.body).toBe("Tests and lint pass in this checkout.");
  });

  it("reads a blocked marker, tolerating CRLF and trailing whitespace", () => {
    const verdict = detectRelayMarkers(`I need the staging password.\r\n${BLOCKED_MARKER}\r\n\r\n  `);
    expect(verdict.action).toBe("blocked");
    expect(verdict.body).toBe("I need the staging password.");
  });

  // The rule used to be "not terminal, so forward it as prose". That is what sent two
  // blocked verdicts to the worker on 2026-11-07. A reserved marker that cannot be a
  // verdict is a protocol violation: the reply is refused, not forwarded.
  it("refuses a marker anywhere but at the end — neither a verdict nor an instruction", () => {
    for (const text of [
      `${DONE_MARKER} belongs on the final line. Now write the test.`,
      `The rule is: end with ${DONE_MARKER}. Until then, keep working.`,
      "Add a test that mid-reply text\n```\n" + DONE_MARKER + "\n```\ncarries on as usual.",
      `${DONE_MARKER} is not a verdict when more text follows\n\nnext: run the suite`,
    ]) {
      const verdict = detectRelayMarkers(text);
      expect(verdict.action).toBe("protocol-error");
      expect(verdict.body).toBe("");
      expect(verdict.protocolError).toContain(DONE_MARKER);
    }
  });

  it("keeps the reply intact when there is no marker", () => {
    const verdict = detectRelayMarkers("  Run the suite and report the output.  \n");
    expect(verdict).toEqual({ action: "continue", body: "Run the suite and report the output.", marker: undefined });
  });
});

describe("forwarding the worker's answer", () => {
  it("puts the agent's own response first, under a stable header", () => {
    const message = buildWorkerResultMessage("I fixed the race; the suite is green.");
    expect(message).toBe(`${WORKER_RESULT_HEADER}\nI fixed the race; the suite is green.`);
  });

  it("truncates in the middle and says exactly what is missing", () => {
    const text = `${"head".repeat(100)}MIDDLE${"tail".repeat(100)}`;
    const unchanged = truncateMiddle(text, text.length);
    expect(unchanged.omitted).toBe(0);

    const { text: cut, omitted } = truncateMiddle(text, 400);
    expect(omitted).toBe(text.length - 400);
    expect(cut).toContain(`[[TRUNCATED: ${omitted} of ${text.length} characters omitted`);
    expect(cut).toContain("[[TRUNCATED");
    expect(cut.startsWith("headhead")).toBe(true);
    expect(cut.endsWith("tailtail")).toBe(true);
    expect(cut).not.toContain("MIDDLE");
  });

  it("adds extension context only for facts the agent did not report itself", () => {
    const notes = relayNotes("The suite passes.", {
      aborted: true,
      noResponse: false,
      toolErrors: ["bash reported a failure (exit 1): permission denied"],
    });
    expect(notes).toHaveLength(2);
    const message = buildWorkerResultMessage("The suite passes.", { notes });
    expect(message).toContain("Additional context from the extension (not written by the agent)");
    expect(message).toContain("interrupted before it finished");
    expect(message).toContain("bash reported a failure");
  });

  it("stays silent when the agent already said it", () => {
    const reply = "npm test failed with exit 1, so I fixed the fixture; it was interrupted once.";
    const notes = relayNotes(reply, {
      aborted: true,
      toolErrors: ["bash reported a failure (exit 1): npm test failed"],
    });
    // The failing-tool note mentions text the agent already reported; the abort
    // note is in the reply too. Nothing is duplicated.
    expect(notes.filter((n) => reply.toLowerCase().includes(n.toLowerCase()))).toEqual([]);
    expect(buildWorkerResultMessage(reply, { notes })).toBe(`${WORKER_RESULT_HEADER}\n${reply}`);
  });

  it("says so when a run produced no answer at all", () => {
    const message = buildWorkerResultMessage("", { notes: relayNotes("", { noResponse: true }) });
    expect(message).toContain("(the agent produced no final response)");
    expect(message).toContain("without producing a final response");
  });
});

/**
 * The grammar the 2026-11-07 run actually produced. Both replies in that transcript put
 * the marker at the end of a sentence of prose — not on a line of its own — with the
 * provider's quota annotation on a further line. None of it was recognised then, so two
 * blocked verdicts were dispatched to the worker as instructions.
 */
/**
 * The grammar the 2026-11-07 run actually produced. Both replies put the marker at the end
 * of a sentence of prose — not on a line of its own — with pplx-proxy's quota notice on a
 * further line (`server.py:201`, attached by `_response_suffix`). None of it was recognised
 * then, so two blocked verdicts were dispatched to the worker as instructions.
 *
 * Two layers cooperate: the transport takes the proxy's own notice off the text, and the
 * grammar here accepts only the two terminal forms. Nothing else is allowed to trail a
 * marker, so a change to the proxy's wording pauses loudly instead of quietly widening the
 * grammar to swallow whatever follows.
 */
describe("terminal markers, exactly as the transcript wrote them", () => {
  /** What the grammar sees: the wire text as it arrives, minus the proxy's notice. */
  const received = (wire: string) => detectRelayMarkers(wire.replace(PROXY_QUOTA_NOTICE, ""));

  it("the notice really is on the wire text the transcript recorded", () => {
    expect(REPLY_1).toMatch(/\[Remaining Pro Search: \d+\]$/);
    expect(REPLY_2).toMatch(/\[Remaining Pro Search: \d+\]$/);
    expect(REPLY_1.replace(PROXY_QUOTA_NOTICE, "")).not.toBe(REPLY_1);
  });

  it("reads a blocked marker appended to the end of prose", () => {
    const verdict = received(REPLY_1);
    expect(verdict.action).toBe("blocked");
    expect(verdict.marker).toBe(BLOCKED_MARKER);
    expect(verdict.body).toContain("Please provide a concise status report");
    expect(verdict.body.trimEnd().endsWith("establish progress.")).toBe(true);
    expect(verdict.body).not.toContain(BLOCKED_MARKER);
    expect(verdict.body).not.toContain("Remaining Pro Search");
  });

  it("reads the transcript's second reply the same way", () => {
    const verdict = received(REPLY_2);
    expect(verdict.action).toBe("blocked");
    expect(verdict.body).toContain("The previous run ended without a final response");
    expect(verdict.body.trimEnd().endsWith("Do not begin implementation yet.")).toBe(true);
    expect(verdict.body).not.toContain(BLOCKED_MARKER);
  });

  it("still accepts the marker alone on its final line", () => {
    const verdict = detectRelayMarkers("Both suites pass twice over.\n\n[[PPLX_DONE]]");
    expect(verdict.action).toBe("done");
    expect(verdict.body).toBe("Both suites pass twice over.");
  });

  it("removes the marker and nothing else", () => {
    const verdict = detectRelayMarkers("Line one.\n  Line two. [[PPLX_BLOCKED]]");
    expect(verdict.body).toBe("Line one.\n  Line two.");
  });

  it("refuses a marker the reply does not end with", () => {
    const verdict = detectRelayMarkers("Never write [[PPLX_DONE]] early.\nNow run the suite again.");
    expect(verdict.action).toBe("protocol-error");
    expect(verdict.body).toBe("");
    expect(verdict.protocolError).toContain(DONE_MARKER);
    expect(verdict.protocolError).toMatch(/does not end the reply/);
  });

  it("refuses a marker that only ever appeared inside a code fence", () => {
    const verdict = detectRelayMarkers("End your final reply like this:\n```\n[[PPLX_DONE]]\n```\nThen wait for the result.");
    expect(verdict.action).toBe("protocol-error");
  });

  it("refuses anything else that trails a marker — no bracket-shaped loopholes", () => {
    // The same reply shape as the transcript's, but with text the proxy would not append.
    // With the notice gone from the transport, this is what an unexpected trailer looks
    // like: a pause that says so, never an instruction.
    const verdict = detectRelayMarkers("Do [[PPLX_BLOCKED]] now\n\n[see the attached note]");
    expect(verdict.action).toBe("protocol-error");
    expect(verdict.body).toBe("");
  });

  it("passes a reply with no marker through untouched", () => {
    const text = "Re-run the suite and show the output.";
    expect(detectRelayMarkers(text)).toEqual({ action: "continue", body: text });
  });
});
