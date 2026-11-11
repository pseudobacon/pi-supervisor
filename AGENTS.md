# Working rules for agents in this repository

Read `HANDOFF.md` first. It says where the last session stopped, what was verified,
and what is next; `DEVELOPMENT-LOG.md` holds the dated historical record behind it.
Then verify both — see "Before you trust anything below".

## Before you trust anything

- `git branch --show-current` and `git status --porcelain` before acting. This tree is
  deliberately dirty: uncommitted work is normal here and is not yours to discard.
- Read the code, not the summary. `HANDOFF.md`, `DEVELOPMENT-LOG.md`, and any PR/issue
  description are claims about the tree, not the tree. If they disagree, the tree wins.
- Re-run the checks rather than repeating a recorded result. `npm run typecheck && npm run
  lint && npm test` takes seconds and is the only thing that proves the state.

## Working tree

- Never `reset`, `checkout -- `, `clean`, `stash`, or overwrite files you did not change.
  If something looks like stray damage, ask; do not erase it.
- Do not commit, amend, push, tag, or open a pull request unless the user asks for it in
  these words. Staying dirty is the expected end state of a session.
- Do not modify the worker's model selection, `models.json`, provider config, or
  `~/.pi/agent/mcp.json`. This extension reads `mcp.json`; it never writes it.

## Shape of the code

- **Extend, do not rewrite.** `src/index.ts` was once rewritten from scratch in a
  well-intentioned refactor and silently lost mid-run steering, stagnation detection, the
  thinking stream, and the `start_supervision` tool. Every one of those losses was invisible
  until a test caught it. Edit it with anchors and keep every existing behaviour.
- Keep the **model backend working**. It is the shipped behaviour; the MCP backend is an
  additional one. A change that makes MCP nicer by making `model` different is a regression.
- New abstractions go in the existing seams: `src/backends/` for a supervisor backend,
  `src/mcp/` for MCP plumbing, `src/loop.ts` for the supervision loop's lifecycle,
  `src/decision.ts` / `src/report.ts` / `src/redact.ts` for the pure parts. Tests import
  those directly — that is why they are pure.
