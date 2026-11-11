/**
 * decision — one decision parser for every backend.
 *
 * `parseDecision`        lenient, keeps the historical model-backend contract:
 *                        anything unparseable collapses to `continue` so a live
 *                        chat is never interrupted by a bad supervisor reply.
 * `parseSupervisorReply` strict, used by the MCP idle loop: reports exactly which
 *                        field is missing or invalid so the caller can spend its
 *                        single repair attempt or pause with a useful message.
 */

import type { CompletionCriterion, SteeringDecision } from "./types.js";

/** Pull the JSON object out of bare JSON, ``` fences, or prose around the JSON. */
const ACTIONS = new Set(["steer", "done", "blocked", "continue"]);

export function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  const trimmed = text.trim();
  return trimmed.startsWith("{") ? trimmed : null;
}

/** Parse `{"action":…}` into an object, or null when the text holds no JSON object. */
export function readDecisionObject(text: string): Record<string, unknown> | null {
  const candidates: Record<string, unknown>[] = [];
  for (const source of extractJsonCandidates(text ?? "")) {
    for (const candidate of [source, repairCommas(source)]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) candidates.push(parsed as Record<string, unknown>);
      } catch {
        // try the next candidate, then give up — the caller reports it as unparseable
      }
    }
  }
  if (candidates.length === 0) return null;
  // A chatty reply often carries several objects: the decision, a usage counter,
  // and sometimes the contract echoed back as an example. Position is a poor cue,
  // so score by content — a recognised action counts, and the fields the contract
  // requires count again, which is what separates a real answer from a stub.
  const score = (candidate: Record<string, unknown>): number => {
    let value = 0;
    if (ACTIONS.has(String(candidate.action))) value += 4;
    else if (typeof candidate.action === "string") value += 1;
    if (typeof candidate.instruction === "string" || typeof candidate.message === "string") value += 2;
    if (typeof candidate.reasoning === "string") value += 1;
    if (Array.isArray(candidate.criteria) || typeof candidate.blocker === "string") value += 1;
    return value;
  };

  return [...candidates].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Every JSON object the text could be, best guess first: a fenced block, then
 * each top-level object in source order, then the widest brace-to-brace span.
 */
export function extractJsonCandidates(text: string): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) {
    push(fenced[1]);
    for (const inner of balancedObjects(fenced[1])) push(inner);
  }
  for (const object of balancedObjects(text)) push(object);
  push(extractJson(text));
  return out;
}

/** Top-level `{...}` spans, honouring strings and escapes so braces in prose do not split an object. */
function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Models occasionally emit a trailing comma. Repairing that one defect keeps a
 * perfectly good instruction from costing a repair round; anything worse stays
 * unparseable and goes through the bounded repair path.
 */
function repairCommas(json: string): string | null {
  const repaired = json.replace(/,(\s*[}\]])/g, "$1");
  return repaired === json ? null : repaired;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}

function readCriteria(v: unknown): CompletionCriterion[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: CompletionCriterion[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") return undefined;
    const o = item as Record<string, unknown>;
    const criterion = asString(o.criterion ?? o.criteria ?? o.requirement);
    if (!criterion) return undefined;
    const evidence = asString(o.evidence ?? o.proof) ?? "";
    const metRaw = o.met ?? o.satisfied ?? o.passed;
    // Evidence-less entries can never count as met, whatever the model claimed.
    out.push({ criterion, evidence, met: metRaw === true && evidence.length > 0 });
  }
  return out;
}

function readStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
  return list.length ? list : [];
}

/** Tolerant read of any backend response into the shared decision shape. */
export function parseDecision(text: string): SteeringDecision {
  const parsed = readDecisionObject(text);
  if (!parsed) return safeContinue("Failed to parse supervisor JSON decision");
  return normalize(parsed, "Invalid action in supervisor response");
}

function normalize(parsed: Record<string, unknown>, invalidReason: string): SteeringDecision {
  const action = parsed.action;
  if (action !== "continue" && action !== "steer" && action !== "done" && action !== "blocked") {
    return safeContinue(invalidReason);
  }
  const decision: SteeringDecision = {
    action,
    message: asString(parsed.message ?? parsed.instruction),
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
  };
  const criteria = readCriteria(parsed.criteria ?? parsed.assessment);
  if (criteria) decision.criteria = criteria;
  const unresolved = readStringList(parsed.unresolved ?? parsed.unresolvedFailures);
  if (unresolved) decision.unresolved = unresolved;
  const blocker = asString(parsed.blocker ?? parsed.reason);
  if (action === "blocked" && blocker) decision.blocker = blocker;
  const acceptance = readStringList(parsed.acceptanceCriteria ?? parsed.criteriaAsStrings);
  if (acceptance) decision.acceptanceCriteria = acceptance;
  return decision;
}

export function safeContinue(reason: string): SteeringDecision {
  return { action: "continue", reasoning: reason, confidence: 0 };
}

