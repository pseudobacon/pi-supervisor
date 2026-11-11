/**
 * Workspace-level supervisor config — persists model selection to .pi/supervisor-config.json.
 * Only written when the .pi/ directory already exists.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SupervisorBackendId } from "./types.js";

const PI_DIR = ".pi";
const CONFIG_FILE = "supervisor-config.json";

export interface WorkspaceModelConfig {
  provider: string;
  modelId: string;
}

/** Read model config from <cwd>/.pi/supervisor-config.json. Returns null if absent or unreadable. */
export function loadWorkspaceModel(cwd: string): WorkspaceModelConfig | null {
  const configPath = join(cwd, PI_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof parsed.provider === "string" && typeof parsed.modelId === "string") {
      return { provider: parsed.provider, modelId: parsed.modelId };
    }
  } catch {}
  return null;
}

/**
 * Write model config to <cwd>/.pi/supervisor-config.json.
 * Silently skips if the .pi/ directory does not exist.
 * Unrelated keys in the file (e.g. the `mcp` section) are preserved.
 * Returns true when the file was written.
 */
export function saveWorkspaceModel(cwd: string, provider: string, modelId: string): boolean {
  const piDir = join(cwd, PI_DIR);
  if (!existsSync(piDir)) return false;
  try {
    const path = join(piDir, CONFIG_FILE);
    let existing: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
      } catch {}
    }
    writeFileSync(path, `${JSON.stringify({ ...existing, provider, modelId }, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Which supervisor answers: the Pi model, or a remote MCP tool.
 * Stored in the same file so a project can pin its backend next to its model.
 */
export function loadWorkspaceBackend(cwd: string): SupervisorBackendId | null {
  const configPath = join(cwd, PI_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).backend : undefined;
    return value === "model" || value === "mcp" ? value : null;
  } catch {
    return null;
  }
}

/** Write the backend preference. Silently skips when .pi/ is absent. */
export function saveWorkspaceBackend(cwd: string, backend: SupervisorBackendId): boolean {
  const piDir = join(cwd, PI_DIR);
  if (!existsSync(piDir)) return false;
  try {
    const path = join(piDir, CONFIG_FILE);
    let existing: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
      } catch {}
    }
    writeFileSync(path, `${JSON.stringify({ ...existing, backend }, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}
