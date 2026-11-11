/**
 * command-intent — is this argument a control command, or a goal?
 *
 * pi dispatches an extension command by splitting the submitted text at the *first*
 * space and handing the handler everything after it, newlines and all
 * (`agent-session.js` → `_tryExecuteExtensionCommand`). That is reasonable behaviour
 * for a shell-like tool, and it has a consequence this extension has to own: a goal is
 * any text that is not an exact subcommand, so a submission that was meant to be
 *
 *     /supervise status
 *     /supervise status
 *
 * arrives as one argument — `"status\n/supervise status"` — and previously became a
 * supervision goal, opening a live conversation and dispatching a worker run in
 * response to what was only ever meant to be a status request.
 *
 * The rules here are deliberately narrow, because the opposite failure is worse: a
 * real goal that begins with an ordinary English word ("status reporting must retry")
 * must still start a run.
 */

/** Words that select behaviour instead of describing an outcome. */
export const SUPERVISE_SUBCOMMANDS = [
  "widget",
  "stop",
  "status",
  "resume",
  "backend",
  "mcp",
  "model",
  "sensitivity",
  "settings",
] as const;

const preview = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => `│ ${line}`)
    .join("\n")
    .slice(0, 400);

/**
 * Why this argument must **not** start or change a run, or `""` when it is a genuine
 * goal. Returning a reason never mutates anything — the caller's job is to say it and
 * return without touching the loop, the backend, or the worker.
 */
export function nonGoalReason(args: string): string {
  const text = args.trim();
  if (!text) return ""; // empty opens the settings panel, as before

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const firstLine = lines[0] ?? "";
  const firstWord = firstLine.split(/\s+/)[0].toLowerCase();

  // A nested invocation: the user's own command text ended up inside the argument,
  // which is what a buffered or pasted submission looks like.
  if (lines.some((line) => line.startsWith("/"))) {
    return [
      "This was not treated as a goal: the text contains a slash command.",
      preview(text),
      "Nothing was started, nothing was sent to a supervisor, and the saved goal is unchanged.",
      "Send one command at a time — /supervise status reports, /supervise <outcome> starts a run.",
    ].join("\n");
  }

  // A control word carrying trailing text: `status\n/supervise status` is a status
  // request with something stuck to it, not a goal called "status".
  if (lines.length > 1 && (SUPERVISE_SUBCOMMANDS as readonly string[]).includes(firstWord)) {
    return [
      `"/supervise ${firstWord}" is a command, but this submission carried ${lines.length} lines, so it was not run as one and was not started as a goal.`,
      preview(text),
      "Nothing was started, nothing was sent to a supervisor, and the saved goal is unchanged.",
    ].join("\n");
  }

  return "";
}
