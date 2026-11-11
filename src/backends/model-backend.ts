/**
 * backends/model-backend — the original Pi-model supervisor, behaviour unchanged.
 *
 * A thin adapter over engine.analyze() so both backends speak one interface.
 * Everything that made it what it is — SUPERVISOR.md discovery, the
 * sensitivity-shaped snapshot, streaming deltas, the "never interrupt the chat"
 * fallback — still lives in engine.ts and model-client.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { analyze } from "../engine.js";
import type { BackendOutcome, SupervisorBackend, SupervisorRequest } from "./types.js";

export interface ModelBackendOptions {
  ctx: ExtensionContext;
  /** For status output only, e.g. "anthropic/claude-haiku-4-5". */
  modelLabel?: string;
}

export class ModelSupervisorBackend implements SupervisorBackend {
  readonly id = "model" as const;

  constructor(private readonly opts: ModelBackendOptions) {}

  get label(): string {
    return this.opts.modelLabel ? `model ${this.opts.modelLabel}` : "Pi model";
  }

  async review(request: SupervisorRequest, signal?: AbortSignal): Promise<BackendOutcome> {
    const decision = await analyze(
      this.opts.ctx,
      request.state,
      request.agentIsIdle,
      request.stagnating,
      signal,
      request.onDelta
    );
    return { decision, raw: JSON.stringify(decision), detail: this.label };
  }
}
