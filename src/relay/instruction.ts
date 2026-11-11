/**
 * relay/instruction — how a **browser**-relay reply becomes a worker instruction.
 *
 * This is deliberately a separate module from relay/protocol.ts, because the two
 * transports see different things. The proxy transport receives the assistant's
 * markdown, so its contract is a terminal marker at the end of the text. The
 * browser transport reads a **rendered page**, and a rendered answer carries no
 * markdown at all: measured against the live DOM on 2026-11-08, a reply containing
 * two fenced blocks exposed **zero** backtick characters in `innerText` — each block
 * is a `<pre>` whose `figure` holds a `figcaption` (the language label) and a `div`
 * wrapping the `code` element that holds the content. `pre.innerText` also leaks the
 * label ("text"), measured as a 5-character difference on every block observed
 * (7195/7190, 776/771, 150/145), which is why blocks arrive here already split into
 * `label` and `content` by the adapter rather than as text to be parsed.
 *
 * The carrier is therefore **content, not language label**. A reply asked, in words,
 * for a block labelled `prompt` came back labelled `text` — Perplexity's default —
 * so label matching cannot be relied on, while content compliance held exactly. The
 * instruction is the block whose first line is the marker.
 *
 * Rules, and why they are strict:
 * - the marker must be the block's first **non-blank** line, and the whole of it
 *   (an optional trailing colon is tolerated because models add one);
 * - only the marker line is removed. Everything else keeps its characters exactly
 *   as written, which is the same exception the terminal-marker grammar makes;
 * - **two marker blocks is never resolved.** Guessing between them is how an example
 *   code block gets dispatched as an instruction, so the caller pauses instead;
 * - a marker with nothing after it is reported as `empty`, not as a blank
 *   instruction — an empty instruction must never reach the worker;
 * - no marker block, or no block at all, means **no next instruction**. It is not a
 *   failure and it is not a completion: only the caller, with the worker's todo
 *   state, may decide that the run is over.
 */

/** One code block of a rendered answer, as the adapter read it from the DOM. */
export interface ReplyBlock {
  /** The `figcaption` label, normalised to lower case; `""` when the block has none. */
  label: string;
  /** The `code` element's text — clean content, never the block's `innerText`. */
  content: string;
}

/** The convention the operator states in the chat itself; nothing here injects it. */
export const DEFAULT_INSTRUCTION_MARKER = "NEXT AGENT INSTRUCTION";

export type MarkedInstruction =
  | { kind: "instruction"; text: string; blockIndex: number; blockLabel: string }
  | { kind: "none"; blocks: number }
  | { kind: "empty"; blockIndex: number }
  | { kind: "ambiguous"; candidates: number[] };

/**
 * A marker line is the whole line, case-insensitively, with an optional trailing
 * colon. Anything else on the line — prose before it, or text after it — means this
 * block is not the instruction block; a reply that merely *mentions* the marker in a
 * sentence about the protocol is a normal thing for a coding chat to do.
 */
export function isMarkerLine(line: string, marker: string): boolean {
  const want = marker.trim().toLowerCase();
  if (!want) return false;
  const got = line.trim().toLowerCase().replace(/:$/, "");
  return got === want;
}

/** Index of the first non-blank line, or -1 when the block holds nothing but blanks. */
function firstContentLine(lines: string[]): number {
  return lines.findIndex((l) => l.trim() !== "");
}

/**
 * Pick the instruction block. `blockIndex` is the position in `blocks`, so the
 * caller can report *which* block it acted on rather than only what it contained.
 */
export function extractMarkedInstruction(blocks: ReplyBlock[], marker: string = DEFAULT_INSTRUCTION_MARKER): MarkedInstruction {
  const hits: number[] = [];
  blocks.forEach((block, index) => {
    const lines = block.content.replace(/\r\n/g, "\n").split("\n");
    const first = firstContentLine(lines);
    if (first >= 0 && isMarkerLine(lines[first], marker)) hits.push(index);
  });

  if (hits.length === 0) return { kind: "none", blocks: blocks.length };
  if (hits.length > 1) return { kind: "ambiguous", candidates: hits };

  const index = hits[0];
  const block = blocks[index];
  const lines = block.content.replace(/\r\n/g, "\n").split("\n");
  const first = firstContentLine(lines);
  // Remove the marker line and nothing else, then drop only the outer whitespace the
  // removal exposed — interior indentation is the instruction's own.
  const kept = [...lines.slice(0, first), ...lines.slice(first + 1)].join("\n").trim();
  if (!kept) return { kind: "empty", blockIndex: index };
  return { kind: "instruction", text: kept, blockIndex: index, blockLabel: block.label };
}

/**
 * What goes back into the browser thread after a worker run: **the worker's own
 * text, as is** — no `Local coding agent result:` header, no extension notes, no
 * persona. That is the product, so the only brake is the size ceiling, and the
 * ceiling says what it removed rather than quietly shortening the message.
 */
export function buildBrowserResultMessage(
  workerText: string,
  options: { maxChars?: number; truncate?: (text: string, maxChars: number) => { text: string; omitted: number } }
): { text: string; omitted: number } {
  const maxChars = options.maxChars ?? 24_000;
  const body = workerText ?? "";
  if (!options.truncate) return { text: body, omitted: 0 };
  const truncated = options.truncate(body, maxChars);
  return { text: truncated.text, omitted: truncated.omitted };
}

