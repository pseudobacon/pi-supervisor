import { describe, expect, it } from "vitest";
import { type BackendOutcome, type SupervisorBackend, type SupervisorRequest, SupervisorUnavailableError } from "../src/backends/types.js";
import { SupervisorLoop } from "../src/loop.js";
import type { SteeringDecision, SupervisorPhase, SupervisorState } from "../src/types.js";
import { createMockCtx } from "./harness.js";

const ctx = createMockCtx({ cwd: "/tmp/pi-supervisor-loop-test" }).ctx;

function makeState(overrides: Partial<SupervisorState> = {}): SupervisorState {
  return {
    active: true,
    outcome: "make the tests green",
    provider: "anthropic",
    modelId: "m",
    sensitivity: "medium",
    interventions: [],
    startedAt: Date.now(),
    turnCount: 0,
    backend: "mcp",
    phase: "working",
    acceptanceCriteria: [],
    ...overrides,
  };
}

type Answer = SteeringDecision | Error | "hold" | { outcome: BackendOutcome };

/** A relay turn: prose in, a verdict the loop must not second-guess. */
const turn = (decision: SteeringDecision, extra: Partial<BackendOutcome> = {}): Answer => ({
  outcome: { decision, raw: decision.message ?? decision.blocker ?? "", terminal: true, detail: "conversation c-1 · turn 2 · continued", ...extra },
});

/** A backend whose answers are scripted, with the requests it received kept for inspection. */
class FakeBackend implements SupervisorBackend {
  readonly id = "mcp" as const;
  readonly label = "fake";
  requests: SupervisorRequest[] = [];
  private resolver: ((outcome: BackendOutcome | Error) => void) | null = null;

  constructor(private script: Answer[]) {}

  get calls(): number {
    return this.requests.length;
  }

  /** The request currently awaiting an answer, if any. */
  get pending(): boolean {
    return this.resolver !== null;
  }

  /** Answer the held request by hand, to test cancellation timing. */
  resolveNext(decision: SteeringDecision): void {
    const resolve = this.resolver;
    if (!resolve) throw new Error("no request is being held");
    this.resolver = null;
    resolve({ decision, raw: JSON.stringify(decision) });
  }

  async review(request: SupervisorRequest): Promise<BackendOutcome> {
    this.requests.push(request);
    const next: Answer = this.script[Math.min(this.requests.length - 1, this.script.length - 1)];
    if (typeof next === "object" && !(next instanceof Error) && "outcome" in next) return { ...next.outcome };
    if (next instanceof Error) throw next;
    if (next === "hold") {
      return new Promise<BackendOutcome>((resolve, reject) => {
        this.resolver = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
      });
    }
    return { decision: next, raw: JSON.stringify(next) };
  }
}

interface Harness {
  loop: SupervisorLoop;
  state: SupervisorState;
  injected: string[];
  notices: Array<{ message: string; level?: string }>;
  phases: SupervisorPhase[];
  backend: FakeBackend;
}

function harness(script: Answer[], options: { maxIterations?: number; maxDurationMs?: number } = {}): Harness {
  const state = makeState();
  const injected: string[] = [];
  const notices: Array<{ message: string; level?: string }> = [];
  const phases: SupervisorPhase[] = [];
  const backend = new FakeBackend(script);

  const loop = new SupervisorLoop(
    () => state,
    (phase, reason) => {
      state.phase = phase;
      state.pauseReason = reason;
      phases.push(phase);
    },
    (patch) => {
      if (patch.lastDecision !== undefined) state.lastDecision = patch.lastDecision;
      if (patch.acceptanceCriteria !== undefined) state.acceptanceCriteria = patch.acceptanceCriteria;
      if (patch.relay) {
        if (patch.relay.turn !== undefined) state.relayTurn = patch.relay.turn;
        if (patch.relay.attached !== undefined) state.conversationAttached = patch.relay.attached;
        if (patch.relay.activity !== undefined) state.lastActivity = patch.relay.activity;
      }
    },
    {
      sendInstruction: (text) => injected.push(text),
      notify: (message, level) => notices.push({ message, level }),
      createBackend: () => backend,
      limits: () => ({ maxIterations: options.maxIterations ?? 10, maxDurationMs: options.maxDurationMs ?? 600_000, maxReportChars: 10_000 }),
      render: () => {},
      settleGraceMs: 5,
    }
  );

  return { loop, state, injected, notices, phases, backend };
}

