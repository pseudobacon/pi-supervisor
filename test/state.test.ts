import { describe, expect, it, vi } from "vitest";
import { MISSING_STATE_NOTE, SupervisorStateManager } from "../src/state.js";
import type { SupervisorState } from "../src/types.js";

function makePi() {
  return {
    appendEntry: vi.fn(),
  } as any;
}

function makeCtxWithBranch(branch: any[]) {
  return {
    sessionManager: { getBranch: () => branch },
  } as any;
}

describe("SupervisorStateManager", () => {
  it("start() seeds full state and persists once", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    mgr.start("ship the feature", "anthropic", "claude-haiku-4-5", "high");

    expect(mgr.isActive()).toBe(true);
    const s = mgr.getState();
    expect(s).toMatchObject({
      active: true,
      outcome: "ship the feature",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      sensitivity: "high",
      interventions: [],
      turnCount: 0,
    });
    expect(s?.startedAt).toBeGreaterThan(0);

    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith("supervisor-state", expect.objectContaining({
      active: true,
      outcome: "ship the feature",
    }));
  });

  it("stop() flips active=false and persists; subsequent stop() is a no-op when state is null", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    // No state yet — stop should not call appendEntry.
    mgr.stop();
    expect(pi.appendEntry).not.toHaveBeenCalled();

    mgr.start("x", "anthropic", "m", "low");
    pi.appendEntry.mockClear();

    mgr.stop();
    expect(mgr.isActive()).toBe(false);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "supervisor-state",
      expect.objectContaining({ active: false }),
    );
  });

  it("addIntervention appends and persists; ignored when no state", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    mgr.addIntervention({ turnCount: 1, message: "stay on track", reasoning: "drift", timestamp: 1 });
    expect(pi.appendEntry).not.toHaveBeenCalled();

    mgr.start("x", "anthropic", "m", "medium");
    pi.appendEntry.mockClear();

    mgr.addIntervention({ turnCount: 5, message: "redirect", reasoning: "off-topic", timestamp: 123 });
    expect(mgr.getState()?.interventions).toEqual([
      { turnCount: 5, message: "redirect", reasoning: "off-topic", timestamp: 123 },
    ]);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("incrementTurnCount mutates in-memory only (not persisted)", () => {
    // turnCount is high-churn — persisting on every increment would write a
    // session entry per agent turn. The widget reads in-memory state.
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);
    mgr.start("x", "anthropic", "m", "medium");
    pi.appendEntry.mockClear();

    mgr.incrementTurnCount();
    mgr.incrementTurnCount();

    expect(mgr.getState()?.turnCount).toBe(2);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("setModel and setSensitivity update fields and persist; both are no-ops without state", () => {
    const pi = makePi();
    const mgr = new SupervisorStateManager(pi);

    mgr.setModel("openai", "gpt-5");
    mgr.setSensitivity("high");
    expect(pi.appendEntry).not.toHaveBeenCalled();

    mgr.start("x", "anthropic", "claude-haiku-4-5", "low");
    pi.appendEntry.mockClear();

    mgr.setModel("openai", "gpt-5");
    expect(mgr.getState()).toMatchObject({ provider: "openai", modelId: "gpt-5" });

    mgr.setSensitivity("high");
    expect(mgr.getState()?.sensitivity).toBe("high");

    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
  });

  it("loadFromSession picks the most recent supervisor-state entry", () => {
    const older: SupervisorState = {
      active: true, outcome: "old", provider: "anthropic", modelId: "m1",
      sensitivity: "low", interventions: [], startedAt: 1, turnCount: 0,
    };
    const newer: SupervisorState = {
      active: false, outcome: "new", provider: "openai", modelId: "m2",
      sensitivity: "high", interventions: [], startedAt: 2, turnCount: 9,
    };

    const ctx = makeCtxWithBranch([
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "custom", customType: "supervisor-state", data: older },
      { type: "message", message: { role: "assistant", content: [] } },
      { type: "custom", customType: "supervisor-state", data: newer },
      { type: "custom", customType: "other-extension", data: { foo: 1 } },
    ]);

    const mgr = new SupervisorStateManager(makePi());
    mgr.loadFromSession(ctx);

    // Legacy session entries have no backend/phase; normalizePersisted fills in the
    // model backend so an old run keeps behaving exactly as it did before.
    expect(mgr.getState()).toEqual({ ...newer, backend: "model" });
    expect(mgr.isActive()).toBe(false);
  });

  it("loadFromSession leaves state null when no supervisor-state entry exists", () => {
    const ctx = makeCtxWithBranch([
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "custom", customType: "other-extension", data: { foo: 1 } },
    ]);

    const mgr = new SupervisorStateManager(makePi());
    mgr.loadFromSession(ctx);

    expect(mgr.getState()).toBeNull();
  });
});

describe("missing-state diagnosis", () => {
  it("diagnoses a lost run: a /supervise goal with no state entry", () => {
    const ctx = makeCtxWithBranch([
      { type: "message", message: { role: "user", content: "/supervise fix the build" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Working on it." }] } },
    ]);

    const mgr = new SupervisorStateManager(makePi());
    mgr.loadFromSession(ctx);

    expect(mgr.getState()).toBeNull();
    expect(mgr.getMissingStateNote()).toBe(MISSING_STATE_NOTE);
  });

  it("accepts the real session shape (array-of-blocks content); a state entry wins", () => {
    const ctx = makeCtxWithBranch([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "/supervise fix the build" }] } },
      {
        type: "custom",
        customType: "supervisor-state",
        data: {
          active: true, outcome: "fix the build", provider: "anthropic",
          modelId: "claude-haiku-4-5-20251001", sensitivity: "medium",
          interventions: [], startedAt: 1, turnCount: 0,
        },
      },
    ]);

    const mgr = new SupervisorStateManager(makePi());
    mgr.loadFromSession(ctx);

    expect(mgr.getState()).not.toBeNull();
    expect(mgr.getMissingStateNote()).toBeNull();
  });

  it("control words and ordinary messages are not evidence of a lost run", () => {
    const ctx = makeCtxWithBranch([
      { type: "message", message: { role: "user", content: "/supervise status" } },
      { type: "message", message: { role: "user", content: "/supervise resume" } },
      { type: "message", message: { role: "user", content: "/supervise status\n/supervise status" } },
      { type: "message", message: { role: "user", content: "fix the build" } },
    ]);

    const mgr = new SupervisorStateManager(makePi());
    mgr.loadFromSession(ctx);

    expect(mgr.getState()).toBeNull();
    expect(mgr.getMissingStateNote()).toBeNull();
  });

  it("start() clears the note", () => {
    const ctx = makeCtxWithBranch([
      { type: "message", message: { role: "user", content: "/supervise fix the build" } },
    ]);

    const mgr = new SupervisorStateManager(makePi());
    mgr.loadFromSession(ctx);
    expect(mgr.getMissingStateNote()).not.toBeNull();

    mgr.start("a new goal", "anthropic", "claude-haiku-4-5", "medium");
    expect(mgr.getMissingStateNote()).toBeNull();
  });
});
