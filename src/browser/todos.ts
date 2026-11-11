/**
 * browser/todos — the worker's open todo count, when this session actually has one.
 *
 * Why this is a lookup rather than a field: **pi 1.5.0 core has no todo concept.**
 * Verified directly — no todo accessor exists on `ExtensionContext` in any 1.5.0 `.d.ts`,
 * and no real pi session on this machine contains a `todo` tool call. A todo list exists
 * only when an **extension or host build** provides one. So which shapes have to be read
 * is a property of the operator's host, not of this extension, and the shapes below were
 * read off that host's own recorded output rather than invented.
 *
 * Three sources, in order of authority:
 *
 *  1. A **snapshot**: a `list`-style result that prints the whole current list. Authoritative,
 *     because it does not depend on having seen the history.
 *  2. A **query-shaped call**: a tool call whose arguments carry a list of items with a status
 *     each (pi's `plan-mode` example does this).
 *  3. A **replay of mutation results** — `Created #3: … (pending)`, `Updated #3 (pending →
 *     completed)`, `Deleted #3`, `Cleared N todos`. Pi-Bolt's built-in tool is mutation-shaped,
 *     which is why a snapshot-only reader would return "unknown" on the very host this relay is
 *     built for. This is a replay, not a guess: every call is in the session, and the ids come
 *     from the tool's own output.
 *
 * The rule that makes this safe: **when anything is unrecognised, return `null`.** `null` means
 * "undecidable", and `relay/instruction.ts` turns that into a pause. Reading an absent or
 * half-parsed list as empty is how a run declares itself finished in the middle of a task —
 * which is why an unknown status, an unparseable result line, or a status-less list all refuse
 * rather than default to zero.
 *
 * String evidence (2026-11-09), from the host's own session file
 * `~/.pi/agent/sessions/--home-pseudobacon-ai-pi-supervisor--/…01a1b6ed….jsonl`:
 *   `Created #1: Design + backend abstraction types (pending)`
 *   `Updated #1 (pending → completed)`
 *   `No change: #12 already matches the requested values (status: completed)`
 *   `[completed] #1 Design + backend abstraction types` / `[in_progress] #2 … (Building …)`
 *   `Cleared 4 todos`  (Pi-Bolt's example extension: `Added todo #1: …`, `Todo #1 completed`)
 */

export interface OpenTodos {
  pending: number;
  inProgress: number;
  /** How the count was derived, for `/supervise status`. Never a secret. */
  source: string;
}

/** Statuses meaning "not finished", across the shapes seen in the wild. */
const OPEN = new Set(["pending", "in_progress", "in progress", "inprogress", "started", "active", "blocked", "creating"]);
/** Statuses meaning "no more work here", including tombstones. */
const DONE = new Set(["completed", "complete", "done", "cancelled", "canceled", "deleted", "x"]);

/** id → status, built by the replay path. */
type Ledger = Map<number, string>;

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface EntryLike {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    toolName?: unknown;
    toolCallId?: unknown;
  };
}

function isTodoish(name: unknown): boolean {
  return typeof name === "string" && /todo|task|plan/i.test(name);
}

function blocks(entry: EntryLike): unknown[] {
  const content = entry.message?.content;
  return Array.isArray(content) ? content : [];
}

function toolCallsIn(entry: unknown): ToolCall[] {
  // Entries come from the host and are not our type: a null or non-object entry is skipped,
  // never dereferenced. One malformed entry must not abort a completion check.
  if (typeof entry !== "object" || entry === null) return [];
  const found: ToolCall[] = [];
  for (const block of blocks(entry as EntryLike)) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "toolCall" && b.type !== "toolUse" && b.type !== "tool_use") continue;
    const name = typeof b.name === "string" ? b.name : typeof b.toolName === "string" ? b.toolName : "";
    if (!isTodoish(name)) continue;
    const rawArgs = b.arguments ?? b.input ?? b.args;
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
    found.push({ name, args });
  }
  return found;
}

/** The text of a toolResult message, or "" when the entry is not one. */
function todoResultText(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const message = (entry as EntryLike).message;
  if (message?.role !== "toolResult") return null;
  if (!isTodoish(message.toolName)) return null;
  const text = blocks(entry as EntryLike)
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const b = block as Record<string, unknown>;
      return typeof b.text === "string" ? b.text : "";
    })
    .join("\n")
    .trim();
  return text || null;
}

function normaliseStatus(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return s;
}

