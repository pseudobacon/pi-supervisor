// Generated from the 2026-11-07 21:30 UTC supervision run in this workspace
// (session 01a1b7eb-7423-74fc-9721-fce9c4e1d1d9, entries 3, 12, 20). Byte-exact:
// these are the replies that exposed the control-flow bugs, kept as a fixture so they
// can never regress silently. Do not retype, rewrap, or prettify them.

/** What a `/supervise status` submission arrived as: pi splits the command at the first
 * space and passes the rest verbatim, newline included. */
export const GOAL_AS_SUBMITTED = "status\n/supervise status";

/** Perplexity's first reply: prose with the blocked marker appended to its final line,
 * and the provider's quota annotation on a line of its own afterwards. */
export const REPLY_1 = "Please provide a concise status report: what task you are currently working on, the last completed step, the next step, and any blockers. Include the exact commands or checks you have run and their relevant output if they establish progress. [[PPLX_BLOCKED]]\n\n[Remaining Pro Search: 45]";

/** Perplexity's second reply, produced after the worker's empty final response was
 * relayed as if it were a normal result. */
export const REPLY_2 = "The previous run ended without a final response, so there is no verified status or completed work to accept. Start by inspecting the repository state and reporting concrete evidence before making changes.\n\nRun `git status --short --branch`, `git log --oneline -5`, and list any uncommitted or newly created files relevant to the task. Then report: the current branch, pending changes, the last meaningful commit, and what objective you infer remains incomplete. Do not begin implementation yet. [[PPLX_BLOCKED]]\n\n[Remaining Pro Search: 45]";