/**
 * The completion question, kept as a pure function so the rule is testable without
 * a browser or a worker. Both halves are required, exactly as agreed:
 *
 *   the chat gave no next instruction   **and**
 *   the worker has no open todos
 *
 * A reply that merely says "all done!" while still handing over a block keeps
 * running (that is `instruct`, not complete); a reply with no block but open todos
 * is `stalled` and pauses, because one of the two authorities disagrees and the
 * human should see that rather than a silent stop or a silent continue.
 */
export type CompletionVerdict =
  | { action: "instruct"; text: string }
  | { action: "complete"; reply: string }
  | { action: "stalled"; reason: string }
  | { action: "ambiguous"; reason: string }
  | { action: "empty"; reason: string };

/**
 * Whether the adapter actually captured a finished assistant answer — the input that makes
 * "the reply contains no instruction block" mean something different from "there was no reply".
 *
 * Collapsing those two is the single most dangerous shortcut available here: the first live run
 * (2026-11-09) produced a final answer of 152 chars with no code block, which under the agreed
 * convention means **done**. If an extraction that found nothing, or an answer still streaming,
 * were allowed to look the same, the relay would declare the work finished on the strength of a
 * page it never read. So capture is asserted, not assumed, and anything the adapter did not
 * confirm arrives here as `unreadable` or `incomplete`.
 */
export type ReplyCapture =
  /** The answer was extracted and the adapter confirmed the reply finished. */
  | { state: "complete"; text: string }
  /** No answer could be read (no partition, empty extraction, an adapter that did not confirm). */
  | { state: "unreadable"; reason: string }
  /** An answer is visible but its completion is uncertain — streaming, unstable, or not confirmed. */
  | { state: "incomplete"; reason: string };

/** The minimum the adapter contract has to say for capture to be assessable. */
export interface AnswerEvidence {
  answerText: string;
  blocks: readonly unknown[];
  generating: boolean;
  /** Absent means the adapter never confirmed the reply finished — never treated as confirmed. */
  answerComplete?: boolean;
  status: string;
  stableReads: number;
}

/**
 * Judge the capture before judging its content. Order matters: an answer that is still arriving
 * must never dispatch a block either, because the instruction would be the first half of a
 * sentence the model had not finished writing.
 */
/** Characters that occupy no visual width: zero-width space/joiners, BOM, line/paragraph separators. */
const INVISIBLE = /[\u200b-\u200f\u2028\u2029\u2060\ufeff]/g;

/** Blank to a human reader, which is the only standard that matters when asking "is there an answer?". */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "").trim() === "";
}

export function assessCapture(answer: AnswerEvidence): ReplyCapture {
  if (answer.generating) {
    return { state: "incomplete", reason: `the page is still generating (status ${JSON.stringify(answer.status)}, ${answer.stableReads} stable read(s)), so its answer is not final.` };
  }
  if (answer.answerComplete !== true) {
    // Covers an older or simplified adapter that reports no completion signal at all.
    return { state: "incomplete", reason: "the adapter did not confirm the reply finished, so the run will not infer completion from an answer it cannot vouch for." };
  }
  // `String.prototype.trim` does NOT strip zero-width characters, so a `.trim()`-only test
  // would accept an extraction made entirely of them. Under the "no block means done" rule that
  // would end a live run on the strength of an answer that renders as nothing at all.
  if (isBlank(answer.answerText)) {
    return { state: "unreadable", reason: "no assistant answer could be extracted from the reply — the answer partition was absent or empty. This is NOT the same as a reply that contains no instruction block." };
  }
  return { state: "complete", text: answer.answerText };
}

/**
 * The conversation contract, and nothing else.
 *
 * This mode has one agreement with the chat, stated in the thread itself: the next instruction is
 * the code block whose first line is the marker; **no such block means the work is finished**.
 * That is a contract between two parties about the content of a message, so the gate reads only
 * the message — never the worker's todo list, never a guess.
 *
 * The live run of 2026-11-09 proved why the gate must not reach for extra authority. Perplexity
 * closed the thread with "…Nothing remains open." and no block; the run still refused to finish,
 * because the worker had never opened a todo and the old rule read an unreadable list as evidence
 * that work remained. A worker is not required to keep a todo list, and a host without a todo tool
 * must not be able to prevent a conversation from ending. Todo inspection is still available
 * (src/browser/todos.ts) and still worth showing an operator — it is simply not a veto here.
 */
export function decideConversationCompletion(picked: MarkedInstruction, capture: ReplyCapture): CompletionVerdict {
  // Capture comes first: with no confirmed answer, neither "dispatch" nor "complete" is a
  // defensible reading.
  if (capture.state === "unreadable") return { action: "stalled", reason: capture.reason };
  if (capture.state === "incomplete") return { action: "stalled", reason: capture.reason };

  switch (picked.kind) {
    case "instruction":
      return { action: "instruct", text: picked.text };
    case "ambiguous":
      return {
        action: "ambiguous",
        reason: `${picked.candidates.length} code blocks open with the instruction marker (blocks ${picked.candidates
          .map((i) => i + 1)
          .join(", ")}). Picking one is a guess, so nothing was sent to the worker.`,
      };
    case "empty":
      return {
        action: "empty",
        reason: `code block ${picked.blockIndex + 1} is the instruction block but holds nothing after the marker. An empty instruction is never dispatched.`,
      };
    case "none":
      // The convention: silence is the verdict. Show the operator what the chat actually said.
      return { action: "complete", reply: capture.text.replace(INVISIBLE, "").trim() };
  }
}
