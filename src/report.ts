/**
 * report — bounded, self-contained worker reports for the MCP supervisor.
 *
 * The proxy exposes single-shot question tools with no conversation id, so every
 * review has to carry everything the supervisor needs: the original goal and its
 * acceptance criteria, this iteration's instruction, what the worker actually
 * produced (assistant text, tool calls, failures, exit codes, changed files,
 * validation evidence), and a bounded history of earlier decisions.
 *
 * Truncation keeps what matters: critical failures are lifted into their own
 * section before anything is cut, and every omission is marked explicitly.
 */

import { redactSecrets } from "./redact.js";
import type { SteeringDecision } from "./types.js";

export interface ReportLimits {
  /** Hard cap on the whole report. */
  maxChars: number;
  /** Cap per assistant / tool-result item. */
  maxItemChars: number;
  /** Cap on the per-tool-argument summary. */
  maxArgsChars: number;
  /** How many earlier decision summaries to include. */
  historyItems: number;
}

export const DEFAULT_REPORT_LIMITS: ReportLimits = {
  maxChars: 24_000,
  maxItemChars: 1_500,
  maxArgsChars: 160,
  historyItems: 8,
};

/**
 * What the supervisor is allowed to see. Off by default? No — all four default to
 * true; these exist so a project can send less to a third-party endpoint. Critical
 * failures are collected regardless: turning off tool results must not hide a
 * failing command from the supervisor.
 */
export interface ReportInclude {
  toolCalls: boolean;
  toolResults: boolean;
  assistantOutput: boolean;
  changedFiles: boolean;
}

export const ALL_INCLUDE: ReportInclude = {
  toolCalls: true,
  toolResults: true,
  assistantOutput: true,
  changedFiles: true,
};

export interface ReportInput {
  goal: string;
  acceptanceCriteria: string[];
  /** 1-based supervision iteration. */
  iteration: number;
  maxIterations: number;
  /** The instruction the worker just ran under, if any. */
  instruction?: string;
  /** Raw session-branch entries since the last review (`ctx.sessionManager.getBranch()` items). */
  entries: unknown[];
  /** Decisions already taken, oldest first. Only summaries are sent. */
  history: Array<{ iteration: number; action: string; summary: string }>;
  /** True for the first request, before the worker has done anything. */
  initial?: boolean;
  limits?: Partial<ReportLimits>;
  /** Sections to withhold. Critical failures are always kept. */
  include?: Partial<ReportInclude>;
}

export interface WorkerActivity {
  assistantText: string[];
  toolCalls: string[];
  changedFiles: string[];
  validation: string[];
  failures: string[];
  /** The user turns the worker saw, which is how the supervisor sees its own steer. */
  userPrompts: string[];
}

