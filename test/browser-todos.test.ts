/**
 * The todo reader's contract, and specifically its refusals. On plain pi 1.5.0 there is
 * no todo list at all, so `null` is the correct and common answer; the danger is the
 * near-miss — a list that is misread as empty, which would let a browser run declare
 * itself complete in the middle of a task.
 */
import { describe, expect, it } from "vitest";
import { countOpenTodos } from "../src/browser/todos.js";

const call = (name: string, args: Record<string, unknown>, type = "toolCall") => ({
  type: "message",
  message: { role: "assistant", content: [{ type, name, arguments: args }] },
});

describe("countOpenTodos", () => {
  it("says nothing when the session says nothing — the plain pi 1.5.0 case", () => {
    const entries = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "fix the bug" }] } },
      call("bash", { command: "npm test" }),
      call("read", { path: "src/x.ts" }),
    ];
    expect(countOpenTodos(entries)).toBeNull();
  });

  it("counts the statuses it knows, keeping in-progress separate from pending", () => {
    const todos = [
      { id: 1, status: "completed" },
      { id: 2, status: "pending" },
      { id: 3, status: "in_progress" },
      { id: 4, status: "pending" },
    ];
    expect(countOpenTodos([call("todo", { todos })])).toEqual({ pending: 2, inProgress: 1, source: "todo call carried 4 item(s)" });
  });

  it("treats the plan-mode and Pi-Bolt names alike, because both exist in the wild", () => {
    expect(countOpenTodos([call("todo", { tasks: [{ status: "pending" }] })])).toEqual({ pending: 1, inProgress: 0, source: "todo call carried 1 item(s)" });
    expect(countOpenTodos([call("update_plan", { plan: [{ state: "in_progress" }] })])).toEqual({ pending: 0, inProgress: 1, source: "update_plan call carried 1 item(s)" });
    expect(countOpenTodos([call("todos", { items: [{ status: "in_progress" }] })])).toEqual({ pending: 0, inProgress: 1, source: "todos call carried 1 item(s)" });
  });

  it("accepts the host's other tool-call spellings", () => {
    for (const type of ["toolUse", "tool_use"]) {
      expect(countOpenTodos([call("todo", { todos: [{ status: "pending" }] }, type)])?.pending).toBe(1);
    }
  });

  it("reads the newest list, not the first one it met", () => {
    const stale = [call("todo", { todos: [{ status: "pending" }, { status: "pending" }, { status: "pending" }] })];
    const current = [call("todo", { todos: [{ status: "completed" }, { status: "in_progress" }] })];
    expect(countOpenTodos([...stale, ...current])).toEqual({ pending: 0, inProgress: 1, source: "todo call carried 2 item(s)" });
  });

  it("does not count a tombstone as open work", () => {
    expect(countOpenTodos([call("todo", { todos: [{ status: "deleted" }, { status: "cancelled" }, { status: "completed" }] })])).toEqual({
      pending: 0,
      inProgress: 0,
      source: "todo call carried 3 item(s)",
    });
  });

  it("refuses to invent a count from a list whose items carry no status", () => {
    // Reporting "0 open" here is exactly the failure that stops a run mid-task.
    expect(countOpenTodos([call("todo", { todos: [{ text: "write the tests" }, { text: "run the gate" }] })])).toBeNull();
  });

  it("refuses to treat a single-item mutation as the whole list", () => {
    // pi's example extension mutates by id (add/toggle/clear). Replaying a partial
    // history of those would produce a confident, wrong tally.
    expect(countOpenTodos([call("todo", { action: "toggle", id: 3, done: true })])).toBeNull();
    expect(countOpenTodos([call("todo", { action: "add", text: "more work" })])).toBeNull();
  });

  it("refuses when any status is one it has never seen", () => {
    // Neither open nor closed — so neither is claimed.
    expect(countOpenTodos([call("todo", { todos: [{ status: "waiting-for-review" }, { status: "pending" }] })])).toBeNull();
  });

// ---- the host's own recorded shapes ---------------------------------------------------
// Pi-Bolt's built-in todo tool is MUTATION-shaped, so a snapshot-only reader would report
// "unknown" on the very host this relay is built for. These strings are copied from the
// host's own session file, not written by hand:
//   ~/.pi/agent/sessions/--home-pseudobacon-ai-pi-supervisor--/…01a1b6ed….jsonl
const result = (text: string) => ({
  type: "message",
  message: { role: "toolResult", toolName: "todo", toolCallId: "call_x", content: [{ type: "text", text }] },
});

