/**
 * mcp-panel.ts — the MCP backend's settings page.
 *
 * Opened from `/supervise mcp`. Server and tool choices come from what actually
 * exists: servers from pi's own mcp.json files, tools from a live tools/list
 * against the selected endpoint. When discovery fails the rows say why and the
 * previous setting is left untouched — a guessed tool name is worse than none.
 *
 * Auth headers are deliberately absent from this page. They stay in mcp.json as
 * `${ENV_VAR}` references expanded at call time, so a screenshot of settings can
 * never leak a key.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, type SelectItem, SelectList, type SettingItem, SettingsList, type SettingsListTheme } from "@earendil-works/pi-tui";
import type { McpToolDescriptor } from "../mcp/client.js";
import { DEFAULT_MCP_SETTINGS, type McpSettings } from "../mcp/config.js";
import { schemaParts } from "../mcp/schema.js";

export interface McpDiscoveryResult {
  tools: McpToolDescriptor[];
  serverName?: string;
  serverVersion?: string;
  endpointSource: string;
}

export interface McpPanelOptions {
  current: McpSettings;
  /** Server names from pi's mcp.json files, for the picker. */
  servers: string[];
  /** Live discovery; the page degrades to "auto" when it fails. */
  discover: () => Promise<McpDiscoveryResult>;
  onNotify?: (message: string, level?: "info" | "warning" | "error") => void;
}

const TIMEOUTS = ["15000", "30000", "60000", "120000", "300000", "600000"];
const RETRIES = ["0", "1", "2", "3"];
const ITERATIONS = ["3", "5", "10", "20", "50"];
const MINUTES = ["10", "15", "30", "45", "90", "180"];
const REPORT_CHARS = ["4000", "8000", "16000", "32000", "64000"];
const BOOL = ["on", "off"];

export type McpSettingsPatch = Partial<McpSettings>;

/** A row id that opens a picker rather than cycling values. */
type Overlay =
  | { view: "page" }
  | { view: "tools"; list: SelectList }
  | { view: "args"; tool: string; list: SelectList }
  | { view: "url"; input: Input };