// ---- Strict validation for the autonomous (idle) loop ----

export type DecisionProblem =
  | "unparseable" // no JSON object at all
  | "invalid-action" // action missing or not one of steer|done|blocked
  | "missing-instruction" // steer without a non-empty worker instruction
  | "invalid-criteria" // done without a criteria array
  | "missing-evidence" // done with a criterion that has no evidence
  | "unresolved-failures" // done while known failures remain
  | "missing-blocker"; // blocked without naming what is missing

export interface ValidatedDecision {
  ok: boolean;
  decision: SteeringDecision;
  problems: DecisionProblem[];
  /** Human-readable summary — safe to show to the user and to send back as repair. */
  summary: string;
}

const PROBLEM_TEXT: Record<DecisionProblem, string> = {
  unparseable: "the reply was not a JSON object",
  "invalid-action": 'action must be "steer", "done", or "blocked"',
  "missing-instruction": 'action "steer" needs a non-empty "instruction" for the worker',
  "invalid-criteria": 'action "done" needs a "criteria" array of {criterion, evidence, met}',
  "missing-evidence": 'every "done" criterion needs concrete "evidence"',
  "unresolved-failures": 'action "done" is not allowed while "unresolved" lists open failures',
  "missing-blocker": 'action "blocked" needs a "blocker" naming what is missing',
};

/**
 * Validate a supervisor reply for the idle loop.
 *
 * `allowContinue` keeps the model-backed mid-run path compatible (there "do
 * nothing" is a legitimate answer). In the MCP loop it stays false: `continue`
 * would stall a run that has no other way to make progress.
 */
export function validateDecision(parsed: Record<string, unknown> | null, allowContinue = false): ValidatedDecision {
  if (!parsed) {
    const decision = safeContinue("Unparseable supervisor reply");
    return { ok: false, decision, problems: ["unparseable"], summary: PROBLEM_TEXT.unparseable };
  }

  const decision = normalize(parsed, "invalid");
  const problems: DecisionProblem[] = [];
  const allowed = allowContinue ? ["continue", "steer", "done", "blocked"] : ["steer", "done", "blocked"];

  if (!allowed.includes(decision.action)) {
    problems.push("invalid-action");
  } else if (decision.action === "steer" && !decision.message?.trim()) {
    problems.push("missing-instruction");
  } else if (decision.action === "blocked" && !decision.blocker?.trim()) {
    problems.push("missing-blocker");
  } else if (decision.action === "done") {
    if (!decision.criteria || decision.criteria.length === 0) {
      problems.push("invalid-criteria");
    } else if (decision.criteria.some((c) => !c.met || !c.evidence.trim())) {
      problems.push("missing-evidence");
    }
    if (decision.unresolved && decision.unresolved.length > 0) problems.push("unresolved-failures");
  }

  if (decision.action === "continue") decision.message = undefined;
  const summary = problems.length ? problems.map((p) => PROBLEM_TEXT[p]).join("; ") : "ok";
  return { ok: problems.length === 0, decision, problems, summary };
}

/**
 * Strict entry point used by the MCP backend: validates against the reply's own
 * JSON, treating `continue` as invalid.
 */
export function parseSupervisorReply(text: string): ValidatedDecision {
  return validateDecision(readDecisionObject(text), false);
}

/** Prompt asking for a corrected reply. Carries the invalid text back to the supervisor. */
export function buildRepairPrompt(raw: string, summary: string, maxChars: number): string {
  const excerpt = raw.length > maxChars ? `${raw.slice(0, maxChars)}…[truncated]` : raw;
  return [
    "Your previous reply could not be used.",
    `Problem: ${summary}`,
    "",
    "Previous reply:",
    excerpt,
    "",
    "Reply again with ONLY a single valid JSON object — no prose, no code fences.",
    'Required shape (one of):',
    '{"action":"steer","instruction":"<what the worker must do next>","reasoning":"<why>"}',
    '{"action":"done","reasoning":"<why>","criteria":[{"criterion":"<criterion>","evidence":"<command + result>","met":true}],"unresolved":[]}',
    '{"action":"blocked","blocker":"<the missing permission, credential, or decision>","reasoning":"<why>"}',
  ].join("\n");
}

/**
 * Pull a decision out of a tool's `structuredContent`. Servers disagree about
 * shape: some return the decision object directly, some wrap it as a string
 * under a single key (`{"result":"{\"action\":\"steer\"…}"}`), which is a
 * perfectly reasonable thing for a proxy that only ever returns text to do.
 * Returning null means "fall back to the text", never "the reply is bad".
 */
export function decisionFromStructured(value: unknown, depth = 0): Record<string, unknown> | null {
  if (typeof value === "string") return readDecisionObject(value);
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return null;

  const record = value as Record<string, unknown>;
  if (typeof record.action === "string") return record;

  for (const nested of Object.values(record)) {
    const found = decisionFromStructured(nested, depth + 1);
    if (found) return found;
  }
  return null;
}
