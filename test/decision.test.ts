import { describe, expect, it } from "vitest";
import { buildRepairPrompt, decisionFromStructured, parseDecision, parseSupervisorReply, readDecisionObject, safeContinue, validateDecision } from "../src/decision.js";

const DONE_WITH_EVIDENCE = {
  action: "done",
  reasoning: "all checks pass",
  criteria: [{ criterion: "npm test passes", evidence: "npm test → 57 passed (57)", met: true }],
  unresolved: [],
};

describe("readDecisionObject", () => {
  it("reads a bare JSON object", () => {
    expect(readDecisionObject('{"action":"done"}')).toEqual({ action: "done" });
  });

  it("reads JSON inside a code fence or around prose", () => {
    expect(readDecisionObject('Sure!\n```json\n{"action":"steer","instruction":"run tests"}\n```')).toMatchObject({
      action: "steer",
      instruction: "run tests",
    });
    expect(readDecisionObject('Thinking… {"action":"steer","instruction":"x"} hope that helps')).toMatchObject({ action: "steer" });
  });

  it("returns null for prose with no object", () => {
    expect(readDecisionObject("the worker is doing fine")).toBeNull();
  });

  it("tolerates a trailing comma rather than rejecting the whole reply", () => {
    expect(readDecisionObject('{"action":"steer","instruction":"x",}')).toMatchObject({ action: "steer" });
  });

  it("prefers the object that names an action when a reply carries several", () => {
    const text = '{"action":"steer","instruction":"run npm test","reasoning":"r"} {"usage":{"remaining":115}}';
    expect(readDecisionObject(text)).toMatchObject({ action: "steer", instruction: "run npm test" });
  });

  it("does not let a fenced example earlier in the reply hide the real decision", () => {
    const text = 'example:\n```json\n{"action":"done"}\n```\nmy answer: {"action":"steer","instruction":"check the log","reasoning":"r"}';
    expect(readDecisionObject(text)).toMatchObject({ action: "steer" });
  });

  it("splits sibling objects without splitting on braces inside strings", () => {
    const text = '{"action":"steer","instruction":"use { printf \\"}\\" }","reasoning":"r"}';
    expect(readDecisionObject(text)).toMatchObject({ action: "steer" });
  });
});

describe("decisionFromStructured", () => {
  it("takes a decision returned as an object", () => {
    expect(decisionFromStructured({ action: "blocked", blocker: "no credentials" })).toMatchObject({ action: "blocked" });
  });

  it("unwraps the common {result: \"<decision json>\"} wrapper", () => {
    const wrapper = { result: '{"action":"steer","instruction":"run npm test","reasoning":"r"}' };
    expect(decisionFromStructured(wrapper)).toMatchObject({ action: "steer", instruction: "run npm test" });
  });

  it("returns null rather than inventing a decision out of unrelated data", () => {
    expect(decisionFromStructured({ models: ["a", "b"], count: 2 })).toBeNull();
    expect(decisionFromStructured(undefined)).toBeNull();
    expect(decisionFromStructured("plain prose, no json")).toBeNull();
  });
});

describe("parseDecision (model backend, tolerant)", () => {
  it("maps steer/done/blocked/continue and keeps the message", () => {
    expect(parseDecision('{"action":"steer","instruction":"add a test","reasoning":"no coverage"}')).toMatchObject({
      action: "steer",
      message: "add a test",
      reasoning: "no coverage",
    });
    expect(parseDecision('{"action":"keep going"}').action).toBe("continue");
  });

  it("falls back to continue when nothing parses", () => {
    expect(parseDecision("nonsense")).toMatchObject({ action: "continue" });
  });

  it("reads acceptance criteria from the first reply", () => {
    const decision = parseDecision('{"action":"steer","instruction":"go","acceptanceCriteria":["a","b"]}');
    expect(decision.acceptanceCriteria).toEqual(["a", "b"]);
  });
});

