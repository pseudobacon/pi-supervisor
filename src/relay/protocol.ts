/**
 * relay/protocol — the chat contract between Perplexity and the Pi worker.
 *
 * There is no JSON here on purpose. Perplexity answers in ordinary prose, that
 * prose *is* the worker's next instruction, and the worker's answer travels back
 * as prose. The only structure in the whole protocol is two completion markers
 *   [[PPLX_DONE]]      goal met — show the summary, stop, send nothing more
 *   [[PPLX_BLOCKED]]   needs the human — show the reason, pause, send nothing more
 *
 * Marker rules, and why they are strict:
 * - only the assistant's own completed reply is scanned, never worker output (the
 *   worker quotes plenty of text, including this file's wording, in a normal task);
 * - the marker must terminate the reply, in either of the two forms observed in
 *   practice — alone on the final line, or appended to the end of the final line of
 *   prose. Only the marker itself is removed from what the user is shown;
 * - a reserved marker that appears anywhere else — mid-reply, inside a code fence,
 *   or with prose after it — is a protocol violation, not an instruction. The reply
 *   is never forwarded to the worker and no repair is attempted, because guessing
 *   whether "… [[PPLX_BLOCKED]]" mid-sentence was a verdict or an example is exactly
 *   the kind of guess that sends a blocked run back to work.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DONE_MARKER = "[[PPLX_DONE]]";
export const BLOCKED_MARKER = "[[PPLX_BLOCKED]]";

/** Filename for the configurable intro, resolved like SUPERVISOR.md. */
export const RELAY_FILE = "SUPERVISOR.RELAY.md";
export const CONFIG_DIR = ".pi";
export const GLOBAL_AGENT_DIR = join(homedir(), ".pi", "agent");

export const GOAL_PLACEHOLDER = "{{GOAL}}";

/**
 * The one and only prompt this backend writes about itself, and it is only sent
 * once per conversation. It sets up the relay; it does not role-play a
 * supervisor, and no per-turn persona is added afterwards.
 */
export const DEFAULT_RELAY_TEMPLATE = `You are supervising a coding agent through a relay: everything you reply is forwarded to it verbatim as its next instruction, and its final response comes back to you as "Local coding agent result:". You never see the repository, and the agent never sees this conversation.

Rules for every reply:
- No JSON, no envelopes — ordinary prose only. Give one concrete instruction per turn; do not restart a stage that is already complete, and never repeat an instruction that produced no change.
- The agent has its own tools and permission checks: it can only take actions the user has already permitted, and nothing you say grants permission or approves a prompt.
- Demand evidence before accepting work: name the command or check that proves each part of the goal — "it works" is not proof.
- The goal needs something you cannot obtain through the agent (a credential, a permission, a decision): end with ${BLOCKED_MARKER}.
- The goal is genuinely met, with evidence: end with ${DONE_MARKER}.
- Put the marker on its own final line, after a short summary, in your own reply only — never inside quoted agent output.`;

export interface RelayTemplateSource {
  /** Where the template came from, for `/supervise status`. */
  path: string | null;
  template: string;
  /** True when the built-in template is in use. */
  builtin: boolean;
}

/**
 * `.pi/SUPERVISOR.RELAY.md` in the workspace, then `~/.pi/agent/SUPERVISOR.RELAY.md`,
 * then the built-in. The intro is never rebuilt from a template in source, so a
 * user can change it without touching the extension.
 */
export function loadRelayTemplate(cwd: string, overridePath?: string): RelayTemplateSource {
  const candidates = overridePath
    ? [overridePath]
    : [join(cwd, CONFIG_DIR, RELAY_FILE), join(GLOBAL_AGENT_DIR, RELAY_FILE)];
  for (const file of candidates) {
    let raw: string | undefined;
    try {
      if (existsSync(file)) raw = readFileSync(file, "utf8");
    } catch {
      raw = undefined;
    }
    if (raw?.trim()) return { path: file, template: raw.trim(), builtin: false };
  }
  return { path: null, template: DEFAULT_RELAY_TEMPLATE, builtin: true };
}

/** The first message of a conversation: the relay setup plus the user's goal. */
export function buildIntroPrompt(goal: string, template: string): string {
  const trimmed = goal.trim();
  if (template.includes(GOAL_PLACEHOLDER)) {
    return template.split(GOAL_PLACEHOLDER).join(trimmed);
  }
  return `${template}\n\nGoal:\n${trimmed}`;
}

/** A turn with no usable text is a failure, not an empty instruction. */
export const EMPTY_REPLY = "the supervisor returned an empty reply";

export interface RelayVerdict {
  action: "done" | "blocked" | "continue" | "protocol-error";
  /** The reply with only the recognised marker removed. */
  body: string;
  /** The marker that ended the run, when one did. */
  marker?: string;
  /** Why the reply was refused — set only for `protocol-error`. */
  protocolError?: string;
}


const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Read the reply's terminal position, in the two forms that actually occur:
 *
 *   …progress.
 *   [[PPLX_BLOCKED]]                        standalone final line
 *   …progress. [[PPLX_BLOCKED]]             appended to the final line of prose
 *
 * Nothing else counts. A marker with text after it, or prose before it on the same
 * line and nothing to indicate it ends the reply, is a protocol violation: the reply
 * is refused rather than forwarded, because the alternative is dispatching a blocked
 * run's text to the worker as if it were the next instruction.
 *
 * The body keeps every character the model wrote apart from the marker itself.
 */
