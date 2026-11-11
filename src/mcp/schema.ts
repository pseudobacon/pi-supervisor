/**
 * mcp/schema — pick a supervisor tool and build its arguments from the schema the
 * server actually reported. Nothing here assumes tool names or field names: both
 * discovery and validation read the live `inputSchema`.
 */

import type { McpToolDescriptor } from "./client.js";

export class SchemaError extends Error {}

export interface PropertySchema {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, PropertySchema>;
  description?: string;
  maxLength?: number;
}

export function schemaParts(schema: Record<string, unknown>): {
  properties: Record<string, PropertySchema>;
  required: string[];
  additional: boolean;
} {
  const properties = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<
    string,
    PropertySchema
  >;
  const required = Array.isArray(schema.required) ? (schema.required.filter((r) => typeof r === "string") as string[]) : [];
  const additional = schema.additionalProperties !== false;
  return { properties, required, additional };
}

/** True when this tool could carry a supervisor question (a string argument exists). */
export function isPlausibleSupervisorTool(tool: McpToolDescriptor): boolean {
  const { properties } = schemaParts(tool.inputSchema);
  const entries = Object.values(properties);
  if (entries.length === 0) return false;
  return entries.some((p) => p?.type === "string" || (Array.isArray(p?.type) && p.type.includes("string")));
}

export interface ToolSelection {
  tool: McpToolDescriptor;
  /** How the choice was made, for status output. */
  reason: "configured" | "single candidate" | "only tool";
}

/**
 * Resolve the supervisor tool.
 *
 * A configured name is used as-is. Otherwise the tool is auto-selected only when
 * exactly one tool could plausibly answer; with several candidates the caller has
 * to choose — guessing here would silently pick a deep-research tool over a
 * quick one, or a tool with the wrong defaults.
 */
export function selectTool(tools: McpToolDescriptor[], configured?: string): ToolSelection {
  if (configured) {
    const tool = tools.find((t) => t.name === configured);
    if (!tool) {
      throw new SchemaError(
        `MCP tool "${configured}" is not offered by this server. Available: ${tools.map((t) => t.name).join(", ") || "none"}.`
      );
    }
    return { tool, reason: "configured" };
  }

  if (tools.length === 0) throw new SchemaError("The MCP server exposed no tools.");

  const candidates = tools.filter(isPlausibleSupervisorTool);
  if (candidates.length === 1) return { tool: candidates[0], reason: candidates[0].name === tools[0].name && tools.length === 1 ? "only tool" : "single candidate" };
  if (candidates.length === 0) {
    throw new SchemaError(`None of the MCP tools (${tools.map((t) => t.name).join(", ")}) takes a text question. Select one with /supervise mcp tool <name>.`);
  }
  throw new SchemaError(
    `The MCP server offers ${candidates.length} plausible tools (${candidates.map((t) => t.name).join(", ")}). Select one with /supervise mcp tool <name> — this extension will not guess.`
  );
}

/** Whole names that unambiguously mean "the thing that happened". */
const REPORT_NAMES = new Set(["report", "activity", "activityreport", "transcript", "progress", "history", "context", "summary", "log", "conversation", "messages", "session"]);
/** Whole names that mean something other than the transcript, so they can be ruled out. */
const OTHER_ROLES = new Set(["goal", "outcome", "objective", "task", "intent", "question", "query", "prompt", "instruction", "instructions", "systemprompt", "policy", "criteria", "criterion", "reason", "reasoning", "title", "name", "mode", "format", "language", "model", "provider", "version", "id", "url", "output", "action"]);

/**
 * Score each string argument by how strongly its name signals the activity
 * report. Exact whole-name hits outrank token hits; a tie is left unresolved on
 * purpose rather than guessed, because sending the transcript into the wrong
 * argument produces a confident answer to the wrong question.
 */