describe("validateDecision (MCP loop, strict)", () => {
  it("accepts a steer with a non-empty instruction", () => {
    const result = validateDecision({ action: "steer", instruction: "run npm test", reasoning: "no evidence yet" });
    expect(result.ok).toBe(true);
    expect(result.decision.message).toBe("run npm test");
  });

  it("rejects a steer whose instruction is empty or whitespace", () => {
    expect(validateDecision({ action: "steer", instruction: "   " }).problems).toContain("missing-instruction");
    expect(validateDecision({ action: "steer" }).problems).toContain("missing-instruction");
  });

  it('rejects "continue" — it cannot advance an idle run', () => {
    const strict = validateDecision({ action: "continue" });
    expect(strict.ok).toBe(false);
    expect(strict.problems).toContain("invalid-action");
    // …while the model backend still accepts it
    expect(validateDecision({ action: "continue" }, true).ok).toBe(true);
  });

  it("rejects an unknown action", () => {
    expect(validateDecision({ action: "retry_later" }).problems).toContain("invalid-action");
  });

  it("accepts done only with met criteria, concrete evidence, and no unresolved failures", () => {
    expect(validateDecision(DONE_WITH_EVIDENCE).ok).toBe(true);
  });

  it("rejects done with no criteria assessment", () => {
    expect(validateDecision({ action: "done", reasoning: "looks good" }).problems).toContain("invalid-criteria");
  });

  it("rejects done with a criterion that has no evidence", () => {
    const result = validateDecision({
      action: "done",
      criteria: [{ criterion: "tests pass", evidence: "", met: true }],
    });
    expect(result.problems).toContain("missing-evidence");
  });

  it("rejects done that claims a criterion is unmet", () => {
    const result = validateDecision({ action: "done", criteria: [{ criterion: "lints", evidence: "npm lint → ok", met: false }] });
    expect(result.problems).toContain("missing-evidence");
  });

  it("rejects done while unresolved failures are listed", () => {
    const result = validateDecision({ ...DONE_WITH_EVIDENCE, unresolved: ["flaky e2e"] });
    expect(result.problems).toContain("unresolved-failures");
  });

  it('rejects "blocked" that does not name what is missing', () => {
    expect(validateDecision({ action: "blocked" }).problems).toContain("missing-blocker");
    const ok = validateDecision({ action: "blocked", blocker: "needs the staging deploy token" });
    expect(ok.ok).toBe(true);
    expect(ok.decision.blocker).toBe("needs the staging deploy token");
  });

  it("reports unparseable input as its own problem", () => {
    const result = validateDecision(null);
    expect(result.problems).toEqual(["unparseable"]);
    expect(result.summary).toMatch(/JSON object/);
  });

  it("summarises several problems at once", () => {
    const result = validateDecision({ action: "done", unresolved: ["x"] });
    expect(result.problems).toEqual(expect.arrayContaining(["invalid-criteria", "unresolved-failures"]));
  });
});

describe("parseSupervisorReply", () => {
  it("handles fenced JSON from a chatty model", () => {
    const reply = ['I reviewed the report.', '```json', JSON.stringify(DONE_WITH_EVIDENCE), '```'].join("\n");
    expect(parseSupervisorReply(reply).ok).toBe(true);
  });

  it("is strict about an empty reply", () => {
    expect(parseSupervisorReply("").ok).toBe(false);
  });
});

describe("buildRepairPrompt", () => {
  it("quotes the rejected reply and the reason", () => {
    const prompt = buildRepairPrompt("total nonsense", "the reply was not a JSON object", 500);
    expect(prompt).toContain("total nonsense");
    expect(prompt).toContain("not a JSON object");
    expect(prompt).toContain("ONLY a single valid JSON object");
  });

  it("truncates an oversized rejected reply instead of resending it whole", () => {
    const prompt = buildRepairPrompt("x".repeat(5_000), "bad", 100);
    expect(prompt).toContain("[truncated]");
    expect(prompt.length).toBeLessThan(1_000);
  });
});

describe("safeContinue", () => {
  it("carries the reason and never claims success", () => {
    expect(safeContinue("timeout")).toMatchObject({ action: "continue", confidence: 0 });
  });
});

describe("criteria coercion", () => {
  it("refuses to mark a criterion met when no evidence came with it", () => {
    const result = validateDecision({ action: "done", criteria: [{ criterion: "tests pass", met: true }] });
    expect(result.problems).toContain("missing-evidence");
  });
});