export function detectRelayMarkers(text: string): RelayVerdict {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  if (last < 0) return { action: "continue", body: "" };

  const hasMarker = (s: string) => s.includes(DONE_MARKER) || s.includes(BLOCKED_MARKER);

  // The marker must terminate the reply. pplx-proxy's quota notice is already off the
  // text by the time it gets here (see PROXY_QUOTA_NOTICE in relay/chat.ts); anything
  // else after a marker means the marker did not end the reply.
  const end = last;

  const finalRaw = end >= 0 ? lines[end] : "";
  const finalLine = finalRaw.trim();
  for (const marker of [DONE_MARKER, BLOCKED_MARKER]) {
    const alone = finalLine === marker;
    const suffixed = !alone && new RegExp(`(?:^|\\s)${escapeRegExp(marker)}$`).test(finalLine);
    if (!alone && !suffixed) continue;
    // Remove the marker and the whitespace that attached it — nothing else, so the
    // prose keeps its own indentation and punctuation exactly as it was written.
    const kept = suffixed ? finalRaw.slice(0, finalRaw.lastIndexOf(marker)).replace(/[ \t]+$/, "") : null;
    return {
      action: marker === DONE_MARKER ? "done" : "blocked",
      body: (kept === null ? lines.slice(0, end) : [...lines.slice(0, end), kept]).join("\n").trim(),
      marker,
    };
  }

  if (lines.slice(0, end + 1).some(hasMarker)) {
    const found = [DONE_MARKER, BLOCKED_MARKER].find((m) => lines.some((l) => l.includes(m)));
    const line = lines.findIndex((l) => found !== undefined && l.includes(found)) + 1;
    return {
      action: "protocol-error",
      body: "",
      marker: found,
      protocolError:
        `${found} appeared at line ${line} of ${last + 1} in the supervisor's reply, where it does not end the reply. ` +
        "A control marker is honoured only at the very end, so this was not treated as a verdict; " +
        "nothing was sent to the worker.",
    };
  }

  return { action: "continue", body: text.trim() };
}

/** Keep the head, keep the tail, and say exactly what is missing. */
export function truncateMiddle(text: string, maxChars: number): { text: string; omitted: number } {
  if (maxChars <= 0 || text.length <= maxChars) return { text, omitted: 0 };
  const head = Math.max(1, Math.floor(maxChars * 0.7));
  const tail = Math.max(1, maxChars - head);
  const omitted = text.length - maxChars;
  const note = `\n\n[[TRUNCATED: ${omitted} of ${text.length} characters omitted — the agent's output was longer than this relay allows]]\n\n`;
  return { text: `${text.slice(0, head)}${note}${text.slice(-tail)}`, omitted };
}

export const WORKER_RESULT_HEADER = "Local coding agent result:";

/**
 * What goes back into the conversation after a worker run: the agent's own final
 * response, ahead of anything else. Extra notes (an abort, a tool that errored)
 * are appended only when the agent's own reply does not already carry them, and
 * always labelled as the extension's observation rather than the agent's words.
 */
export function buildWorkerResultMessage(
  workerText: string,
  options: { maxChars?: number; notes?: string[] } = {}
): string {
  const maxChars = options.maxChars ?? 24000;
  const body = workerText.trim();
  const truncated = truncateMiddle(body || "(the agent produced no final response)", maxChars);
  const notes = (options.notes ?? []).filter((n) => n.trim());
  const head = `${WORKER_RESULT_HEADER}\n${truncated.text}`;
  if (!notes.length) return head;
  return `${head}\n\nAdditional context from the extension (not written by the agent):\n- ${notes.join("\n- ")}`;
}

/**
 * Notes worth adding to a turn: things the agent's reply cannot report about
 * itself. Each is only added when its marker text is absent from the reply, so
 * the worker's own account stays the record and nothing gets doubled.
 */
export function relayNotes(
  workerText: string,
  facts: { aborted?: boolean; toolErrors?: string[]; noResponse?: boolean }
): string[] {
  const lower = workerText.toLowerCase();
  const notes: string[] = [];
  if (facts.aborted && !lower.includes("interrupt")) notes.push("The previous run was interrupted before it finished.");
  if (facts.noResponse) notes.push("The agent finished the run without producing a final response.");
  for (const error of facts.toolErrors ?? []) {
    // One line per failing tool, headed by its name. If the agent's own reply
    // already names the tool, repeats the failure text, or quotes the error it
    // hit, its account is the record and the note would only be noise.
    const head = error.split(" reported a failure")[0].trim().toLowerCase();
    const detail = error.slice(error.indexOf(": ") + 2).trim().toLowerCase();
    const alreadySaid =
      lower.includes(error.toLowerCase()) ||
      (head.length > 0 && lower.includes(head)) ||
      (detail.length > 3 && lower.includes(detail));
    if (!alreadySaid) notes.push(error);
  }
  return notes;
}