const steer = (instruction: string, extra: Partial<SteeringDecision> = {}): SteeringDecision => ({ action: "steer", message: instruction, reasoning: "r", ...extra });
const done = (criteria: Array<{ criterion: string; evidence: string; met: boolean }> = [{ criterion: "npm test passes", evidence: "npm test → 57 passed", met: true }]): SteeringDecision => ({
  action: "done",
  reasoning: "all green",
  criteria,
  unresolved: [],
});

describe("SupervisorLoop — starting a supervised run", () => {
  it("asks for the first instruction and starts the worker itself", async () => {
    const h = harness([steer("write the failing test", { acceptanceCriteria: ["npm test passes", "README updated"] })]);
    const started = await h.loop.start(ctx);

    expect(started).toBe(true);
    expect(h.backend.calls).toBe(1);
    expect(h.backend.requests[0].kind).toBe("initial");
    expect(h.backend.requests[0].report).toContain("make the tests green");
    expect(h.injected).toEqual(["write the failing test"]);
    expect(h.state.phase).toBe("working");
    expect(h.state.acceptanceCriteria).toEqual(["npm test passes", "README updated"]);
  });

  it("records the instruction so the next report can quote it", async () => {
    const h = harness([steer("step one"), steer("step two")]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    await h.loop.onWorkerSettled(ctx, false);

    expect(h.backend.requests[1].kind).toBe("review");
    expect(h.backend.requests[1].report).toContain("step one");
    expect(h.backend.requests[1].report).toContain("ITERATION: 2");
  });

  it("reports a start failure instead of pretending the worker is running", async () => {
    const h = harness([new SupervisorUnavailableError("connection refused", "transport")]);
    expect(await h.loop.start(ctx)).toBe(false);
    expect(h.injected).toEqual([]);
    expect(h.state.phase).toBe("paused");
    expect(h.state.pauseReason).toContain("connection refused");
    expect(h.notices.some((n) => n.level === "error")).toBe(true);
  });
});

describe("SupervisorLoop — one review per worker run", () => {
  it("reviews a settled run exactly once", async () => {
    const h = harness([steer("first"), steer("second")]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    await h.loop.onWorkerSettled(ctx, false);
    await h.loop.onWorkerSettled(ctx, false); // duplicate lifecycle event
    await h.loop.onWorkerSettled(ctx, false);

    expect(h.backend.calls).toBe(2); // initial + one review
    expect(h.injected).toEqual(["first", "second"]);
  });

  it("does not review a run it did not start", async () => {
    const h = harness([steer("first"), steer("second")]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    h.loop.onUserInput(); // the user took over
    await h.loop.onWorkerSettled(ctx, false);

    expect(h.backend.calls).toBe(1);
    expect(h.state.phase).toBe("paused");
  });

  it("does not ask a second question while one is in flight", async () => {
    const h = harness([steer("first"), "hold"]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    const inFlight = h.loop.onWorkerSettled(ctx, false);
    await h.loop.onWorkerSettled(ctx, false); // second event while the first review is unanswered
    expect(h.backend.calls).toBe(2);
    h.backend.resolveNext(steer("do it"));
    await inFlight;
    expect(h.injected).toEqual(["first", "do it"]);
  });
});

describe("SupervisorLoop — stale work is dropped", () => {
  it("ignores a reply that arrives after /supervise stop", async () => {
    const h = harness([steer("first"), "hold"]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    const inFlight = h.loop.onWorkerSettled(ctx, false);

    await h.loop.stop(false);
    h.backend.resolveNext(steer("a late answer"));
    await inFlight;

    expect(h.injected).toEqual(["first"]); // the late answer was never injected
    expect(h.state.phase).toBe("paused");
  });

  it("aborts the outstanding request when stopped", async () => {
    const h = harness([steer("first"), "hold"]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    const inFlight = h.loop.onWorkerSettled(ctx, false);
    expect(h.loop.requestInFlight).toBe(true);

    await h.loop.stop(true);
    expect(h.loop.requestInFlight).toBe(false);
    expect(h.notices.some((n) => /still running/.test(n.message))).toBe(true);
    h.backend.resolveNext(steer("too late"));
    await inFlight;
  });

  it("drops the reply of a session that was switched out from under it", async () => {
    const h = harness([steer("first"), "hold"]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    const inFlight = h.loop.onWorkerSettled(ctx, false);

    h.loop.invalidate();
    h.backend.resolveNext(steer("too late"));
    await inFlight;

    expect(h.injected).toEqual(["first"]);
    expect(h.loop.status().iteration).toBe(0);
  });
});

describe("SupervisorLoop — completion is earned", () => {
  it("never reports completion for a run it was not waiting on", async () => {
    const h = harness([done()]);
    h.loop.onWorkerStart();
    await h.loop.onWorkerSettled(ctx, false); // nothing dispatched, so nothing is judged
    expect(h.state.phase).not.toBe("done");
    expect(h.injected).toEqual([]);
  });

  it("turns an evidence-free done into a request for proof, not a success", async () => {
    const h = harness([steer("finish it"), done([{ criterion: "npm test passes", evidence: "", met: true }])]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    await h.loop.onWorkerSettled(ctx, false);

    expect(h.state.phase).not.toBe("done");
    expect(h.injected).toHaveLength(2);
    expect(h.injected[1]).toMatch(/Do not treat the goal as finished yet/);
    expect(h.injected[1]).toContain("npm test passes");
  });

  it("refuses done while failures are unresolved", async () => {
    const h = harness([
      steer("finish it"),
      {
        action: "done",
        reasoning: "mostly",
        criteria: [{ criterion: "npm test passes", evidence: "npm test → 56 passed, 1 failed", met: true }],
        unresolved: ["1 failing test"],
      },
    ]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    await h.loop.onWorkerSettled(ctx, false);

    expect(h.state.phase).not.toBe("done");
    expect(h.injected[1]).toContain("unresolved failures");
  });

  it("marks done and stops injecting once proof exists", async () => {
    const h = harness([steer("finish it"), done()]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    await h.loop.onWorkerSettled(ctx, false);

    expect(h.state.phase).toBe("done");
    expect(h.injected).toEqual(["finish it"]); // the accepted decision adds no instruction
    expect(h.notices.some((n) => /goal met/.test(n.message))).toBe(true);
  });
});

describe("SupervisorLoop — blocked, stalled, and out of budget", () => {
  it("pauses on blocked with the blocker as the reason, and injects nothing", async () => {
    const h = harness([steer("go"), { action: "blocked", reasoning: "cannot deploy", blocker: "staging credentials are not configured" }]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    await h.loop.onWorkerSettled(ctx, false);

    expect(h.injected).toEqual(["go"]);
    expect(h.state.phase).toBe("paused");
    expect(h.state.pauseReason).toContain("staging credentials are not configured");
    expect(h.notices.some((n) => /blocked/.test(n.message))).toBe(true);
  });

  it("pauses on an empty instruction", async () => {
    const h = harness([steer("go"), steer("   ")]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    await h.loop.onWorkerSettled(ctx, false);
    expect(h.state.phase).toBe("paused");
    expect(h.state.pauseReason).toContain("no instruction");
  });

  it("pauses rather than looping when the same instruction comes back twice", async () => {
    const h = harness([steer("run npm test"), steer("run npm test"), steer("run npm test")]);
    await h.loop.start(ctx);
    for (let i = 0; i < 4; i++) {
      h.loop.onWorkerStart();
      await h.loop.onWorkerSettled(ctx, false);
    }
    expect(h.state.phase).toBe("paused");
    expect(h.state.pauseReason).toContain("stagnated");
    expect(h.injected.filter((t) => t === "run npm test")).toHaveLength(2);
  });

  it("stops at the iteration ceiling without calling the goal done", async () => {
    const script = Array.from({ length: 12 }, (_, i) => steer(`step ${i}`)) as Array<SteeringDecision | Error>;
    const h = harness(script, { maxIterations: 3 });
    await h.loop.start(ctx);
    for (let i = 0; i < 5; i++) {
      h.loop.onWorkerStart();
      await h.loop.onWorkerSettled(ctx, false);
    }
    expect(h.injected).toHaveLength(3);
    expect(h.state.phase).toBe("paused");
    expect(h.state.pauseReason).toContain("iteration limit");
    expect(h.notices.some((n) => /iteration limit/.test(n.message))).toBe(true);
  });

  it("stops at the time ceiling without calling the goal done", async () => {
    const h = harness([steer("a"), steer("b")], { maxDurationMs: -1 });
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    await h.loop.onWorkerSettled(ctx, false);
    expect(h.state.phase).toBe("paused");
    expect(h.state.pauseReason).toContain("minute limit");
  });

  it("treats an interrupted worker run as a pause, never as progress", async () => {
    const h = harness([steer("go"), steer("next")]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    await h.loop.onWorkerSettled(ctx, true); // aborted
    expect(h.state.phase).toBe("paused");
    expect(h.state.pauseReason).toContain("interrupted");
    expect(h.injected).toEqual(["go"]);
  });

  it("pauses when the user prompts while the loop is in charge", async () => {
    const h = harness([steer("go"), steer("next")]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    h.loop.onUserInput();
    await h.loop.onWorkerSettled(ctx, false);
    expect(h.state.phase).toBe("paused");
    expect(h.state.pauseReason).toContain("user prompt");
  });
});

describe("SupervisorLoop — resume", () => {
  it("asks for a fresh decision instead of replaying the last instruction", async () => {
    const h = harness([steer("first"), steer("second"), steer("third")]);
    await h.loop.start(ctx);
    h.loop.onUserInput(); // paused

    const resumed = await h.loop.resume(ctx);
    expect(resumed).toBe(true);
    expect(h.backend.calls).toBe(2); // initial + the resume review; nothing replayed
    expect(h.injected).toEqual(["first", "second"]);
    expect(h.injected.filter((t) => t === "first")).toHaveLength(1);
  });

  it("refuses to resume a run that is not paused", async () => {
    const h = harness([steer("go")]);
    await h.loop.start(ctx);
    expect(await h.loop.resume(ctx)).toBe(false);
    expect(h.backend.calls).toBe(1);
  });

  it("refuses to resume an inactive goal", async () => {
    const h = harness([steer("go")]);
    h.state.active = false;
    expect(await h.loop.resume(ctx)).toBe(false);
  });
});

describe("SupervisorLoop — agent_end compatibility path", () => {
  it("reviews on the fallback only once the host is idle with nothing queued", async () => {
    const busy = createMockCtx({ cwd: "/tmp/x", idle: false, pendingMessages: true }).ctx;
    const h = harness([steer("go"), steer("after")]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    h.loop.onWorkerEnd(busy); // still working: must not review

    await new Promise((r) => setTimeout(r, 30));
    expect(h.backend.calls).toBe(1);

    const idle = createMockCtx({ cwd: "/tmp/x", idle: true, pendingMessages: false }).ctx;
    h.loop.onWorkerEnd(idle);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.backend.calls).toBe(2);
    expect(h.injected).toEqual(["go", "after"]);
  });

  it("prefers agent_settled: the settle event cancels the pending fallback", async () => {
    const h = harness([steer("go"), steer("after")]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    h.loop.onWorkerEnd(ctx); // fallback armed
    await h.loop.onWorkerSettled(ctx, false); // authoritative
    await new Promise((r) => setTimeout(r, 30));
    expect(h.backend.calls).toBe(2);
    expect(h.injected).toEqual(["go", "after"]);
  });
});

describe("SupervisorLoop — reports are bounded and self-contained", () => {
  it("sends the goal, criteria, iteration, and instruction on every request", async () => {
    const h = harness([steer("one", { acceptanceCriteria: ["npm test passes"] }), steer("two")]);
    await h.loop.start(ctx);
    h.loop.onWorkerStart();
    await h.loop.onWorkerSettled(ctx, false);

    for (const request of h.backend.requests) {
      expect(request.report).toContain("make the tests green");
      expect(request.report).toContain("ITERATION:");
    }
    // The first reply supplies the criteria; every later report carries them on.
    expect(h.backend.requests[0].report).toMatch(/propose the missing ones/);
    expect(h.backend.requests[1].report).toContain("npm test passes");
  });

  it("passes the configured report ceiling through", async () => {
    const h = harness([steer("go")]);
    await h.loop.start(ctx);
    expect(h.backend.requests[0].report.length).toBeLessThan(10_000);
  });
});

describe("SupervisorLoop — the chat relay's verdicts", () => {
  /**
   * A relay review only happens after the loop itself dispatched an instruction,
   * so every case starts one, lets the worker run, and then answers the review.
   */
  async function reviewAfterWorkerRun(
    answer: Answer,
    options: { branch?: any[] } = {}
  ): Promise<Harness & { request: SupervisorRequest }> {
    const mock = createMockCtx({ cwd: "/tmp/pi-supervisor-relay-loop" });

    const h = harness([steer("prime"), answer]);
    await h.loop.start(mock.ctx);
    // everything the worker produced comes after the instruction was dispatched
    for (const entry of options.branch ?? []) mock.branch.push(entry);
    h.loop.onWorkerStart();
    await h.loop.onWorkerSettled(mock.ctx, false);
    return { ...h, request: h.backend.requests[1] };
  }

  it("hands the backend the worker's own final response, plus the facts behind it", async () => {
    const h = await reviewAfterWorkerRun(turn(steer("now write the regression test")), {
      branch: [
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I fixed the race; 57 tests pass." }] } },
        {
          type: "message",
          message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "permission denied" }] },
        },
      ],
    });

    expect(h.request.workerText).toBe("I fixed the race; 57 tests pass.");
    expect(h.request.workerFacts?.toolErrors?.[0]).toContain("bash reported a failure");
    expect(h.request.workerFacts?.noResponse).toBe(false);
  });

  it("accepts a terminal [[PPLX_DONE]] as the end of the run and dispatches nothing else", async () => {
    const h = await reviewAfterWorkerRun(
      turn({ action: "done", reasoning: "green", message: "Tests, lint, and build all pass in this checkout." })
    );

    expect(h.injected).toEqual(["prime"]); // no evidence-chasing turn, no next instruction
    expect(h.state.phase).toBe("done");
    expect(h.state.lastActivity).toBe("the supervisor signalled completion");
    expect(h.notices.map((n) => n.message).join("\n")).toContain("Tests, lint, and build all pass");
  });

  it("pauses on [[PPLX_BLOCKED]] with the supervisor's own explanation", async () => {
    const h = await reviewAfterWorkerRun(
      turn({ action: "blocked", reasoning: "no access", blocker: "I need the staging credentials from the human." })
    );

    expect(h.injected).toEqual(["prime"]);
    expect(h.state.phase).toBe("paused");
    expect(h.state.pauseReason).toContain("staging credentials");
    expect(h.notices.some((n) => n.level === "warning" && n.message.includes("staging credentials"))).toBe(true);
  });

  it("keeps conversation bookkeeping so /supervise status can report it", async () => {
    const h = await reviewAfterWorkerRun(
      turn(steer("keep going"), {
        detail: "conversation pi-sup-run-1 · turn 2 · continued",
        conversation: { id: "pi-sup-run-1", turn: 2, attached: true },
      })
    );

    expect(h.state.relayTurn).toBe(2);
    expect(h.state.conversationAttached).toBe(true);
    expect(h.state.lastActivity).toContain("pi-sup-run-1");
    expect(h.state.lastActivity).toContain("continued");
  });

  it("records the failure as the last activity when the conversation cannot answer", async () => {
    const h = await reviewAfterWorkerRun(new SupervisorUnavailableError("pplx-proxy returned HTTP 503.", "transport"));

    expect(h.state.phase).toBe("paused");
    expect(h.state.lastActivity).toContain("HTTP 503");
  });
});