export async function openMcpSettings(ctx: ExtensionContext, options: McpPanelOptions): Promise<McpSettingsPatch | null> {
  const draft: McpSettings = { ...DEFAULT_MCP_SETTINGS, ...options.current };

  return ctx.ui.custom<McpSettingsPatch | null>((tui, theme, _kb, done) => {
    const patch: McpSettingsPatch = {};
    const discovered = { tools: [] as McpToolDescriptor[], tried: false, error: "" };
    let overlay: Overlay = { view: "page" };

    const listTheme: SettingsListTheme = {
      label: (text, selected) => (selected ? theme.bold(theme.fg("accent", text)) : theme.fg("dim", text)),
      value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
      description: (text) => theme.fg("dim", text),
      cursor: theme.fg("accent", "❯"),
      hint: (text) => theme.fg("dim", text),
    };

    const selectTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.bold(text),
      description: (text: string) => theme.fg("dim", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };

    /** Show a value outside the preset table as `17*` rather than hiding it. */
    const shown = (value: number, table: string[]): string =>
      table.includes(String(value)) ? String(value) : `${value}*`;

    const serverValues = [...new Set([...options.servers, ...(draft.server ? [draft.server] : [])])];

    const rows: SettingItem[] = [
      {
        id: "server",
        label: "Pi MCP server",
        description: serverValues.length
          ? "Enter cycles the servers in mcp.json"
          : "No MCP server found in mcp.json — set a URL below",
        currentValue: draft.server || "auto",
        values: serverValues.length ? serverValues : ["auto"],
      },
      { id: "url", label: "Server URL", description: "Overrides the server name — Enter to edit", currentValue: draft.url || "(from mcp.json)" },
      {
        id: "tool",
        label: "Supervisor tool",
        description: discovered.error
          ? `Discovery failed: ${discovered.error}`
          : discovered.tools.length
            ? `${discovered.tools.length} tool(s) — Enter to pick`
            : "Enter connects and lists the server's tools",
        currentValue: draft.tool || "auto",
      },
      { id: "promptArg", label: "Prompt argument", description: "Which tool argument carries the report", currentValue: draft.promptArg || "auto" },
      { id: "timeout", label: "Request timeout (ms)", description: "Abort a hanging supervisor call and pause", currentValue: shown(draft.timeoutMs, TIMEOUTS), values: TIMEOUTS },
      { id: "retries", label: "Transport retries", description: "Connection failures only; never re-sends an accepted decision", currentValue: shown(draft.retries, RETRIES), values: RETRIES },
      { id: "maxIterations", label: "Max iterations", description: "Worker runs before the loop must stop and ask", currentValue: shown(draft.maxIterations, ITERATIONS), values: ITERATIONS },
      { id: "maxDurationMs", label: "Max minutes", description: "Wall-clock budget for one goal", currentValue: shown(Math.round(draft.maxDurationMs / 60_000), MINUTES), values: MINUTES },
      { id: "maxReportChars", label: "Report size (chars)", description: "Sent per review; oldest non-failure detail drops first", currentValue: shown(draft.maxReportChars, REPORT_CHARS), values: REPORT_CHARS },
      { id: "sendToolCalls", label: "Include tool calls", description: "Tool names and inputs in the report", currentValue: draft.sendToolCalls ? "on" : "off", values: BOOL },
      { id: "sendToolResults", label: "Include tool results", description: "Truncated output; failed calls survive trimming", currentValue: draft.sendToolResults ? "on" : "off", values: BOOL },
      { id: "sendAssistantOutput", label: "Include assistant output", description: "What the worker said it did", currentValue: draft.sendAssistantOutput ? "on" : "off", values: BOOL },
      { id: "sendChangedFiles", label: "Include changed files", description: "Paths touched by edits and writes", currentValue: draft.sendChangedFiles ? "on" : "off", values: BOOL },
      { id: "discover", label: "Re-discover tools", description: "Connect now and report what the server exposes", currentValue: "" },
      { id: "reset", label: "Restore defaults", description: "Clear the stored MCP overrides", currentValue: "" },
    ];

    const page = new SettingsList(
      rows,
      Math.min(rows.length, 14),
      listTheme,
      (id, newValue) => {
        switch (id) {
          case "server":
            draft.server = newValue === "auto" ? "" : newValue;
            patch.server = draft.server;
            break;
          case "timeout":
            draft.timeoutMs = Number(newValue);
            patch.timeoutMs = draft.timeoutMs;
            break;
          case "retries":
            draft.retries = Number(newValue);
            patch.retries = draft.retries;
            break;
          case "maxIterations":
            draft.maxIterations = Number(newValue);
            patch.maxIterations = draft.maxIterations;
            break;
          case "maxDurationMs":
            draft.maxDurationMs = Number(newValue) * 60_000;
            patch.maxDurationMs = draft.maxDurationMs;
            break;
          case "maxReportChars":
            draft.maxReportChars = Number(newValue);
            patch.maxReportChars = draft.maxReportChars;
            break;
          case "sendToolCalls":
            draft.sendToolCalls = newValue === "on";
            patch.sendToolCalls = draft.sendToolCalls;
            break;
          case "sendToolResults":
            draft.sendToolResults = newValue === "on";
            patch.sendToolResults = draft.sendToolResults;
            break;
          case "sendAssistantOutput":
            draft.sendAssistantOutput = newValue === "on";
            patch.sendAssistantOutput = draft.sendAssistantOutput;
            break;
          case "sendChangedFiles":
            draft.sendChangedFiles = newValue === "on";
            patch.sendChangedFiles = draft.sendChangedFiles;
            break;
          case "reset":
            done({ ...DEFAULT_MCP_SETTINGS, server: "", url: "", tool: "", promptArg: "", args: {} });
            return;
          case "discover":
            void runDiscovery();
            return;
          case "url":
            openUrlEditor();
            return;
          case "tool":
            if (discovered.tried) openToolPicker();
            else void runDiscovery(openToolPicker);
            return;
          case "promptArg":
            openArgPicker();
            return;
        }
        tui.requestRender();
      },
      () => done(Object.keys(patch).length ? patch : null)
    );

    async function runDiscovery(then?: () => void): Promise<void> {
      options.onNotify?.("Connecting to the MCP server…");
      try {
        const result = await options.discover();
        discovered.tools = result.tools;
        discovered.tried = true;
        discovered.error = "";
        options.onNotify?.(`${result.tools.length} tool(s) from ${result.serverName ?? "server"}${result.serverVersion ? ` v${result.serverVersion}` : ""} via ${result.endpointSource}`);
      } catch (error) {
        discovered.tried = true;
        discovered.error = (error instanceof Error ? error.message : String(error)).slice(0, 120);
        options.onNotify?.(`MCP discovery failed: ${discovered.error}`, "error");
      }
      tui.requestRender();
      then?.();
    }

    function openToolPicker(): void {
      const items: SelectItem[] = [
        { value: "", label: "auto", description: "Use the only plausible supervisor tool; refuse to guess among several" },
        ...discovered.tools.map((tool) => ({
          value: tool.name,
          label: tool.name,
          description: (tool.description ?? "").slice(0, 80),
        })),
      ];
      overlay = { view: "tools", list: makePicker(items, (value) => {
        draft.tool = value;
        patch.tool = value;
        // A different tool has different arguments — drop the old mapping.
        draft.promptArg = "";
        patch.promptArg = "";
      }) };
      tui.requestRender();
    }

    function openArgPicker(): void {
      const name = draft.tool || discovered.tools[0]?.name || "";
      const tool = discovered.tools.find((t) => t.name === name);
      if (!tool) {
        options.onNotify?.("Discover tools first — argument names come from the live schema.", "warning");
        return;
      }
      const { properties, required } = schemaParts(tool.inputSchema);
      const requiredSet = new Set(required);
      const items: SelectItem[] = [
        { value: "", label: "auto", description: "The string argument with the largest maxLength, else the first string argument" },
        ...Object.entries(properties).map(([arg, schema]) => ({
          value: arg,
          label: arg,
          description: [schema.type, requiredSet.has(arg) ? "required" : "optional", schema.description ?? ""].filter(Boolean).join(" · ").slice(0, 80),
        })),
      ];
      overlay = { view: "args", tool: tool.name, list: makePicker(items, (value) => {
        draft.promptArg = value;
        patch.promptArg = value;
      }) };
      tui.requestRender();
    }

    function openUrlEditor(): void {
      const input = new Input();
      input.setValue(draft.url ?? "");
      input.onSubmit = (value) => {
        draft.url = value.trim();
        patch.url = draft.url;
        overlay = { view: "page" };
        tui.requestRender();
      };
      input.onEscape = () => {
        overlay = { view: "page" };
        tui.requestRender();
      };
      overlay = { view: "url", input };
      tui.requestRender();
    }

    function makePicker(items: SelectItem[], choose: (value: string) => void): SelectList {
      const list = new SelectList(items, Math.min(items.length, 12), selectTheme);
      list.onSelect = (item) => {
        choose(item.value);
        overlay = { view: "page" };
        tui.requestRender();
      };
      list.onCancel = () => {
        overlay = { view: "page" };
        tui.requestRender();
      };
      return list;
    }

    return {
      render: (width: number) => {
        const heading = theme.bold("Supervisor · MCP backend");
        const summary = `${draft.server || draft.url || "auto-detect"} · tool ${draft.tool || "auto"} · ${Math.round(draft.timeoutMs / 1000)}s · ${draft.maxIterations} iterations · ${Math.round(draft.maxReportChars / 1000)}k chars`;
        const frame = theme.fg("dim", "─".repeat(Math.min(56, width)));
        if (overlay.view === "page") return [heading, theme.fg("muted", summary), frame, ...page.render(width)];
        if (overlay.view === "url") {
          return [
            theme.bold("Server URL"),
            theme.fg("dim", "Enter saves · Esc cancels · prefer a server name from mcp.json so keys stay in the environment"),
            ...overlay.input.render(width),
          ];
        }
        const title = overlay.view === "tools" ? "Supervisor tool" : `Prompt argument · ${overlay.tool}`;
        return [theme.bold(title), theme.fg("dim", "↑↓ move · Enter choose · Esc back"), ...overlay.list.render(width)];
      },
      invalidate: () => {
        page.invalidate();
        if (overlay.view === "url") overlay.input.invalidate();
        else if (overlay.view !== "page") overlay.list.invalidate();
      },
      handleInput: (data: string) => {
        if (overlay.view === "page") page.handleInput(data);
        else if (overlay.view === "url") overlay.input.handleInput(data);
        else overlay.list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