- `package.json` scripts are the contract: `typecheck`, `lint`, `test`, `build`. Run them.
- The **chat relay** (`src/relay/`, `src/backends/relay-backend.ts`) is a **literal text relay**
  between an **existing** Perplexity conversation (supplied by the operator, attached through the
  proxy's real conversation mechanism) and the Pi worker. It is not an evaluator and not a chat
  the extension initializes: no relay intro, no built-in template in this flow, no persona, no
  goal reminders, no acceptance criteria, no appended tool context — nothing is added to either
  side's text. The operator's initial prompt goes **directly to the worker, verbatim, with zero
  Perplexity requests**; never send it back to Perplexity and never mint a replacement
  conversation. Attachment is strict (`previous_response_id` chaining — the proxy 404s unknown
  ids; the `conversation` param silently starts fresh on an unknown id, so it is never trusted
  for continuity); a new run must not attach to an arbitrary recent conversation, and a failed
  attachment fails visibly rather than falling back. The worker's final text **is** the next user
  message in the chat (empty final output → pause); Perplexity's reply **is** the next worker
  instruction. Completion is a separate explicit choice: manual stop plus the safety ceilings by
  default; a terminal-marker convention is parsed **only when explicitly enabled** — then the
  grammar accepts exactly the two observed forms at the terminal position, and removing the
  marker itself is the documented exception to verbatim. Do not reintroduce an action/instruction
  JSON contract here; that is the evaluator's shape, not this one.
- A setting does not exist until a loader names it. `loadConfig`/`loadMcpSettings` rebuild these
  objects field by field, so an unlisted key is **silently dropped** — which once made a test
  suite fall through to the default endpoint and bill the developer's live proxy. Every setting
  gets a round-trip assertion (`test/relay-config.test.ts`).
- **A test may never reach the developer's proxy.** Anything that exercises the relay writes its
  own `.pi/supervisor-config.json`, resolves the endpoint with `resolveRelayConfig`, and refuses
  to send a byte unless it is the fake server. `PPLX_PROXY_URL` in a developer shell is a live,
  billable endpoint; so is `http://127.0.0.1:8892`, which is the default.
- Marker parsing runs **only when a terminal convention is explicitly enabled**; by default the
  relay completes only via operator stop or a safety ceiling. When enabled, a marker that does not
  terminate the reply is a **protocol error**: pause, say so, dispatch nothing, and do **not**
  send a repair request. Retrying the supervisor's formatting is how a
  blocked run gets sent back to work. The grammar accepts exactly the two observed forms, and
  the only thing removed from the displayed text is the marker itself.
- An interrupted or unanswered worker run **pauses the relay**; Perplexity is not told about it
  automatically. `/supervise resume` is the one moment the interruption is relayed, because the
  human asked. A run that completed and reported failures is a result and travels on — the
  distinction is `stopReason` and whether a final message exists, not exit codes.
- `/supervise` subcommands are matched on the **whole** argument, because pi hands the handler
  everything after the first space, newlines included (`agent-session.js`,
  `_tryExecuteExtensionCommand`). `nonGoalReason()` in `src/command-intent.ts` keeps a
  multi-line or nested submission from becoming a goal. `/supervise status` stays local in every
  phase: no backend construction, no worker dispatch, no change to the saved goal.
- The backend id stays `mcp` for persisted-config and session compatibility; the label
  reads `pplx-proxy chat relay`. Do not rename the id.
- pplx-proxy appends its quota notice to the answer text (`server.py:201`) and strips that same
  notice when rebuilding history (`server.py:1208`). `relay/chat.ts` removes it
  (`PROXY_QUOTA_NOTICE`) and carries it as `turn.notice`. If the proxy's wording changes, expect
  a protocol pause: fix the regex from a captured reply, never by widening the marker grammar.
- The suite is **default-deny on the network**: `test/setup.ts` installs
  `test/helpers/network-guard.ts`, which refuses every outbound `fetch` — **loopback included**,
  because the developer's pplx-proxy lives there — unless the exact origin was registered.
- A test that needs a real HTTP server: **bind first, then** `allowOrigin("http://127.0.0.1:<port>")`,
  and unregister it during cleanup. Never widen the list to a host class, a range, or a suffix.
  Redirects are re-validated per hop, so an off-list `Location` cannot smuggle a request out.
  Registering the live proxy origin (or one inherited from `PPLX_PROXY_URL`) throws: that takes
  the operator's `PI_SUPERVISOR_ALLOW_LIVE_PROXY=1`, never a line of test code.
- Prefer an injected fake transport (the relay and both backends take a `fetch`) over a socket.
- The guard intercepts `fetch` only — not `node:http` clients, raw sockets, WebSockets, or child
  processes. Call it what it is; it is not a network sandbox. When you add a guard, test the guard.

## Facts over guesses

- Discover APIs. The supported peer, `node_modules`, and the tested host are all
  **pi 1.5.0** — the code is written directly to that version's types, not to an
  intersection. Check the installed host's types before using an event or method, and keep
  any fallback for older hosts behind its existing tests (the `agent_end` review path,
  the settle subscription seam).
- Discover MCP tools and schemas at runtime (`/supervise mcp tools`). Never invent a tool
  name, argument, or response field, and never silently guess when a server is ambiguous —
  refuse and tell the user which command resolves it.
- Discover how the proxy continues a conversation before designing around it. On pplx-proxy,
  `POST /v1/responses` with the same `conversation` id is the stateful path (the proxy replays
  its stored history and continues Perplexity's own session, so only the new message is sent);
  the MCP tools and `perplexity_ask`/`perplexity_reason` are stateless one-shot query tools.
  Check `~/ai/pplx-proxy/server.py` or the container's log rather than the OpenAI spec.
- Quote real command output in docs, comments, and reports. If you did not run it, say so or
  leave it out.

## Trust boundaries

- Credentials stay out of everything: repo files, `.pi/supervisor-config.json`, session
  entries, logs, status output, and the report sent to a remote supervisor. Headers come from
  `mcp.json` with `${ENV_VAR}` expansion at request time and are never printed — report a
  missing variable by name only.
- Anything outbound is bounded and redacted. Anything the supervisor answers back is redacted
  **after** parsing (parsing the redacted copy corrupts valid replies) and before injection,
  because it lands in the session transcript.
- Permission gates stay closed: the model may start supervision but never modify or stop an
  active session, and a project on the MCP backend refuses a model-initiated second
  supervisor. Do not loosen these to make a demo work.
- The relay sends **the worker's own final response text** to the chat, verbatim, as the next
  user message — no header, no appended tool errors, nothing else. That is the product, so the
  size ceiling and the explicit truncation marker are the only brakes; document that rather than
  softening it. The proxy token
  is read from the named environment variable at request time and appears nowhere else.
- A limit is never a success. Exhausted iterations, elapsed time, stagnation, `blocked`, and
  a `done` without per-criterion evidence all pause or ask for proof. Only evidence-backed
  `done` completes a goal.

## Lifecycle invariants (break one and you will lose hours)

- Review once per worker run, at `agent_settled`; `agent_end` is a fallback that only reviews
  when the host reports idle with nothing queued.
- One supervisor request in flight at a time; one injection per accepted decision.
- Stop, pause, and session switch drop in-flight work. A late reply is discarded, never
  injected. A restored session resumes **paused**.
- A supervised relay run needs a **live interactive session**. Host print mode (`-p`) processes positional prompts sequentially and exits — disposing the session — right after the last one, while the worker dispatch outlives the prompt's turn; it cannot host a `/supervise` run (the 2026-11-08 01:27Z launch failed this way — see `DEVELOPMENT-LOG.md`).
- The relay has a **hard transport budget**: at most `1 + maxIterations` attempts against
  `/v1/responses` per run. The counter is checked and spent immediately before every send, so
  failures, timeouts, and retries count; redirects are refused locally; and the counter is
  persisted in the run state (`relayAttempts`), so pause/resume never replenishes it.

## Documentation and continuity

Maintain HANDOFF.md as a current-state snapshot, editing sections in place. Append historical
records to DEVELOPMENT-LOG.md, not HANDOFF.md. At each handoff, reconcile the snapshot with the
actual repository and verification state. Never treat either document as proof that a test
passed.

Responsibilities:

- `AGENTS.md` — stable repository rules and development conventions, including these
  documentation-maintenance rules. No session history, no transient progress.
- `HANDOFF.md` — current goal and acceptance criteria; branch and relevant working-tree
  state; current implementation and supported dependency/host versions; latest verification
  results, with live versus offline clearly separated; current blockers and remaining work;
  current authorization and remaining live-request budget; the next concrete action; links to
  relevant historical records. Update or replace existing sections in place; remove
  superseded statements rather than appending corrections beneath them. Keep it concise.
- `DEVELOPMENT-LOG.md` — append-only historical record of milestones, incidents,
  investigations, decisions, verification runs, and superseded handoff updates, in dated
  sections. Preserve the distinction between observations, hypotheses, and conclusions.
  Record corrections explicitly; do not silently rewrite historical claims into facts that
  were not known at the time. No credentials, no private reasoning.

When you reach a milestone, hit a blocker, or are about to stop: append the record to
`DEVELOPMENT-LOG.md` (what you ran and what it printed, what you did not verify), and
reconcile the `HANDOFF.md` snapshot with the actual repository and verification state. No
credentials, no aspirational results.