function rankReportArg(stringProps: string[]): string | undefined {
  const score = (name: string): number => {
    const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
    if (REPORT_NAMES.has(normalized)) return 3;
    const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (tokens.some((token) => REPORT_NAMES.has(token)) && !tokens.every((token) => OTHER_ROLES.has(token))) return 2;
    if (tokens.some((token) => token === "report" || token === "transcript" || token === "progress")) return 2;
    return 0;
  };

  const scored = stringProps
    .map((name) => ({ name, value: score(name) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);
  if (scored.length === 0) return undefined;
  const best = scored.filter((entry) => entry.value === scored[0].value);
  return best.length === 1 ? best[0].name : undefined;
}


/**
 * Choose the argument that carries the report: the configured name, else the only
 * required string property, else the only string property. Ambiguity is an error.
 */
export function selectPromptArg(tool: McpToolDescriptor, configured?: string): string {
  const { properties, required } = schemaParts(tool.inputSchema);
  const stringProps = Object.entries(properties)
    .filter(([, p]) => p?.type === "string" || (Array.isArray(p?.type) && p.type.includes("string")))
    .map(([name]) => name);

  if (configured) {
    if (!properties[configured]) throw new SchemaError(`MCP tool "${tool.name}" has no argument "${configured}". Its arguments: ${Object.keys(properties).join(", ") || "none"}.`);
    return configured;
  }

  // Names are the strongest evidence available. A tool that declares `report`
  // alongside `goal` and `system_prompt` is telling us where the transcript goes,
  // and forcing the user to confirm that would just be noise.
  const named = rankReportArg(stringProps);
  if (named) return named;

  const requiredStrings = stringProps.filter((name) => required.includes(name));
  if (requiredStrings.length === 1) return requiredStrings[0];
  if (requiredStrings.length === 0 && stringProps.length === 1) return stringProps[0];

  // Several strings: the report is long, so a server that declares a much larger
  // limit on one of them is telling us where the big text belongs. Only a decisive
  // gap counts — anything closer goes to the user to choose.
  if (requiredStrings.length === 0 && stringProps.length > 1) {
    const ranked = stringProps
      .map((name) => ({ name, maxLength: properties[name]?.maxLength }))
      .filter((entry) => typeof entry.maxLength === "number")
      .sort((a, b) => (b.maxLength as number) - (a.maxLength as number));
    if (ranked.length === stringProps.length && ranked.length > 1) {
      const [best, second] = ranked;
      if ((best.maxLength as number) >= (second.maxLength as number) * 4) return best.name;
    }
  }

  throw new SchemaError(
    `Cannot tell which argument of "${tool.name}" should carry the report (${stringProps.join(", ") || "none"}). Set it with /supervise mcp prompt-arg <name>.`
  );
}

/**
 * Validate the arguments this extension is about to send against the discovered
 * schema: required fields present, no unknown keys when the schema forbids them,
 * types and enums honoured. `report` fills the prompt argument.
 */
export function buildToolArguments(
  tool: McpToolDescriptor,
  promptArg: string,
  report: string,
  configuredArgs: Record<string, unknown> = {},
  // Values this extension already holds, offered to a tool that declares an
  // argument for them. Filling a declared argument from data in hand beats
  // failing a call that would otherwise succeed.
  context: { goal?: string; systemPrompt?: string } = {}
): Record<string, unknown> {
  const { properties, required, additional } = schemaParts(tool.inputSchema);
  const args: Record<string, unknown> = { ...configuredArgs, [promptArg]: report };

  for (const name of required) {
    if (args[name] !== undefined && args[name] !== null && args[name] !== "") continue;
    const prop = properties[name];
    if (!prop || (prop.type !== "string" && !(Array.isArray(prop.type) && prop.type.includes("string")))) continue;
    const fill = contextualValue(name, context);
    if (fill !== undefined && fill !== "") args[name] = fill;
  }

  const problems: string[] = [];

  for (const name of Object.keys(args)) {
    if (!properties[name] && !additional) problems.push(`"${name}" is not an argument of "${tool.name}"`);
  }

  for (const name of required) {
    const value = args[name];
    if (value === undefined || value === null || value === "") problems.push(`"${name}" is required by "${tool.name}" — set it with /supervise mcp arg ${name} <value>`);
  }

  for (const [name, value] of Object.entries(args)) {
    const prop = properties[name];
    if (!prop) continue;
    const expected = Array.isArray(prop.type) ? prop.type : [prop.type];
    if (expected.length && !expected.some((t) => matchesType(value, t))) {
      problems.push(`"${name}" must be ${expected.filter(Boolean).join(" or ")}, got ${JSON.stringify(value)}`);
    }
    if (prop.enum && !prop.enum.some((v) => v === value)) {
      problems.push(`"${name}" must be one of ${prop.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    }
  }

  if (problems.length) throw new SchemaError(problems.join("; "));
  return args;
}

function matchesType(value: unknown, type?: string): boolean {
  if (!type) return true;
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/** Names that mean "the thing the user asked the worker to achieve". */
const GOAL_NAMES = new Set(["goal", "outcome", "objective", "task", "intent", "aim", "desiredoutcome", "target"]);
/** Names that mean "the rules the supervisor must follow". */
const POLICY_NAMES = new Set(["systemprompt", "prompt", "instructions", "instruction", "policy", "guidelines", "role", "criteria", "supervisionpolicy"]);

function contextualValue(name: string, context: { goal?: string; systemPrompt?: string }): string | undefined {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  if (GOAL_NAMES.has(normalized) && context.goal) return context.goal;
  if (POLICY_NAMES.has(normalized) && context.systemPrompt) return context.systemPrompt;
  return undefined;
}
