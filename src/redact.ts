/**
 * redact — strip credential-looking material from text before it leaves the machine.
 *
 * Everything the supervisor sends to a remote MCP server is worker output the model
 * produced, so it can legitimately contain keys that were echoed by a tool result.
 * `redact()` runs on every outbound report and on every string we log or persist.
 */

/** Patterns matched (case-insensitively) and replaced with `[REDACTED <label>]`. */
const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "PEM key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { label: "AWS key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "Bearer token", re: /\b(authorization\s*:\s*)bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { label: "sk- key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g },
  {
    label: "secret",
    // key/value assignments the worker echoed, e.g. api_key = "…" or PASSWORD=…
    re: /\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|cookie|set-cookie|token)["'\s]*[=:]\s*)["']?(?!\[REDACTED)[^\s"'&,}<]{6,}["']?/gi,
  },
];

/** Replace anything that looks like a credential with a stable placeholder. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { label, re } of PATTERNS) out = out.replace(re, (_m, prefix?: string) => `${prefix ?? ""}[REDACTED ${label}]`);
  return out;
}

/**
 * Redact URL credentials (`https://user:tok@host`) and drop query strings, which
 * are a common place for API keys on HTTP MCP endpoints. Used for status output.
 */
export function redactUrl(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.username) u.username = "user";
    if (u.password) u.password = "redacted";
    if (u.search) u.search = "?<redacted>";
    if (u.hash) u.hash = "";
    return u.toString();
  } catch {
    // Not a URL — still scrub it rather than echoing unknown input.
    return redactSecrets(raw);
  }
}

/** True when `text` contains anything the redactor would strip. Used by tests/diagnostics. */
export function looksSecret(text: string): boolean {
  return PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/**
 * Redact the strings of a decision that this extension will put in front of the
 * worker or the user. Parsing happens on the untouched reply so a quoted command
 * cannot invalidate the JSON; the outbound copy is what must stay clean, because
 * the instruction lands in the session transcript and persists with it.
 */
export function redactDecision<T extends { message?: string; reasoning?: string; blocker?: string; criteria?: Array<{ criterion: string; evidence: string; met: boolean }> }>(decision: T): T {
  return {
    ...decision,
    ...(decision.message !== undefined ? { message: redactSecrets(decision.message) } : {}),
    ...(decision.reasoning !== undefined ? { reasoning: redactSecrets(decision.reasoning) } : {}),
    ...(decision.blocker !== undefined ? { blocker: redactSecrets(decision.blocker) } : {}),
    ...(decision.criteria
      ? { criteria: decision.criteria.map((c) => ({ criterion: redactSecrets(c.criterion), evidence: redactSecrets(c.evidence), met: c.met })) }
      : {}),
  };
}
