import { describe, expect, it } from "vitest";
import { buildReport, DEFAULT_REPORT_LIMITS, summarizeActivity, summarizeDecision } from "../src/report.js";

const assistant = (text: string, extra: unknown[] = []) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }, ...extra] },
});
const toolCall = (name: string, args: Record<string, unknown>) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args, id: "t1" }] },
});
const toolResult = (toolName: string, text: string, details: Record<string, unknown> = {}, isError = false) => ({
  type: "message",
  message: { role: "toolResult", toolName, content: [{ type: "text", text }], details, isError },
});

const BASE = {
  goal: "Add JWT refresh tokens with tests",
  acceptanceCriteria: ["npm test passes", "refresh flow documented"],
  iteration: 3,
  maxIterations: 12,
  instruction: "Write the failing test for the refresh flow, then implement it.",
  history: [{ iteration: 2, action: "steer", summary: "run the tests" }],
};

describe("summarizeActivity", () => {
  it("collects assistant text, tool calls, changed files, validation, and failures", () => {
    const activity = summarizeActivity(
      [
        assistant("I added the refresh test."),
        toolCall("edit", { path: "src/auth.ts" }),
        toolResult("bash", "npm test → 12 passed", { command: "npm test" }),
        toolResult("bash", "boom: cannot find module", { command: "npm run lint", exitCode: 1 }),
      ],
      DEFAULT_REPORT_LIMITS
    );
    expect(activity.assistantText.join(" ")).toContain("refresh test");
    expect(activity.changedFiles).toContain("src/auth.ts");
    expect(activity.validation.join(" ")).toContain("npm test");
    expect(activity.failures.join(" ")).toContain("exit=1");
    expect(activity.failures.join(" ")).toContain("cannot find module");
  });

  it("treats an errored tool result as a failure even without an exit code", () => {
    const activity = summarizeActivity([toolResult("edit", "permission denied", {}, true)], DEFAULT_REPORT_LIMITS);
    expect(activity.failures).toHaveLength(1);
  });

  it("records the user turns so the supervisor can see what the worker was told", () => {
    const activity = summarizeActivity([{ type: "message", message: { role: "user", content: "do the thing" } }], DEFAULT_REPORT_LIMITS);
    expect(activity.userPrompts).toContain("do the thing");
  });

  it("marks an assistant message that stopped abnormally", () => {
    const activity = summarizeActivity(
      [{ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "timeout" } }],
      DEFAULT_REPORT_LIMITS
    );
    expect(activity.failures.join(" ")).toContain("timeout");
  });

  it("deduplicates changed files", () => {
    const activity = summarizeActivity([toolCall("edit", { path: "a.ts" }), toolCall("edit", { path: "a.ts" })], DEFAULT_REPORT_LIMITS);
    expect(activity.changedFiles).toEqual(["a.ts"]);
  });

  it("clips oversized items instead of dropping them", () => {
    const activity = summarizeActivity([assistant("x".repeat(20_000))], DEFAULT_REPORT_LIMITS);
    expect(activity.assistantText[0].length).toBeLessThan(DEFAULT_REPORT_LIMITS.maxItemChars + 200);
    expect(activity.assistantText[0]).toContain("omitted");
  });
});

describe("buildReport", () => {
  const report = buildReport({ ...BASE, entries: [assistant("ran npm test"), toolResult("bash", "npm test → 57 passed", { command: "npm test" })] });

  it("leads with the goal, the criteria, and the instruction the worker ran under", () => {
    expect(report).toContain("Add JWT refresh tokens with tests");
    expect(report).toContain("npm test passes");
    expect(report).toContain("refresh flow documented");
    expect(report).toContain("Write the failing test for the refresh flow");
  });

  it("states which iteration this is and the ceiling", () => {
    expect(report).toContain("ITERATION: 3 of at most 12");
  });

  it("includes validation evidence and previous decisions", () => {
    expect(report).toContain("VALIDATION EVIDENCE");
    expect(report).toContain("57 passed");
    expect(report).toContain("run the tests");
  });

  it("tells the supervisor not to assume anything outside the report", () => {
    expect(report).toMatch(/Do not assume anything/);
  });

  it("says the worker has not run yet on the first request", () => {
    const first = buildReport({ ...BASE, entries: [], initial: true });
    expect(first).toContain("has NOT started yet");
    expect(first).toContain("the worker has not run yet");
  });

  it("proposes criteria when none are recorded yet", () => {
    const first = buildReport({ ...BASE, acceptanceCriteria: [], entries: [], initial: true });
    expect(first).toMatch(/propose the missing ones/);
  });
});

describe("buildReport bounds", () => {
  const huge = [
    assistant("filler ".repeat(4_000)),
    assistant("more filler ".repeat(4_000)),
    toolResult("bash", "npm test → 1 passed", { command: "npm test" }),
  ];

  it("never exceeds the configured character budget", () => {
    const report = buildReport({ ...BASE, entries: huge, limits: { maxChars: 4_000 } });
    expect(report.length).toBeLessThanOrEqual(4_500);
  });

  it("keeps the goal and criteria even when it had to cut", () => {
    const report = buildReport({ ...BASE, entries: huge, limits: { maxChars: 2_500 } });
    expect(report).toContain("Add JWT refresh tokens with tests");
    expect(report).toContain("npm test passes");
    expect(report).toMatch(/omitted|truncat/i);
  });

  it("keeps critical failures when trimming, ahead of ordinary output", () => {
    const report = buildReport({
      ...BASE,
      entries: [assistant("filler ".repeat(6_000)), toolResult("bash", "TypeError: cannot read x", { exitCode: 2 }, true)],
      limits: { maxChars: 3_000 },
    });
    expect(report).toContain("CRITICAL FAILURES");
    expect(report).toContain("cannot read x");
  });
});

describe("report composition settings", () => {
  const entries = [
    assistant("I edited the file"),
    toolCall("edit", { path: "src/a.ts" }),
    toolResult("bash", "npm test → ok", { command: "npm test" }),
    toolResult("bash", "lint exploded", { exitCode: 1 }, true),
  ];

  it("omits disabled sections and says so explicitly", () => {
    const report = buildReport({
      ...BASE,
      entries,
      include: { assistantOutput: false, toolCalls: false, toolResults: false, changedFiles: false },
    });
    expect(report).not.toContain("I edited the file");
    expect(report).not.toContain("src/a.ts");
    expect(report).toMatch(/WITHHELD BY SETTINGS/);
    expect(report).toMatch(/assistant output, tool calls, tool results \(failures are still listed\), changed files/);
  });

  it("still reports failures when tool results are withheld", () => {
    const report = buildReport({ ...BASE, entries, include: { toolResults: false } });
    expect(report).toContain("lint exploded");
  });
});

describe("summarizeDecision", () => {
  it("names the action and the instruction", () => {
    expect(summarizeDecision({ action: "steer", message: "run the tests", reasoning: "no evidence" })).toMatch(/run the tests/);
  });

  it("never renders a bare action as success", () => {
    expect(summarizeDecision({ action: "continue", reasoning: "fine", confidence: 1 })).toMatch(/continue/i);
  });
});
