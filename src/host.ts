/**
 * host — the seam for host-version-specific behaviour.
 *
 * `agent_settled` is a first-class extension event in pi 1.5.0, so the
 * subscription is a plain typed call. The caller keeps its `agent_end`
 * fallback so a run is still reviewed on hosts that only emit `agent_end`
 * (the fallback's own idle/queue check keeps it from injecting into a live
 * run).
 */

import type { AgentSettledEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SettleHandler = (event: AgentSettledEvent, ctx: ExtensionContext) => void | Promise<void>;

/**
 * Subscribe to `agent_settled` — the authoritative "nothing more will run"
 * boundary for a worker run. Always registers on the 1.5.0 host.
 */
export function onAgentSettled(pi: ExtensionAPI, handler: SettleHandler): boolean {
  pi.on("agent_settled", handler);
  return true;
}