const TESTISH = /\b(npm|pnpm|yarn|bun|pnpx|npx)\s+(run\s+)?(test|vitest|jest|playwright)|\b(vitest|pytest|jest|go test|cargo test|make test|ctest|rspec)\b|\b(tsc|biome|eslint|ruff|mypy|pyright)\b|npm (run )?(lint|typecheck|build)/i;
const WRITE_TOOLS = new Set(["write", "edit", "edit_file", "create_file", "multiedit", "multi_edit", "patch"]);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b?.type === "text" ? String(b.text ?? "") : ""))
      .join("\n")
      .trim();
  }
  return "";
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}… [+${clean.length - max} chars omitted]`;
}

function clipBlock(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = max - 40;
  return `${text.slice(0, Math.floor(cut / 2))}\n[…${text.length - max} characters omitted…]\n${text.slice(-Math.floor(cut / 2))}`;
}

/** Summarize the branch entries the worker produced since the previous review. */
export function summarizeActivity(
  entries: unknown[],
  limits: ReportLimits,
  include: ReportInclude = ALL_INCLUDE
): WorkerActivity {
  const out: WorkerActivity = {
    assistantText: [],
    toolCalls: [],
    changedFiles: [],
    validation: [],
    failures: [],
    userPrompts: [],
  };

  for (const raw of entries) {
    const entry = raw as any;
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "user") {
      const text = textOf(msg.content);
      if (text) out.userPrompts.push(clip(text, limits.maxItemChars));
      continue;
    }

    if (msg.role === "assistant") {
      const text = textOf(msg.content);
      if (text && include.assistantOutput) out.assistantText.push(clipBlock(text, limits.maxItemChars));

      const calls = Array.isArray(msg.content) ? msg.content.filter((b: any) => b?.type === "toolCall") : [];
      for (const call of calls) {
        if (include.toolCalls) out.toolCalls.push(`${call.name} ${clip(JSON.stringify(call.arguments ?? {}), limits.maxArgsChars)}`);

        const path = (call.arguments as any)?.path ?? (call.arguments as any)?.file_path ?? (call.arguments as any)?.file;
        if (include.changedFiles && typeof path === "string" && WRITE_TOOLS.has(String(call.name))) out.changedFiles.push(path);
      }

      const stop = typeof msg.stopReason === "string" ? msg.stopReason : "";
      const errorMessage = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
      if (stop && stop !== "stop" && stop !== "toolUse") {
        out.failures.push(`assistant stopped with "${stop}"${errorMessage ? `: ${clip(errorMessage, 200)}` : ""}`);
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const text = textOf(msg.content);
      const name = String(msg.toolName ?? "tool");
      const exitCode =
        typeof msg.details?.exitCode === "number"
          ? msg.details.exitCode
          : typeof msg.details?.exit_code === "number"
            ? msg.details.exit_code
            : undefined;

      if (msg.isError || (exitCode !== undefined && exitCode !== 0)) {
        const code = exitCode !== undefined ? ` exit=${exitCode}` : "";
        out.failures.push(`${name} failed${code}: ${clip(text, limits.maxItemChars)}`);
      } else if (include.toolResults && (TESTISH.test(text) || TESTISH.test(String(msg.details?.command ?? "")))) {
        out.validation.push(`${name}: ${clip(text, limits.maxItemChars)}`);
      }
      if (
        include.toolResults &&
        !msg.isError &&
        (exitCode === undefined || exitCode === 0) &&
        String(msg.details?.command ?? "").match(TESTISH)
      ) {
        out.validation.push(`${name} $ ${clip(String(msg.details.command), 200)}`);
      }
    }
  }

  out.changedFiles = [...new Set(out.changedFiles)];
  out.validation = [...new Set(out.validation)];
  return out;
}

function section(title: string, body: string): string {
  return `${title}\n${body || "(none)"}`;
}

/** Assemble the bounded report text. Always redacted before it leaves the process. */
export function buildReport(input: ReportInput): string {
  const limits: ReportLimits = { ...DEFAULT_REPORT_LIMITS, ...(input.limits ?? {}) };
  const include: ReportInclude = { ...ALL_INCLUDE, ...(input.include ?? {}) };
  const activity = summarizeActivity(input.entries, limits, include);
  const criteria = input.acceptanceCriteria.length
    ? input.acceptanceCriteria.map((c) => `- ${c}`).join("\n")
    : "- (derived from the goal; propose the missing ones)";

  const history = input.history.length
    ? input.history
        .slice(-limits.historyItems)
        .map((h) => `- iteration ${h.iteration}: ${h.action} — ${clip(h.summary, 200)}`)
        .join("\n")
    : "(none yet)";

  const activitySections = {
    assistant: input.initial
      ? "WORKER OUTPUT: (the worker has not run yet)"
      : `WORKER ASSISTANT OUTPUT:\n${activity.assistantText.join("\n---\n") || "(no assistant text)"}`,
    toolCalls: section("TOOL CALLS", activity.toolCalls.map((t) => `- ${t}`).join("\n")),
    files: section("CHANGED FILES", activity.changedFiles.map((f) => `- ${f}`).join("\n")),
    validation: section(
      "VALIDATION EVIDENCE (test / lint / typecheck / build runs)",
      activity.validation.map((v) => `- ${v}`).join("\n")
    ),
    failures: section("CRITICAL FAILURES", activity.failures.map((f) => `- ${f}`).join("\n")),
  };

  const header = [
    input.initial
      ? "You are supervising a coding agent that has NOT started yet. Produce the first instruction."
      : "You are supervising a coding agent. Review what it just did and decide what happens next.",
    "",
    `ORIGINAL GOAL:\n${input.goal}`,
    "",
    `ACCEPTANCE CRITERIA:\n${criteria}`,
    "",
    `ITERATION: ${input.iteration} of at most ${input.maxIterations}`,
    `INSTRUCTION THE WORKER RAN UNDER:\n${input.instruction ? clip(input.instruction, 1_000) : "(none — this is the first turn)"}`,
  ].join("\n");

  const withheld = [
    !include.assistantOutput ? "assistant output" : "",
    !include.toolCalls ? "tool calls" : "",
    !include.toolResults ? "tool results (failures are still listed)" : "",
    !include.changedFiles ? "changed files" : "",
  ].filter(Boolean);

  const tail = [
    "",
    section("PREVIOUS DECISIONS", history),
    "",
    withheld.length ? `WITHHELD BY SETTINGS (do not assume anything about them): ${withheld.join(", ")}` : "",
    "The report is bounded: sections not listed here were not sent.",
    "Do not assume anything about the conversation that is not written above.",
  ]
    .filter(Boolean)
    .join("\n");

  // Fixed parts are kept whole; the sections below share what is left. The
  // failure section is exempt from shrinking — it is the one thing a truncating
  // report must not lose.
  const fixed = `${redactSecrets(header)}\n\n`;
  const tailText = `\n${redactSecrets(tail)}`;
  const shrinkable: Array<{ key: keyof typeof activitySections; text: string; weight: number }> = [
    { key: "assistant", text: activitySections.assistant, weight: 1 },
    { key: "toolCalls", text: activitySections.toolCalls, weight: 2 },
    { key: "files", text: activitySections.files, weight: 3 },
    { key: "validation", text: activitySections.validation, weight: 4 },
  ];

  const failuresText = redactSecrets(activitySections.failures);
  const bodyOf = (parts: string[]) =>
    [fixed, ...parts.map((p) => redactSecrets(p)), "", failuresText, tailText].filter((p) => p !== "").join("\n");

  let parts = shrinkable.map((s) => s.text);
  let report = bodyOf(parts);

  if (report.length > limits.maxChars) {
    // Shrink the largest non-critical section first, then the next, until the
    // report fits. `weight` keeps assistant output longer than file lists.
    const order = [...shrinkable].sort((a, b) => a.weight - b.weight);
    let remaining = report.length - limits.maxChars;
    const replaced = new Map<string, string>();
    for (const s of order) {
      if (remaining <= 0) break;
      const budget = Math.max(160, s.text.length - remaining);
      const shrunk = budget >= s.text.length ? s.text : `${clipBlock(s.text, budget)} [section reduced to fit the report limit]`;
      replaced.set(s.key, shrunk);
      remaining -= s.text.length - shrunk.length;
    }
    parts = shrinkable.map((s) => replaced.get(s.key) ?? s.text);
    report = bodyOf(parts);

    if (report.length > limits.maxChars) {
      // Last resort: cut the head, then re-attach the failure section verbatim.
      const keep = Math.max(0, limits.maxChars - failuresText.length - tailText.length - 80);
      report = `${report.slice(0, keep)}\n[…report truncated to fit ${limits.maxChars} characters; critical failures follow…]\n\n${failuresText}${tailText}`;
    }
  }

  return redactSecrets(report);
}

/** Short, secret-free one-liner describing a decision, kept in session state. */
export function summarizeDecision(decision: SteeringDecision): string {
  const basis =
    decision.action === "steer"
      ? (decision.message ?? "")
      : decision.action === "blocked"
        ? (decision.blocker ?? "")
        : decision.reasoning;
  return redactSecrets(clip(`${decision.action}: ${basis || "(no detail)"}`, 220));
}

/**
 * What the worker actually did, kept separate from the evaluator report because
 * the chat relay forwards the agent's *own* final response instead of a
 * synthesised summary. `toolErrors` only surfaces what the agent's reply does
 * not already say (see `relayNotes`).
 */
export interface WorkerOutcome {
  /** The agent's last assistant message — its actual final response. */
  finalText: string;
  /** True when a message in this batch was cut short or stopped with an error. */
  aborted: boolean;
  /** True when the batch contains no assistant text at all. */
  noResponse: boolean;
  /** Failing tools and non-zero exit codes, bounded, in source order. */
  toolErrors: string[];
}

export function summarizeWorker(entries: unknown[], maxErrors = 5): WorkerOutcome {
  let finalText = "";
  let aborted = false;
  const toolErrors: string[] = [];

  for (const raw of entries) {
    const entry = raw as any;
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "assistant") {
      const text = textOf(msg.content);
      if (text.trim()) finalText = text.trim();
      const stop = typeof msg.stopReason === "string" ? msg.stopReason : "";
      if (stop && stop !== "stop" && stop !== "toolUse") aborted = true;
      continue;
    }

    if (msg.role === "toolResult") {
      const name = String(msg.toolName ?? "tool");
      const exitCode =
        typeof msg.details?.exitCode === "number"
          ? msg.details.exitCode
          : typeof msg.details?.exit_code === "number"
            ? msg.details.exit_code
            : undefined;
      if (msg.isError || (exitCode !== undefined && exitCode !== 0)) {
        const code = exitCode !== undefined ? ` (exit ${exitCode})` : "";
        if (toolErrors.length < maxErrors) {
          toolErrors.push(`${name} reported a failure${code}: ${clip(textOf(msg.content), 300)}`);
        } else if (toolErrors.length === maxErrors) {
          toolErrors.push("more failing tools were not listed");
        }
      }
    }
  }

  return { finalText, aborted, noResponse: !finalText.trim(), toolErrors };
}
