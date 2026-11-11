/**
 * model-client — calls the supervisor LLM using pi's internal agent session API.
 *
 * callModel        — low-level: returns raw response text
 * callSupervisorModel — high-level: parses response as SteeringDecision
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { parseDecision, safeContinue } from "./decision.js";
import type { SteeringDecision } from "./types.js";

/**
 * Run a one-shot LLM call using pi's internal agent session.
 * Returns the raw response text, or null on failure.
 */
export async function callModel(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  onDelta?: (accumulated: string) => void
): Promise<string | null> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) return null;

  // pi-coding-agent 1.5.0: without an explicit modelRuntime the session
  // builds its own from the agent dir's auth.json and models.json — the same
  // catalogue and credentials as the host session, with no network refresh.
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt,
  });
  await loader.reload();

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  try {
    const result = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      agentDir,
      model,
      tools: [],
      resourceLoader: loader,
    });
    session = result.session;
  } catch {
    return null;
  }

  const onAbort = () => session.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let responseText = "";
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      responseText += event.assistantMessageEvent.delta;
      onDelta?.(responseText);
    }
  });

  try {
    await session.prompt(userPrompt);
  } catch {
    return null;
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", onAbort);
    session.dispose();
  }

  return responseText;
}

/**
 * Run a one-shot supervisor analysis.
 * Returns { action: "continue" } on any failure so the chat is never interrupted.
 */
export async function callSupervisorModel(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  onDelta?: (accumulated: string) => void
): Promise<SteeringDecision> {
  const text = await callModel(ctx, provider, modelId, systemPrompt, userPrompt, signal, onDelta);
  if (text === null) return safeContinue("Model call failed");
  return parseDecision(text);
}

// ---- Response parsing ----
//
// One parser for both backends lives in ./decision.ts so the model-backed and
// MCP-backed paths cannot drift apart. Re-exported here because it has always
// been part of this module's surface (and is covered by unit tests).

export { parseDecision, safeContinue } from "./decision.js";