/** A `list` snapshot: EVERY non-empty line is `[status] #id …`. Anything else is not a snapshot. */
function parseSnapshot(text: string): Ledger | null {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;
  const ledger: Ledger = new Map();
  for (const line of lines) {
    const hit = line.match(/^\[\s*([A-Za-z_ -]+?)\s*\]\s+#(\d+)\b/);
    if (!hit) return null;
    ledger.set(Number(hit[2]), normaliseStatus(hit[1]));
  }
  return ledger;
}

/**
 * One mutation result. Returns the ledger change, or `null` when the line is not a recognised
 * mutation — which the caller treats as "this reading is no longer trustworthy".
 */
function parseMutation(text: string, ledger: Ledger): boolean {
  const line = text.trim();
  if (!line) return true;
  // Errors and refusals say nothing about the list, so they neither change nor poison it.
  if (/^(error|validation failed|unknown action|.*not found)/i.test(line)) return true;

  let hit = line.match(/^Created #(\d+)\b.*\(([^()]+)\)\s*$/i);
  if (hit) {
    ledger.set(Number(hit[1]), normaliseStatus(hit[2]));
    return true;
  }
  // `Updated #1 (pending → completed)` — the arrow is U+2192 or an ASCII fallback.
  hit = line.match(/^Updated #(\d+)\b.*(?:→|->)\s*([^()]+)\)\s*$/i);
  if (hit) {
    ledger.set(Number(hit[1]), normaliseStatus(hit[2]));
    return true;
  }
  // `No change: #12 already matches the requested values (status: completed)`
  hit = line.match(/^No change:\s*#(\d+)\b.*\(status:\s*([^)]+)\)/i);
  if (hit) {
    ledger.set(Number(hit[1]), normaliseStatus(hit[2]));
    return true;
  }
  hit = line.match(/^Deleted #(\d+)\b/i);
  if (hit) {
    ledger.set(Number(hit[1]), "deleted");
    return true;
  }
  // pi's example extension creates without stating a status: `Added todo #7: ship it`.
  hit = line.match(/^Added todo #(\d+)\b/i);
  if (hit) {
    ledger.set(Number(hit[1]), "pending");
    return true;
  }
  // pi's example extension: `Todo #1 completed` / `Todo #1 uncompleted`.
  hit = line.match(/^Todo #(\d+)\s+(completed|uncompleted|pending|done)\b/i);
  if (hit) {
    const done = /completed|done/i.test(hit[2]);
    ledger.set(Number(hit[1]), done ? "completed" : "pending");
    return true;
  }
  if (/^Cleared\b/i.test(line)) {
    ledger.clear();
    return true;
  }
  return false;
}

/** Items from a status-bearing list passed in the CALL arguments (plan-mode's shape). */
function statusList(args: Record<string, unknown>): Ledger | null {
  for (const key of ["todos", "tasks", "items", "plan"]) {
    const value = args[key];
    if (!Array.isArray(value) || value.length === 0) continue;
    const ledger: Ledger = new Map();
    let id = 0;
    let seen = 0;
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const status = item.status ?? item.state;
      if (typeof status !== "string") continue; // a list without statuses says nothing
      seen++;
      const rawId = item.id ?? item.taskId;
      const numeric = typeof rawId === "number" ? rawId : Number(rawId);
      ledger.set(Number.isFinite(numeric) ? numeric : ++id, normaliseStatus(status));
    }
    if (seen === 0) continue;
    return ledger;
  }
  // A single-item update ({"action":"update","status":"completed"}) is not a list and cannot
  // say how many items exist, so it is ignored rather than counted.
  return null;
}

export interface TodoReading {
  todos: OpenTodos | null;
  /** Why it is null, when it is. For `/supervise status`, never a secret. */
  reason: string;
}

/**
 * The newest authoritative reading wins, which is why entries are walked in session order.
 * Returns `null` (with a reason) rather than a confident zero when the session has no list
 * this extension can read, or when part of it could not be parsed.
 */
export function readOpenTodos(entries: readonly unknown[]): TodoReading {
  let ledger: Ledger | null = null;
  let source = "";
  let poisoned = "";

  for (const raw of entries) {
    // A snapshot result resets the picture completely: it is the tool's own current truth.
    const resultText = todoResultText(raw);
    if (resultText !== null) {
      const snapshot = parseSnapshot(resultText);
      if (snapshot) {
        ledger = snapshot;
        source = "todo list snapshot";
        poisoned = "";
        continue;
      }
      const next: Ledger = ledger ? new Map(ledger) : new Map();
      if (!parseMutation(resultText, next)) {
        // Unparseable output from a tool we do not own: stop claiming to know the list.
        poisoned = `unrecognised todo tool output: ${JSON.stringify(resultText.slice(0, 60))}`;
        ledger = null;
        source = "";
      } else if (ledger === null || next.size !== ledger.size || [...next].some(([k, v]) => ledger?.get(k) !== v)) {
        ledger = next;
        source = "todo mutation results";
      }
      continue;
    }

    for (const call of toolCallsIn(raw)) {
      const list = statusList(call.args);
      if (!list) continue;
      ledger = list;
      source = `${call.name} call carried ${list.size} item(s)`;
      poisoned = "";
    }
  }

  if (poisoned) return { todos: null, reason: poisoned };
  if (!ledger) return { todos: null, reason: "no todo list was found in this session (the worker's host may not provide a todo tool)" };

  let pending = 0;
  let inProgress = 0;
  let unknown = 0;
  for (const status of ledger.values()) {
    if (OPEN.has(status)) {
      if (status.startsWith("in_") || status === "in_progress") inProgress++;
      else pending++;
    } else if (!DONE.has(status)) unknown++;
  }
  // An unrecognised status is neither open nor closed, so neither is claimed.
  if (unknown > 0) return { todos: null, reason: `${unknown} todo(s) with a status this extension does not know` };
  return { todos: { pending, inProgress, source }, reason: "" };
}

/** The count only, for callers that do not care why. */
export function countOpenTodos(entries: readonly unknown[]): OpenTodos | null {
  return readOpenTodos(entries).todos;
}