describe("reading the host's recorded todo output", () => {
  it("reads a list snapshot, which is the tool's own current truth", () => {
    const snapshot = ["[completed] #1 Design + backend abstraction types", "[in_progress] #2 MCP backend: config, client, discovery (Building MCP backend modules)"].join("\n");
    expect(countOpenTodos([result(snapshot)])).toEqual({ pending: 0, inProgress: 1, source: "todo list snapshot" });
  });

  it("replays the mutation results when no snapshot was ever printed", () => {
    const entries = [
      result("Created #1: Add types (pending)"),
      result("Created #2: Write the client (pending)"),
      result("Updated #1 (pending → completed)"),
      result("No change: #2 already matches the requested values (status: pending)"),
    ];
    expect(countOpenTodos(entries)).toEqual({ pending: 1, inProgress: 0, source: "todo mutation results" });
  });

  it("counts an item completed mid-history as closed, and a tombstone as closed", () => {
    const entries = [result("Created #1: A (pending)"), result("Created #2: B (pending)"), result("Updated #1 (pending → completed)"), result("Deleted #2")];
    expect(countOpenTodos(entries)).toEqual({ pending: 0, inProgress: 0, source: "todo mutation results" });
  });

  it("honours a Clear, which really does mean nothing is open", () => {
    const entries = [result("Created #1: A (pending)"), result("Cleared 1 todos")];
    expect(countOpenTodos(entries)).toEqual({ pending: 0, inProgress: 0, source: "todo mutation results" });
  });

  it("knows pi's example extension by its own words", () => {
    expect(countOpenTodos([result("Added todo #7: ship it"), result("Todo #7 completed")])).toEqual({ pending: 0, inProgress: 0, source: "todo mutation results" });
  });

  it("lets a later snapshot override an older replay, and vice versa", () => {
    const replayThenSnapshot = [result("Created #1: A (pending)"), result("[pending] #1 A\n[pending] #2 B")];
    expect(countOpenTodos(replayThenSnapshot)).toEqual({ pending: 2, inProgress: 0, source: "todo list snapshot" });
    const snapshotThenReplay = [result("[pending] #1 A\n[pending] #2 B"), result("Updated #2 (pending → completed)")];
    expect(countOpenTodos(snapshotThenReplay)).toEqual({ pending: 1, inProgress: 0, source: "todo mutation results" });
  });

  it("does not let a tool error poison the reading — it says nothing about the list", () => {
    const entries = [result("Created #1: A (pending)"), result("Error: id required for update"), result('Validation failed for tool "todo":\n  - action: missing'), result("Todo #99 not found")];
    expect(countOpenTodos(entries)).toEqual({ pending: 1, inProgress: 0, source: "todo mutation results" });
  });

  it("refuses the whole reading when a todo result is something it has never seen", () => {
    // Better "undecidable" than a confident count built on half the history.
    expect(countOpenTodos([result("Created #1: A (pending)"), result("I rewrote the list for you, boss.")])).toBeNull();
  });

  it("refuses a snapshot line whose status it does not know", () => {
    expect(countOpenTodos([result("[waiting-for-review] #1 A")])).toBeNull();
  });

  it("ignores results from a different tool entirely", () => {
    const bash = { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "[completed] #1 nonsense" }] } };
    expect(countOpenTodos([bash])).toBeNull();
  });

  it("follows a real host history end to end", () => {
    // The shape of an actual run: creates, updates, one snapshot late, then two closes.
    const entries = [
      result("Created #1: Design + backend abstraction types (pending)"),
      result("Updated #1 (pending → completed)"),
      result("Created #2: MCP backend (pending)"),
      result("Updated #2 (pending → in_progress)"),
      result("[completed] #1 Design + backend abstraction types\n[in_progress] #2 MCP backend"),
      result("Updated #2 (in_progress → completed)"),
    ];
    expect(countOpenTodos(entries)).toEqual({ pending: 0, inProgress: 0, source: "todo mutation results" });
  });
});

  it("survives the shapes it was never given without throwing", () => {
    const junk: unknown[] = [
      [],
      [null],
      [{ type: "message" }],
      [{ type: "message", message: {} }],
      [{ type: "message", message: { content: "a string" } }],
      // A tool call whose arguments are not an object at all.
      [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "todo", arguments: "not an object" }] } }],
      // A tool call whose list is not an object either.
      [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "todo", arguments: { todos: ["just", "strings"] } }] } }],
    ];
    for (const entry of junk) {
      expect(() => countOpenTodos(entry as never)).not.toThrow();
      expect(countOpenTodos(entry as never)).toBeNull();
    }
  });
});
