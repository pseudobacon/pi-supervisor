/**
 * pi-supervisor — A pi extension that supervises the chat and steers it toward a defined outcome.
 *
 * Commands:
 *   /supervise <outcome>          — start supervising
 *   /supervise stop | status | resume
 *   /supervise backend [model|mcp] — which supervisor answers
 *   /supervise mcp [sub]          — MCP endpoint, tool, limits (see /supervise mcp help)
 *   /supervise model              — open interactive model picker (pi-style)
 *   /supervise model <p/modelId>  — set model directly (scripting)
 *   /supervise sensitivity <low|medium|high> — adjust steering sensitivity
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BrowserRelayBackend } from "./backends/browser-backend.js";
import { McpSupervisorBackend } from "./backends/mcp-backend.js";
import { ChatRelayBackend, newConversationId } from "./backends/relay-backend.js";
import type { SupervisorBackend } from "./backends/types.js";
import { countOpenTodos } from "./browser/todos.js";
import { nonGoalReason } from "./command-intent.js";
import { analyze, loadSystemPrompt } from "./engine.js";
import { onAgentSettled } from "./host.js";
import { SupervisorLoop } from "./loop.js";
import { DEFAULT_MCP_SETTINGS, describeMcp, loadPiMcpServers, type McpSettings, resolveMcpSettings, saveMcpSettings } from "./mcp/config.js";
import { schemaParts } from "./mcp/schema.js";
import { describeRelay, relayConfigIssues, resolveRelay } from "./relay/config.js";
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER, DEFAULT_SENSITIVITY, SupervisorStateManager } from "./state.js";
import type { Sensitivity, SteeringDecision, SupervisorBackendId } from "./types.js";
import { openMcpSettings } from "./ui/mcp-panel.js";
import { pickModel } from "./ui/model-picker.js";
import { openSettings } from "./ui/settings-panel.js";
import { isWidgetVisible, toggleWidget, updateUI, type WidgetAction } from "./ui/status-widget.js";
import { loadWorkspaceBackend, loadWorkspaceModel, saveWorkspaceBackend, saveWorkspaceModel } from "./workspace-config.js";

/**
 * Extract partial reasoning text from the supervisor's streaming JSON response.
 * Works on incomplete JSON while the model is still generating.
 */
