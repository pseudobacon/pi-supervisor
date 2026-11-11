/**
 * `/supervise` dispatch: control words are not goals.
 *
 * Reproduced from the 2026-11-07 21:30 run in this workspace, where a status request
 * arrived as `"status\n/supervise status"` — because pi splits an extension command at
 * the first space and passes the remainder verbatim — and was started as a supervision
 * goal, which opened a live Perplexity conversation and dispatched a worker run.
 */
import { describe, expect, it } from "vitest";
import { nonGoalReason, SUPERVISE_SUBCOMMANDS } from "../src/command-intent.js";
import { GOAL_AS_SUBMITTED } from "./fixtures/relay-transcript.js";

describe("a control command with something stuck to it is never a goal", () => {
  it("rejects the exact submission that started a run in the transcript", () => {
    const reason = nonGoalReason(GOAL_AS_SUBMITTED);
    expect(reason).not.toBe("");
    expect(reason).toContain("status");
    expect(reason).toMatch(/nothing was started/i);
    expect(reason).toMatch(/saved goal is unchanged/i);
  });

  it.each(SUPERVISE_SUBCOMMANDS)("rejects a trailing-line %s invocation", (verb) => {
    expect(nonGoalReason(`${verb}\n${verb} once more`)).not.toBe("");
  });

  it("rejects a goal that carries a slash command inside it", () => {
    expect(nonGoalReason("/supervise status")).toMatch(/slash command/);
    expect(nonGoalReason("fix the flaky test\n/supervise stop")).toMatch(/slash command/);
  });

  it("echoes what it received so the user can see the damage", () => {
    expect(nonGoalReason(GOAL_AS_SUBMITTED)).toContain("/supervise status");
  });
});

describe("a genuine goal still starts a run", () => {
  it("accepts a goal that merely begins with a control word", () => {
    expect(nonGoalReason("status reporting must retry the upload")).toBe("");
  });

  it("accepts an ordinary multi-line goal", () => {
    expect(nonGoalReason("Add --dry-run to the CLI.\nPrint the command without running it.")).toBe("");
  });

  it("leaves the empty argument to the settings panel, as before", () => {
    expect(nonGoalReason("   ")).toBe("");
  });
});
