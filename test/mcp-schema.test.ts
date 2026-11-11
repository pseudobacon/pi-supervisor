import { describe, expect, it } from "vitest";
import type { McpToolDescriptor } from "../src/mcp/client.js";
import { buildToolArguments, isPlausibleSupervisorTool, SchemaError, selectPromptArg, selectTool } from "../src/mcp/schema.js";

const tool = (name: string, inputSchema: Record<string, unknown>, description?: string): McpToolDescriptor => ({
  name,
  description,
  inputSchema,
});

const ASK = tool(
  "perplexity_ask",
  {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The question" },
      model: { type: "string", enum: ["sonar", "sonar-pro"] },
      recency: { type: "string", enum: ["day", "week"] },
      limit: { type: "number" },
    },
    required: ["prompt"],
  },
  "Answer a single question"
);

describe("isPlausibleSupervisorTool", () => {
  it("accepts a tool that takes a question string", () => {
    expect(isPlausibleSupervisorTool(ASK)).toBe(true);
  });

  it("rejects a tool with no string argument", () => {
    expect(isPlausibleSupervisorTool(tool("models", { type: "object", properties: {} }))).toBe(false);
  });
});

describe("selectTool", () => {
  it("uses an explicitly configured tool", () => {
    expect(selectTool([ASK, tool("perplexity_reason", { type: "object", properties: { prompt: { type: "string" } } })], "perplexity_reason").tool.name).toBe(
      "perplexity_reason"
    );
  });

  it("auto-selects when exactly one tool could answer", () => {
    const selection = selectTool([tool("perplexity_models", { type: "object", properties: {} }), ASK]);
    expect(selection.tool.name).toBe("perplexity_ask");
    expect(selection.reason).toBe("single candidate");
  });

  it("refuses to guess between two plausible tools", () => {
    const two = [ASK, tool("perplexity_reason", { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] })];
    expect(() => selectTool(two)).toThrow(SchemaError);
    expect(() => selectTool(two)).toThrow(/perplexity_ask/);
  });

  it("rejects a configured name the server does not offer, and lists what it does", () => {
    expect(() => selectTool([ASK], "perplexity_deep_think")).toThrow(/perplexity_ask/);
  });
});

describe("selectPromptArg", () => {
  it("auto-selects the required string argument", () => {
    expect(selectPromptArg(ASK)).toBe("prompt");
  });

  it("prefers the string with the largest maxLength, so the report survives", () => {
    const t = tool("ask", {
      type: "object",
      properties: { question: { type: "string", maxLength: 500 }, context: { type: "string", maxLength: 40_000 } },
    });
    expect(selectPromptArg(t)).toBe("context");
  });

  it("honours an explicit argument name", () => {
    expect(selectPromptArg(ASK, "model")).toBe("model");
  });

  it("rejects an argument that does not exist", () => {
    expect(() => selectPromptArg(ASK, "question")).toThrow(SchemaError);
  });

  it("errors when the tool has no string argument at all", () => {
    expect(() => selectPromptArg(tool("ping", { type: "object", properties: { n: { type: "number" } } }))).toThrow(SchemaError);
  });
});

describe("buildToolArguments", () => {
  it("puts the report in the prompt argument and validates against the schema", () => {
    const args = buildToolArguments(ASK, "prompt", "the report");
    expect(args).toEqual({ prompt: "the report" });
  });

  it("applies configured defaults for optional arguments", () => {
    const args = buildToolArguments(ASK, "prompt", "report", { model: "sonar-pro", limit: 5 });
    expect(args).toMatchObject({ model: "sonar-pro", limit: 5, prompt: "report" });
  });

  it("overrides a configured value for the prompt argument rather than losing the report", () => {
    const args = buildToolArguments(ASK, "prompt", "the real report", { prompt: "stale" });
    expect(args.prompt).toBe("the real report");
  });

  it("refuses an enum value the server did not declare", () => {
    expect(() => buildToolArguments(ASK, "prompt", "r", { model: "gpt-99" })).toThrow(/sonar/);
  });

  it("refuses the wrong type", () => {
    expect(() => buildToolArguments(ASK, "prompt", "r", { limit: "many" })).toThrow(/limit/);
  });

  it("refuses an argument the schema forbids", () => {
    const strict = tool("t", {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      additionalProperties: false,
    });
    expect(() => buildToolArguments(strict, "prompt", "r", { temperature: 2 })).toThrow(SchemaError);
  });

  it("never invents a value for a required argument it was not given", () => {
    const needsTwo = tool("t", {
      type: "object",
      properties: { prompt: { type: "string" }, repo: { type: "string" } },
      required: ["prompt", "repo"],
    });
    expect(() => buildToolArguments(needsTwo, "prompt", "r", {})).toThrow(/repo/);
  });

  it("keeps the report as a single string argument (no invented conversation id)", () => {
    const args = buildToolArguments(ASK, "prompt", "report with\nnewlines");
    expect(typeof args.prompt).toBe("string");
    expect(Object.keys(args).sort()).toEqual(["prompt"]);
  });
});