function extractThinking(accumulated: string): string {
  // Find the "reasoning" key and capture content after the opening quote
  const keyIdx = accumulated.indexOf('"reasoning"');
  if (keyIdx === -1) return "";
  const after = accumulated.slice(keyIdx + '"reasoning"'.length);
  const openMatch = after.match(/^\s*:\s*"/);
  if (!openMatch) return "";
  const content = after.slice(openMatch[0].length);
  // If the closing quote has arrived, take only what's inside; otherwise take all (streaming)
  const closeIdx = content.search(/(?<!\\)"/);
  const raw = closeIdx === -1 ? content : content.slice(0, closeIdx);
  return raw.replace(/\\n/g, " ").replace(/\\"/g, '"').trim();
}

// After this many consecutive idle-state steers with no "done", run a lenient final evaluation.
const MAX_IDLE_STEERS = 5;

export default function (pi: ExtensionAPI) {
  const state = new SupervisorStateManager(pi);
  let idleSteers = 0; // consecutive agent_end steers; reset on done/stop/new supervision

  // ---- MCP backend -------------------------------------------------------
  // The MCP supervisor is driven by this extension, not by the worker: after each
  // settled worker run the loop sends a bounded, redacted report to the MCP tool
  // and injects the reply as the next instruction. The model-backend handlers above
  // stay exactly as they were and bail out early when this backend is selected.

  let loopCtx: ExtensionContext | null = null;
  let mcpBackend: SupervisorBackend | null = null;

  function backendFor(cwd: string): SupervisorBackendId {
    return loadWorkspaceBackend(cwd) ?? "model";
  }

  function mcpSettingsFor(ctx: ExtensionContext): McpSettings {
    return resolveMcpSettings(ctx.cwd);
  }

  function widgetAction(s: ReturnType<SupervisorStateManager["getState"]>): WidgetAction {
    if (!s) return { type: "watching" };
    switch (s.phase) {
      case "reviewing":
        return { type: "analyzing", turn: s.turnCount };
      case "paused":
        return { type: "paused", reason: s.pauseReason ?? "paused" };
      case "done":
        return { type: "done" };
      default:
        return { type: "watching" };
    }
  }

  /**
   * The `/supervise status` readout, for every phase: idle, awaiting Perplexity,
   * worker running, paused, complete, and configuration-incomplete. Each part is
   * read through accessors that cannot throw on ordinary input, and the caller
   * wraps it in a try/catch anyway, because a throwing status handler is
   * invisible in pi (the error goes to the extension-error path instead).
   */
  function statusLines(ctx: ExtensionContext): string[] {
    const s = state.getState();
    // With no run in this session, the configured backend is the honest answer.
    const backend = state.getState()?.backend ?? backendFor(ctx.cwd);
    const settings = mcpSettingsFor(ctx);
    const workerRunning = ctx.isIdle === undefined ? false : !ctx.isIdle();
    const status = loop.status();
    const lines: string[] = [];

    const relayTransport = resolveRelay(settings, ctx.cwd).transport;
    lines.push(
      `Supervisor: ${s ? (s.active ? "active" : "finished") : "idle"} · backend ${
        backend === "mcp"
          ? `${relayTransport === "browser" ? "browser" : "pplx-proxy"} chat relay (${describeRelay(settings, ctx.cwd)})`
          : `model ${s?.provider ?? "?"}/${s?.modelId ?? "?"}`
      }`
    );

    if (backend === "mcp") {
      const issues = relayConfigIssues(settings, ctx.cwd);
      if (issues.length) lines.push(`Configuration incomplete: ${issues.join("; ")}`);
    }

    if (!s) {
      lines.push("Nothing is being supervised in this session — /supervise <goal> to start.");
      const missing = state.getMissingStateNote();
      if (missing) lines.push(missing);
      return lines;
    }

    lines.push(`Goal: "${s.outcome}"`);

    const phase = s.phase;
    lines.push(
      `Phase: ${
        phase === "starting"
          ? relayTransport === "browser"
            ? "dispatching the operator's own prompt — the chat is not asked for a first instruction"
            : "awaiting Perplexity, opening the conversation for the first instruction"
          : phase === "reviewing"
            ? "awaiting Perplexity, the worker's result was sent and the next instruction is due"
            : phase === "working"
              ? workerRunning
                ? "worker running, executing the last instruction"
                : "instruction dispatched, worker idle"
              : phase === "paused"
                ? `paused — ${s.pauseReason ?? "no reason recorded"}`
                : phase === "done"
                  ? "complete"
                  : s.active
                    ? "watching"
                    : "stopped"
      }`
    );

    if (backend !== "mcp") {
      lines.push(`Turns: ${s.turnCount} · steering: ${s.interventions.length}`);
      if (s.lastDecision) lines.push(`Last decision: ${s.lastDecision}`);
      if (phase === "paused") lines.push("Resume with: /supervise resume");
      return lines;
    }

    lines.push(
      `Turns: ${status.iteration}/${settings.maxIterations} instructions · conversation turn ${
        s.relayTurn ?? 0
      } · attempts ${s.relayAttempts ?? 0}/${1 + settings.maxIterations} · limit ${Math.round(settings.maxDurationMs / 60000)} min · request ${
        status.requestInFlight ? "in flight" : "idle"
      } · worker ${workerRunning ? "running" : "idle"}`
    );
    lines.push(
      `Conversation: ${
        s.conversationId
          ? `${s.conversationId} — ${
              s.conversationAttached === false ? "NOT attached, the proxy started a fresh turn" : "attached"
            }`
          : "(not opened yet)"
      }${s.relayIntroSent ? "" : " · relay setup not yet delivered"}`
    );
    lines.push(`Last activity: ${s.lastActivity ?? "(nothing yet)"}`);
    if (phase === "paused") lines.push("Resume with: /supervise resume");
    if (phase === "done") lines.push("Goal met — /supervise <goal> opens a new conversation.");
    return lines;
  }

  const loop = new SupervisorLoop(
    () => state.getState(),
    (phase, reason) => state.setPhase(phase, reason),
    (patch) => {
      if (patch.lastDecision !== undefined) state.setLastDecision(patch.lastDecision);
      if (patch.acceptanceCriteria !== undefined) state.setAcceptanceCriteria(patch.acceptanceCriteria);
      if (patch.relay !== undefined) state.setRelayActivity(patch.relay);
    },
    {
      sendInstruction: (text) => {
        // Idle by construction: the loop dispatches only after a settled run, so
        // this starts a new worker run instead of queueing behind one.
        pi.sendUserMessage(text);
      },
      notify: (message, level) => loopCtx?.ui.notify(message, level ?? "info"),
      // The worker's open todos, read fresh from the active path at the moment of the
      // request. On a host with no todo tool this is null, and the browser relay pauses
      // instead of declaring completion — see browser/todos.ts.
      workerTodos: (ctx) => countOpenTodos(ctx.sessionManager.getBranch()),
      createBackend: (ctx) => {
        void mcpBackend?.dispose?.();
        const s = state.getState();
        // A run owns exactly one conversation: mint it here, keep it for resume.
        const conversationId = s?.conversationId ?? newConversationId(ctx.cwd, Date.now());
        if (s && !s.conversationId) state.setConversationId(conversationId);
        const transport = resolveRelay(mcpSettingsFor(ctx), ctx.cwd).transport;
        mcpBackend =
          transport === "browser"
            ? new BrowserRelayBackend({
                settings: mcpSettingsFor(ctx),
                cwd: ctx.cwd,
                // Same persisted counter as the proxy relay: it counts transport
                // attempts against Perplexity, whichever pipe they travelled.
                budget: {
                  cap: resolveRelay(mcpSettingsFor(ctx), ctx.cwd).maxAttempts,
                  used: () => state.getState()?.relayAttempts ?? 0,
                  record: () => state.recordRelayAttempt(),
                },
              })
            : new ChatRelayBackend({
                settings: mcpSettingsFor(ctx),
                cwd: ctx.cwd,
                conversationId,
                introSent: s?.relayIntroSent,
                onIntroSent: () => state.setRelayIntroSent(true),
                // Hard transport budget: at most one initial request plus one review per
                // worker run — failures and timeouts included. The counter lives in the
                // run's persisted state, so pause or resume can never replenish it.
                budget: {
              cap: 1 + mcpSettingsFor(ctx).maxIterations,
              used: () => state.getState()?.relayAttempts ?? 0,
              record: () => state.recordRelayAttempt(),
            },
          });
        return mcpBackend;
      },
      limits: () => {
        const settings = loopCtx ? mcpSettingsFor(loopCtx) : resolveMcpSettings(process.cwd());
        return {
          maxIterations: settings.maxIterations,
          maxDurationMs: settings.maxDurationMs,
          maxReportChars: settings.maxReportChars,
          include: {
            toolCalls: settings.sendToolCalls,
            toolResults: settings.sendToolResults,
            assistantOutput: settings.sendAssistantOutput,
            changedFiles: settings.sendChangedFiles,
          },
        };
      },
      render: (ctx) => updateUI(ctx, state.getState(), widgetAction(state.getState())),
    }
  );

  /** Stop the MCP loop and say what happened to the worker, in the caller's words. */
  async function haltLoop(ctx: ExtensionContext): Promise<void> {
    const workerRunning = !ctx.isIdle();
    await loop.stop(workerRunning);
  }

  // ---- Session lifecycle: restore state ----

  const onSessionLoad = (ctx: ExtensionContext) => {
    // Anything in flight belongs to the previous session; a run that was
    // mid-flight when pi restarted comes back paused, never auto-resumed.
    loop.invalidate();
    loopCtx = ctx;
    state.loadFromSession(ctx);
    idleSteers = 0;
    state.pauseRestoredRun();
    updateUI(ctx, state.getState(), widgetAction(state.getState()));
  };

  // session_start now fires for startup/reload/new/resume/fork (consolidated
  // in pi-coding-agent 0.72.x — previously separate session_switch/session_fork
  // events). session_tree remains a separate event for tree-view navigation.
  pi.on("session_start", async (_event, ctx) => onSessionLoad(ctx));
  pi.on("session_tree", async (_event, ctx) => onSessionLoad(ctx));

  pi.on("session_shutdown", async (_event, _ctx) => {
    loop.invalidate();
    await mcpBackend?.dispose?.();
    mcpBackend = null;
  });

  // A prompt from the user outranks the supervisor. Pause rather than racing the
  // loop for the same worker; `/supervise resume` puts it back in charge.
  pi.on("input", async (event, ctx) => {
    loopCtx = ctx;
    if (state.getBackend() !== "mcp" || !state.isActive()) return;
    if (event.source === "extension") return; // our own injected instruction
    const text = (event.text ?? "").trim();
    if (text.startsWith("/") ? /^\/(sup|supervise)(\s|$)/.test(text) : /^(sup|supervise)(\s|$)/.test(text)) return;
    if (loop.onUserInput()) {
      // A silent hand-back is invisible: the user would keep finding the
      // supervisor driving the session after they took it over.
      ctx.ui.notify("Supervision paused — your prompt takes priority. /supervise resume to hand control back.", "info");
    }
    updateUI(ctx, state.getState(), widgetAction(state.getState()));
  });

  pi.on("agent_start", async (_event, ctx) => {
    loopCtx = ctx;
    loop.onWorkerStart();
  });

  // The authoritative boundary between worker runs. `agent_end` fires before
  // automatic retries, compaction, and queued follow-ups have finished, so it is
  // only used as the fallback path for hosts that predate this event.
  onAgentSettled(pi, async (event, ctx) => {
    loopCtx = ctx;
    if (state.getBackend() !== "mcp" || !state.isActive()) return;
    updateUI(ctx, state.getState(), widgetAction(state.getState()));
    await loop.onWorkerSettled(ctx, event.aborted);
  });

  /** `/supervise mcp …` — endpoint, tool, and limits. Never prints a credential. */
  async function handleMcpCommand(ctx: ExtensionContext, rest: string): Promise<void> {
    const [verb, ...rest2] = rest.split(/\s+/);
    const value = rest2.join(" ").trim();
    switch ((verb ?? "").toLowerCase()) {
      case "": {
        const settings = mcpSettingsFor(ctx);
        const servers = loadPiMcpServers(ctx.cwd)
          .filter((server) => server.url)
          .map((server) => server.name);
        const patch = await openMcpSettings(ctx, {
          current: settings,
          servers,
          onNotify: (message, level) => ctx.ui.notify(message, level ?? "info"),
          discover: async () => {
            const probe = new McpSupervisorBackend({ settings: mcpSettingsFor(ctx), cwd: ctx.cwd });
            try {
              const found = await probe.discover();
              return {
                tools: found.tools,
                serverName: found.server?.name,
                serverVersion: found.server?.version,
                endpointSource: found.endpoint.source,
              };
            } finally {
              await probe.dispose();
            }
          },
        });
        if (!patch) return;
        if (!saveMcpSettings(ctx.cwd, patch)) {
          ctx.ui.notify("Could not save — create the .pi/ directory first.", "error");
          return;
        }
        ctx.ui.notify(`MCP settings saved: ${describeMcp(mcpSettingsFor(ctx), ctx.cwd)}`, "info");
        return;
      }

      case "status": {
        const settings = mcpSettingsFor(ctx);
        const relay = resolveRelay(settings, ctx.cwd);
        const run = state.getState();
        const servers = loadPiMcpServers(ctx.cwd).map((server) => `${server.name}${server.url ? "" : " (no url)"}`);
        ctx.ui.notify(
          [
            `Relay: ${describeRelay(settings, ctx.cwd)} (endpoint from ${resolveRelay(settings, ctx.cwd).endpoint.source})`,
            `Intro template: ${relay.introPath ?? "(built-in, configurable in .pi/SUPERVISOR.RELAY.md)"}${
              relay.introMissing ? " — CONFIGURED FILE NOT FOUND" : ""
            }`,
            `Conversation: ${
              run?.conversationId
                ? `${run.conversationId} — ${run.conversationAttached === false ? "NOT attached" : "attached"}, turn ${
                    run.relayTurn ?? 0
                  }, setup ${run.relayIntroSent ? "delivered" : "not delivered"}`
                : "(none yet)"
            }`,
            `Per turn: up to ${relay.maxWorkerChars} characters of the agent's own final response`,
            `Limits: ${settings.maxIterations} turns · ${Math.round(settings.maxDurationMs / 60000)} min · ${Math.round(
              settings.timeoutMs / 1000
            )}s timeout · ${settings.retries} retries`,
            `MCP endpoint (tool discovery): ${describeMcp(settings, ctx.cwd)}`,
            `Servers in mcp.json: ${servers.length ? servers.join(", ") : "(none)"}`,
            `Secrets: the proxy token is read from ${relay.apiKeyEnv} at request time and never stored or printed.`,
          ].join("\n"),
          "info"
        );
        return;
      }

      case "tools": {
        ctx.ui.notify("Connecting to the MCP server…", "info");
        const probe = new McpSupervisorBackend({ settings: mcpSettingsFor(ctx), cwd: ctx.cwd });
        try {
          const found = await probe.discover();
          ctx.ui.notify(
            [
              `Endpoint: ${found.endpoint.source}`,
              found.server?.name ? `Server: ${found.server.name}${found.server.version ? ` v${found.server.version}` : ""}` : "",
              found.endpoint.missingEnv.length ? `Header variables not set: ${found.endpoint.missingEnv.join(", ")}` : "",
              `Tools (${found.tools.length}):`,
              ...found.tools.map((tool) => {
                const { required } = schemaParts(tool.inputSchema);
                return `  ${tool.name}(${required.join(", ")})${tool.description ? ` — ${tool.description.slice(0, 70)}` : ""}`;
              }),
            ]
              .filter(Boolean)
              .join("\n"),
            "info"
          );
        } catch (error) {
          ctx.ui.notify(`MCP discovery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          await probe.dispose();
        }
        return;
      }

      case "url":
      case "server":
      case "tool":
      case "prompt-arg":
      case "base-url":
      case "model":
      case "api-key-env":
      case "intro": {
        const key =
          verb === "prompt-arg"
            ? "promptArg"
            : verb === "base-url"
              ? "relayBaseUrl"
              : verb === "model"
                ? "relayModel"
                : verb === "api-key-env"
                  ? "relayApiKeyEnv"
                  : verb === "intro"
                    ? "relayIntroFile"
                    : verb;
        if (!value) {
          ctx.ui.notify(`Usage: /supervise mcp ${verb} <value> — or "clear" to unset`, "warning");
          return;
        }
        const clear = value === "clear";
        if (!saveMcpSettings(ctx.cwd, { [key]: clear ? "" : value })) {
          ctx.ui.notify("Could not save — create the .pi/ directory first.", "error");
          return;
        }
        ctx.ui.notify(`mcp.${key} = ${clear ? "(cleared)" : value}`, "info");
        return;
      }

      // --- the browser transport: the operator's own logged-in tab as the pipe ---
      // Each value is validated here, not only at run time. A setting accepted now and
      // refused later is worse than a refusal now, and for the adapter origin it is also
      // a question of where a POST containing the worker's own words would be sent.
      case "transport": {
        const which = value.toLowerCase();
        if (which !== "proxy" && which !== "browser") {
          ctx.ui.notify(`Usage: /supervise mcp transport proxy|browser — "proxy" is the pplx-proxy endpoint; "browser" drives your own logged-in Perplexity tab through the loopback adapter.`, "warning");
          return;
        }
        if (!saveMcpSettings(ctx.cwd, { relayTransport: which })) {
          ctx.ui.notify("Could not save — create the .pi/ directory first.", "error");
          return;
        }
        const relay = resolveRelay(mcpSettingsFor(ctx), ctx.cwd);
        ctx.ui.notify(
          which === "browser"
            ? `mcp.relayTransport = browser — ${describeRelay(mcpSettingsFor(ctx), ctx.cwd)}${relay.sessionUrl ? "" : "\nNo conversation pinned: a run attaches to whichever single Perplexity tab is open. Pin one with /supervise mcp session <url>."}`
            : `mcp.relayTransport = proxy — ${describeRelay(mcpSettingsFor(ctx), ctx.cwd)}`,
          "info"
        );
        return;
      }

      case "adapter": {
        if (!value) {
          ctx.ui.notify(`Usage: /supervise mcp adapter <http://127.0.0.1:<port>> — or "clear" for the default`, "warning");
          return;
        }
        if (value !== "clear") {
          let parsed: URL | null = null;
          try {
            parsed = new URL(value);
          } catch {
            /* reported by the check below, which is the point */
          }
          const host = parsed?.hostname.replace(/^\[|\]$/g, "") ?? "";
          const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
          if (parsed?.protocol !== "http:" || !loopback) {
            ctx.ui.notify(`Refusing "${value}": the adapter URL must be a plain http loopback origin (http://127.0.0.1:<port>). It receives the worker's own words, so it is never pointed at a remote host.`, "error");
            return;
          }
        }
        if (!saveMcpSettings(ctx.cwd, { browserAdapterUrl: value === "clear" ? "" : value })) {
          ctx.ui.notify("Could not save — create the .pi/ directory first.", "error");
          return;
        }
        ctx.ui.notify(`mcp.browserAdapterUrl = ${value === "clear" ? `(cleared → ${DEFAULT_MCP_SETTINGS.browserAdapterUrl})` : value}`, "info");
        return;
      }

      case "session": {
        if (!value) {
          ctx.ui.notify(`Usage: /supervise mcp session <https://www.perplexity.ai/session/<id>> — or "clear" to follow the open tab`, "warning");
          return;
        }
        if (value !== "clear" && !/^https:\/\/(www\.)?perplexity\.ai\/session\/[a-zA-Z0-9-]+/.test(value)) {
          ctx.ui.notify(`Refusing "${value}": a pinned conversation must be a https://www.perplexity.ai/session/<id> URL. Use "clear" to follow whichever single Perplexity tab is open.`, "error");
          return;
        }
        if (!saveMcpSettings(ctx.cwd, { browserSessionUrl: value === "clear" ? "" : value })) {
          ctx.ui.notify("Could not save — create the .pi/ directory first.", "error");
          return;
        }
        ctx.ui.notify(`mcp.browserSessionUrl = ${value === "clear" ? "(cleared — a run attaches to the open Perplexity tab)" : value}`, "info");
        return;
      }

      case "marker": {
        if (!value) {
          ctx.ui.notify(`Usage: /supervise mcp marker <text> — the first line of the code block that holds the next instruction`, "warning");
          return;
        }
        if (value === "clear") {
          if (!saveMcpSettings(ctx.cwd, { instructionMarker: "" })) {
            ctx.ui.notify("Could not save — create the .pi/ directory first.", "error");
            return;
          }
          ctx.ui.notify(`mcp.instructionMarker = (cleared → "${DEFAULT_MCP_SETTINGS.instructionMarker}")`, "info");
          return;
        }
        // A marker spanning lines, or padded, matches nothing at all — which the relay
        // would report as "no instruction", indistinguishable from a finished run.
        if (/[\r\n]/.test(value) || value.trim() !== value || !value.trim()) {
          ctx.ui.notify("Refusing: the marker must be a single line with no leading or trailing space.", "error");
          return;
        }
        if (!saveMcpSettings(ctx.cwd, { instructionMarker: value })) {
          ctx.ui.notify("Could not save — create the .pi/ directory first.", "error");
          return;
        }
        ctx.ui.notify(`mcp.instructionMarker = "${value}"`, "info");
        return;
      }

      case "arg": {
        // A server may require more than the transcript — a mode, a model, a
        // collection. Those are configured by their discovered names, and this
        // is the command the schema validator points at.
        const [argName, ...argRest] = value.split(/\s+/);
        const raw = argRest.join(" ").trim();
        if (!argName) {
          ctx.ui.notify(`Usage: /supervise mcp arg <name> <value> — or "clear" to unset. true/false/numbers are sent as such.`, "warning");
          return;
        }
        const previous = { ...(mcpSettingsFor(ctx).args ?? {}) };
        if (raw === "clear") {
          delete previous[argName];
          if (!saveMcpSettings(ctx.cwd, { args: previous })) {
            ctx.ui.notify("Could not save — create the .pi/ directory first.", "error");
            return;
          }
          ctx.ui.notify(`mcp.args.${argName} = (cleared)`, "info");
          return;
        }
        if (!raw) {
          ctx.ui.notify(`Usage: /supervise mcp arg ${argName} <value> — or "clear" to unset`, "warning");
          return;
        }
        const parsed: unknown = raw === "true" ? true : raw === "false" ? false : raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
        if (!saveMcpSettings(ctx.cwd, { args: { ...previous, [argName]: parsed } })) {
          ctx.ui.notify("Could not save — create the .pi/ directory first.", "error");
          return;
        }
        ctx.ui.notify(`mcp.args.${argName} = ${JSON.stringify(parsed)}`, "info");
        return;
      }
      case "stable-ms":
      case "max-wait":
      case "attempts":
      case "timeout":
      case "retries":
      case "iterations":
      case "minutes":
      case "report-chars":
      case "worker-chars": {
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount <= 0) {
          ctx.ui.notify(`Usage: /supervise mcp ${verb} <number>`, "warning");
          return;
        }
        const patch =
          verb === "stable-ms"
            ? { browserStableMs: Math.round(amount) }
            : verb === "max-wait"
              ? { browserMaxWaitMs: Math.round(amount) }
              : verb === "attempts"
                ? { browserMaxAttempts: Math.round(amount) }
                : verb === "timeout"
                  ? { timeoutMs: amount }
            : verb === "retries"
              ? { retries: Math.min(3, Math.round(amount)) }
              : verb === "iterations"
                ? { maxIterations: amount }
                : verb === "minutes"
                  ? { maxDurationMs: amount * 60000 }
                  : verb === "worker-chars"
                    ? { maxWorkerChars: amount }
                    : { maxReportChars: amount };
        if (!saveMcpSettings(ctx.cwd, patch)) {
          ctx.ui.notify("Could not save — create the .pi/ directory first.", "error");
          return;
        }
        ctx.ui.notify(`MCP limits: ${describeMcp(mcpSettingsFor(ctx), ctx.cwd)}`, "info");
        return;
      }

      default:
        ctx.ui.notify(
          [
            `Unknown /supervise mcp subcommand "${verb}".`,
            "Relay: /supervise mcp [settings] · status · base-url <url> · model <alias> · api-key-env <ENV> · intro <file> · worker-chars <n>",
            "Limits: timeout <ms> · retries <n> · iterations <n> · minutes <n>",
            "Browser relay: /supervise mcp transport proxy|browser · adapter <http://127.0.0.1:<port>> · session <perplexity /session url>|clear · marker <text> · stable-ms <n> · max-wait <ms> · attempts <n>",
            "MCP endpoint (tool discovery): tools · url <url> · server <name> · tool <name> · prompt-arg <name> · arg <name> <value> · report-chars <n>",
          ].join("\n"),
          "warning"
        );
    }
  }

  // ---- Mid-turn steering: medium and high sensitivity ----
  // turn_end fires after each LLM sub-turn (tool-call cycle) while the agent is still running.
  // low:    no mid-run checks at all
  // medium: check every 3rd tool cycle (turns 2, 5, 8, …), confidence >= 0.9
  // high:   check every tool cycle from turn 2, confidence >= 0.85

  pi.on("turn_end", async (event, ctx) => {
    if (!state.isActive()) return;
    // Mid-run interruption is a model-backend feature; the MCP supervisor
    // reviews finished worker runs and never breaks into one.
    if (state.getBackend() === "mcp") return;
    const s = state.getState()!;

    if (s.sensitivity === "low") return;
    if (event.turnIndex < 2) return; // let the agent settle before intervening
    if (s.sensitivity === "medium" && (event.turnIndex - 2) % 3 !== 0) return;

    let decision: SteeringDecision;
    try {
      decision = await analyze(ctx, s, false /* agent still working */, false /* can't stagnate mid-turn */);
    } catch {
      return;
    }

    // Higher bar for medium — less willing to disrupt productive work
    const threshold = s.sensitivity === "medium" ? 0.9 : 0.85;
    if (decision.action === "steer" && decision.message && decision.confidence >= threshold) {
      state.addIntervention({
        turnCount: s.turnCount,
        message: decision.message,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
      });
      updateUI(ctx, state.getState(), { type: "steering", message: decision.message });
      pi.sendUserMessage(decision.message, { deliverAs: "steer" });
    }
  });

  // ---- After each agent run: analyze + steer ----
  // agent_end fires once per user prompt, always with the agent idle and waiting for input.
  // This is the critical checkpoint for all sensitivity levels.

  pi.on("agent_end", async (_event, ctx) => {
    if (!state.isActive()) return;

    state.incrementTurnCount();
    const s = state.getState()!;

    // The MCP supervisor reviews finished worker runs at agent_settled. Here it
    // only arms the compatibility path for hosts that never emit that event.
    if (state.getBackend() === "mcp") {
      loopCtx = ctx;
      loop.onWorkerEnd(ctx);
      updateUI(ctx, s, widgetAction(s));
      return;
    }

    // Stagnation: too many steers with no "done" → final lenient evaluation
    const stagnating = idleSteers >= MAX_IDLE_STEERS;

    updateUI(ctx, s, { type: "analyzing", turn: s.turnCount });

    const decision = await analyze(ctx, s, true /* always idle at agent_end */, stagnating, undefined, (accumulated) => {
      const thinking = extractThinking(accumulated);
      updateUI(ctx, state.getState()!, { type: "analyzing", turn: s.turnCount, thinking });
    });

    if (decision.action === "steer" && decision.message) {
      idleSteers++;
      state.addIntervention({
        turnCount: s.turnCount,
        message: decision.message,
        reasoning: decision.reasoning,
        timestamp: Date.now(),
      });
      updateUI(ctx, state.getState(), { type: "steering", message: decision.message });
      pi.sendUserMessage(decision.message);
    } else if (decision.action === "done") {
      idleSteers = 0;
      updateUI(ctx, state.getState(), { type: "done" });
      const suffix = stagnating ? ` (stopped after ${MAX_IDLE_STEERS} steering attempts — goal substantially achieved)` : "";
      ctx.ui.notify(`Supervisor: outcome achieved! "${s.outcome}"${suffix}`, "info");
      state.stop();
      updateUI(ctx, state.getState());
    } else {
      updateUI(ctx, state.getState(), { type: "watching" });
    }
  });

  // ---- /supervise command ----

  pi.registerCommand("supervise", {
    description: "Supervise the chat toward a desired outcome (/supervise <outcome>)",
    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      // Nothing below this point may reach the loop, the backend, or the worker unless
      // the text is a real goal. pi hands this handler everything after the first
      // space — newlines included — so a buffered or pasted submission can arrive as
      // "status\n/supervise status". That is a control command with something stuck
      // to it, and it is reported, never started.
      const refusal = nonGoalReason(trimmed);
      if (refusal) {
        ctx.ui.notify(refusal, "warning");
        return;
      }
      // --- subcommands ---

      if (trimmed === "widget") {
        const visible = toggleWidget();
        if (state.isActive()) {
          updateUI(ctx, state.getState());
        }
        ctx.ui.notify(`Supervisor widget ${visible ? "shown" : "hidden"}.`, "info");
        return;
      }

      if (trimmed === "stop") {
        if (!state.isActive()) {
          ctx.ui.notify("Supervisor is not active.", "warning");
          return;
        }
        await haltLoop(ctx);
        state.stop();
        idleSteers = 0;
        updateUI(ctx, state.getState());
        ctx.ui.notify("Supervisor stopped.", "info");
        return;
      }

      if (trimmed === "status") {
        // Exactly one notification, built defensively. pi sends a throwing
        // command handler to its extension-error path instead of showing
        // anything, which is how this command came to look like it did nothing;
        // a bad setting can therefore only be reported here, never silence it.
        let text: string;
        try {
          text = statusLines(ctx).join("\n");
        } catch (error) {
          ctx.ui.notify(
            [
              "Supervisor: status could not be read.",
              `Reason: ${error instanceof Error ? error.message : String(error)}`,
              "/supervise stop and start a new run, or report this.",
            ].join("\n"),
            "warning"
          );
          return;
        }
        ctx.ui.notify(text, "info");
        return;
      }

      if (trimmed === "resume") {
        const s = state.getState();
        if (!s) {
          const missing = state.getMissingStateNote();
          ctx.ui.notify(
            [
              "Nothing to resume — no supervisor state in this session. Use /supervise <outcome> to start.",
              ...(missing ? [missing] : []),
            ].join("\n"),
            "info"
          );
          return;
        }
        if (state.getBackend() !== "mcp") {
          if (!s.active) {
            ctx.ui.notify("Supervision already finished. Start again with /supervise <outcome>.", "info");
            return;
          }
          state.setPhase("working");
          updateUI(ctx, state.getState(), widgetAction(state.getState()));
          ctx.ui.notify("Supervision resumed — the next checkpoint will evaluate the run.", "info");
          return;
        }
        // Resuming the relay loop also outlives this handler — same reason as a
        // fresh start, so the same host modes are refused here.
        if (ctx.mode === "print" || ctx.mode === "json") {
          ctx.ui.notify(
            "Cannot resume the relay here: this host exits after its last prompt and disposes the session, but the relay run continues past the last prompt. Run /supervise resume in an interactive session.",
            "warning"
          );
          return;
        }
        if (!s.active) {
          // The goal is still the one on screen; restart the run without replaying
          // whatever instruction was last dispatched.
          state.start(s.outcome, s.provider, s.modelId, s.sensitivity, {
            backend: "mcp",
            acceptanceCriteria: s.acceptanceCriteria,
            mcpSummary: s.mcpSummary,
            // Resume keeps the conversation it had — and the fact that the relay
            // setup already went into it, so the setup is not sent twice.
            conversationId: s.conversationId ?? newConversationId(ctx.cwd, Date.now()),
            relayIntroSent: s.relayIntroSent,
          });
        }
        idleSteers = 0;
        updateUI(ctx, state.getState(), widgetAction(state.getState()));
        const resumed = await loop.resume(ctx);
        ctx.ui.notify(
          resumed
            ? "Supervision resumed — asking the supervisor for the next step."
            : "The loop is already running. /supervise stop first if it is wedged.",
          resumed ? "info" : "warning"
        );
        return;
      }

      if (trimmed === "backend" || trimmed.startsWith("backend ")) {
        const wanted = trimmed.slice("backend".length).trim();
        if (!wanted) {
          ctx.ui.notify(`Current backend: ${state.getBackend()}. Switch with /supervise backend model|mcp`, "info");
          return;
        }
        if (wanted !== "model" && wanted !== "mcp") {
          ctx.ui.notify("Usage: /supervise backend model | /supervise backend mcp", "warning");
          return;
        }
        if (!saveWorkspaceBackend(ctx.cwd, wanted)) {
          ctx.ui.notify("Could not save the backend — create the .pi/ directory first, or set it in .pi/supervisor-config.json.", "warning");
          return;
        }
        if (wanted === "model") await haltLoop(ctx);
        ctx.ui.notify(
          wanted === "mcp"
            ? `Backend: Perplexity chat relay — ${describeRelay(mcpSettingsFor(ctx), ctx.cwd)}.\nEach reply becomes the worker's next instruction; the worker's answer goes back into the same conversation. Configure with /supervise mcp, then start: /supervise <outcome>`
            : "Backend: Pi model — mid-run and end-of-run review as before.",
          "info"
        );
        updateUI(ctx, state.getState(), widgetAction(state.getState()));
        return;
      }

      if (trimmed === "mcp" || trimmed.startsWith("mcp ")) {
        await handleMcpCommand(ctx, trimmed.slice(3).trim());
        return;
      }

      if (trimmed === "model" || trimmed.startsWith("model ")) {
        const spec = trimmed.slice(5).trim(); // "" when no args

        if (!spec) {
          // No args → open the interactive pi-style model picker
          const s = state.getState();
          const picked = await pickModel(ctx, s?.provider, s?.modelId);
          if (!picked) return; // user cancelled

          const provider = picked.provider;
          const modelId = picked.id;

          if (state.isActive()) {
            state.setModel(provider, modelId);
            updateUI(ctx, state.getState());
          }
          const saved = saveWorkspaceModel(ctx.cwd, provider, modelId);
          ctx.ui.notify(
            `Supervisor model set to ${provider}/${modelId}${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
              (saved ? " · saved to .pi/" : ""),
            "info"
          );
          return;
        }

        // Args provided → direct assignment (for scripting)
        const slashIdx = spec.indexOf("/");
        let provider: string;
        let modelId: string;
        if (slashIdx === -1) {
          provider = state.getState()?.provider ?? DEFAULT_PROVIDER;
          modelId = spec;
        } else {
          provider = spec.slice(0, slashIdx);
          modelId = spec.slice(slashIdx + 1);
        }

        if (state.isActive()) {
          state.setModel(provider, modelId);
          updateUI(ctx, state.getState());
        }
        const saved = saveWorkspaceModel(ctx.cwd, provider, modelId);
        ctx.ui.notify(
          `Supervisor model set to ${provider}/${modelId}${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
            (saved ? " · saved to .pi/" : ""),
          "info"
        );
        return;
      }

      if (trimmed.startsWith("sensitivity ")) {
        const level = trimmed.slice(12).trim() as Sensitivity;
        if (level !== "low" && level !== "medium" && level !== "high") {
          ctx.ui.notify("Usage: /supervise sensitivity <low|medium|high>", "warning");
          return;
        }
        if (!state.isActive()) {
          ctx.ui.notify(`Sensitivity will be set to "${level}" on next /supervise.`, "info");
        } else {
          state.setSensitivity(level);
          updateUI(ctx, state.getState());
          ctx.ui.notify(`Supervisor sensitivity set to "${level}"`, "info");
        }
        return;
      }

      // --- interactive settings panel ---

      if (!trimmed || trimmed === "settings") {
        const s = state.getState();
        const result = await openSettings(ctx, s, DEFAULT_PROVIDER, DEFAULT_MODEL_ID, DEFAULT_SENSITIVITY, {
          backend: backendFor(ctx.cwd),
          mcpSummary: describeMcp(mcpSettingsFor(ctx), ctx.cwd),
        });
        if (!result) return; // user cancelled with no changes

        // Apply model change
        if (result.model) {
          const { provider: p, modelId: m } = result.model;
          if (state.isActive()) {
            state.setModel(p, m);
          }
          const saved = saveWorkspaceModel(ctx.cwd, p, m);
          ctx.ui.notify(
            `Supervisor model set to ${p}/${m}${state.isActive() ? "" : " (takes effect on next /supervise)"}` +
              (saved ? " · saved to .pi/" : ""),
            "info"
          );
        }

        // Apply sensitivity change
        if (result.sensitivity) {
          if (state.isActive()) {
            state.setSensitivity(result.sensitivity);
          }
          ctx.ui.notify(`Supervisor sensitivity set to "${result.sensitivity}"`, "info");
        }

        // Apply widget toggle
        if (result.widget !== undefined) {
          const currentlyVisible = isWidgetVisible();
          if (result.widget !== currentlyVisible) {
            toggleWidget();
          }
        }

        // Apply backend change (model ⇄ MCP) — persisted per project
        if (result.backend) {
          if (!saveWorkspaceBackend(ctx.cwd, result.backend)) {
            ctx.ui.notify("Could not save the backend — create the .pi/ directory first.", "warning");
          } else {
            if (result.backend === "model") await haltLoop(ctx);
            ctx.ui.notify(
              result.backend === "mcp"
                ? `Backend: Perplexity chat relay — ${describeRelay(mcpSettingsFor(ctx), ctx.cwd)}.`
                : "Backend: Pi model — mid-run and end-of-run review as before.",
              "info"
            );
          }
        }

        // Open the MCP settings page from here or from /supervise mcp
        if (result.action === "mcp") await handleMcpCommand(ctx, "");

        // Apply stop action
        if (result.action === "stop" && state.isActive()) {
          await haltLoop(ctx);
          state.stop();
          idleSteers = 0;
          ctx.ui.notify("Supervisor stopped.", "info");
        }

        updateUI(ctx, state.getState(), widgetAction(state.getState()));
        return;
      }

      // Resolve model settings: session state → workspace config → active session model → built-in defaults
      const existing = state.getState();
      const workspaceModel = loadWorkspaceModel(ctx.cwd);
      const sessionModel = ctx.model;
      let provider = existing?.provider ?? workspaceModel?.provider ?? sessionModel?.provider ?? DEFAULT_PROVIDER;
      let modelId  = existing?.modelId  ?? workspaceModel?.modelId  ?? sessionModel?.id      ?? DEFAULT_MODEL_ID;
      const sensitivity = existing?.sensitivity ?? DEFAULT_SENSITIVITY;

      // Only prompt for a model if none has been configured yet. The MCP backend
      // needs no supervisor API key at all: the worker keeps the session model.
      const backend = backendFor(ctx.cwd);
      if (!existing && backend !== "mcp") {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
        if (!apiKey) {
          ctx.ui.notify(`No API key for "${provider}/${modelId}" — pick a model with an available key.`, "warning");
          const picked = await pickModel(ctx, provider, modelId);
          if (!picked) return; // user cancelled
          provider = picked.provider;
          modelId = picked.id;
        }
      }

      // A new goal owns a new conversation: nothing is inherited from a previous
      // run, and the relay never attaches to a conversation it did not open.
      const conversationId = newConversationId(ctx.cwd, Date.now());
      if (backend === "mcp") {
        // The relay flow outlives this handler: the worker dispatch, the settle, and
        // the next request all happen after it returns. Print modes process their
        // positional prompts sequentially, then exit and dispose the session, so they
        // cannot host a run — refuse up front instead of losing the run mid-flight
        // (the 2026-11-08 01:27Z attempt failed exactly that way).
        if (ctx.mode === "print" || ctx.mode === "json") {
          ctx.ui.notify(
            "Cannot start the relay here: this host exits after its last prompt and disposes the session, but the relay run continues past the last prompt. Re-run this goal in an interactive session.",
            "warning"
          );
          return;
        }
        // Better to refuse here than to fail on the first turn with a worse message.
        const issues = relayConfigIssues(mcpSettingsFor(ctx), ctx.cwd);
        if (issues.length) {
          ctx.ui.notify(`Cannot start the relay: ${issues.join("; ")}`, "error");
          return;
        }
      }
      state.start(trimmed, provider, modelId, sensitivity, { backend, conversationId });
      idleSteers = 0;
      loopCtx = ctx;
      updateUI(ctx, state.getState(), widgetAction(state.getState()));

      if (backend === "mcp") {
        // The extension owns this loop. Ask the supervisor for the first
        // instruction and start the worker now — do not merely arm an observer
        // and wait for a worker run the user has not requested.
        const started = await loop.start(ctx);
        const relay = describeRelay(mcpSettingsFor(ctx), ctx.cwd);
        ctx.ui.notify(
          started
            ? `Supervisor active (Perplexity relay): "${trimmed.slice(0, 50)}${trimmed.length > 50 ? "…" : ""}" via ${relay}. Its replies drive the worker; /supervise status to inspect, /supervise stop to end.`
            : `The relay did not deliver a first instruction — see /supervise status for the reason.`,
          started ? "info" : "warning"
        );
        return;
      }

      const { source } = loadSystemPrompt(ctx.cwd);
      const promptLabel = source === "built-in" ? "built-in prompt" : source.replace(ctx.cwd, ".");
      ctx.ui.notify(
        `Supervisor active: "${trimmed.slice(0, 50)}${trimmed.length > 50 ? "…" : ""}" | ${provider}/${modelId} | ${promptLabel}`,
        "info"
      );
    },
  });

  // ---- Tool: model can initiate supervision but never modify an active session ----

  pi.registerTool({
    name: "start_supervision",
    label: "Start Supervision",
    description:
      "Activate the supervisor to track the conversation toward a specific outcome. " +
      "The supervisor will observe every turn and steer the agent if it drifts. " +
      "Once supervision is active it is locked — only the user can change or stop it.",
    parameters: Type.Object({
      outcome: Type.String({
        description:
          "The desired end-state to supervise toward. Be specific and measurable " +
          "(e.g. 'Implement JWT auth with refresh tokens and full test coverage').",
      }),
      sensitivity: Type.Optional(Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
      ], {
        description:
          "How aggressively to steer. low = only when seriously off track, " +
          "medium = on mild drift (default), high = proactively + mid-turn checks.",
      })),
      model: Type.Optional(Type.String({
        description:
          "Supervisor model as 'provider/modelId' (e.g. 'anthropic/claude-haiku-4-5-20251001'). " +
          "Defaults to workspace config, then the active chat model.",
      })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const text = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], details: undefined });

      // An MCP-backed project is driven by the remote supervisor and can only be
      // started by the user — the worker must not arm a second, different one.
      if (backendFor(ctx.cwd) === "mcp") {
        return text(
          `This project uses the MCP supervisor backend, which the user starts with /supervise <outcome>.\n` +
            `Nothing has changed. Do not retry this tool.`
        );
      }

      // Guard: supervision already active — model cannot modify it
      if (state.isActive()) {
        const s = state.getState()!;
        return text(
          `Supervision is already active and cannot be changed by the model.\n` +
          `Active outcome: "${s.outcome}"\n` +
          `Only the user can stop or modify supervision via /supervise.`
        );
      }

      // Resolve sensitivity
      const sensitivity: Sensitivity = params.sensitivity ?? DEFAULT_SENSITIVITY;

      // Resolve model: tool param → workspace config → active session model → built-in default
      let provider: string;
      let modelId: string;
      if (params.model) {
        const slash = params.model.indexOf("/");
        provider = slash === -1 ? DEFAULT_PROVIDER : params.model.slice(0, slash);
        modelId  = slash === -1 ? params.model     : params.model.slice(slash + 1);
      } else {
        const workspaceModel = loadWorkspaceModel(ctx.cwd);
        const sessionModel   = ctx.model;
        provider = workspaceModel?.provider ?? sessionModel?.provider ?? DEFAULT_PROVIDER;
        modelId  = workspaceModel?.modelId  ?? sessionModel?.id      ?? DEFAULT_MODEL_ID;
      }

      state.start(params.outcome, provider, modelId, sensitivity);
      idleSteers = 0;
      updateUI(ctx, state.getState());

      const { source } = loadSystemPrompt(ctx.cwd);
      const promptLabel = source === "built-in" ? "built-in prompt" : ".pi/SUPERVISOR.md";

      // Notify the user so they're aware supervision was initiated by the model
      ctx.ui.notify(
        `Supervisor started by agent: "${params.outcome.slice(0, 60)}${params.outcome.length > 60 ? "…" : ""}" | ${provider}/${modelId} | sensitivity: ${sensitivity} | ${promptLabel}`,
        "info"
      );

      return text(`Supervision active. Outcome: "${params.outcome}" | ${provider}/${modelId} | sensitivity: ${sensitivity}`);
    },
  });
}

