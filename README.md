# pi-supervisor

A [pi](https://pi.dev) extension that supervises the coding agent and steers it toward a defined outcome. It observes every conversation turn, injects guiding messages when the agent drifts, and signals when the goal is reached — like a tech lead watching over a dev's shoulder.

> A supervisor as the intelligent overseer keeping the agent on track.

> **Status:** Early release.

<img height="298" alt="image" src="https://github.com/tintinweb/pi-supervisor/raw/master/media/screenshot.png" />



https://github.com/user-attachments/assets/f3b23662-6473-4ac3-82f7-c7f9b64fa7c7

## How It Works

```
/supervise Implement a secure JWT auth system with refresh tokens and full test coverage
```

Then start the conversation normally — the supervisor watches from outside without modifying the agent's context.

1. **After each run** — a separate supervisor LLM analyzes the conversation against the goal (all sensitivities)
2. **Mid-run, between tool calls** — also checks for drift on `medium` and `high` sensitivity and can steer the agent without waiting for it to finish
3. **On completion** — supervisor signals done and stops automatically

The supervisor is a pure outside observer: with the `model` backend it runs as a separate
in-memory pi session that shares only the API credentials, and it never touches the main
agent's context window or system prompt.

Two settings decide how it behaves: **sensitivity** (how eagerly it intervenes) and
**backend** (who decides). The `model` backend asks a supervisor LLM in this process, over pi's
model API. The `mcp` backend runs a **conversation with Perplexity** through
[pplx-proxy](https://github.com/opensec-git/pplx-proxy): each reply from Perplexity is forwarded
verbatim to the worker, and the worker's own answer is sent back into the same conversation — see
[Perplexity chat relay](#perplexity-chat-relay).

## Install

```bash
pi install npm:pi-supervisor
```

Or load a checkout directly, without installing a second copy:

```bash
git clone https://github.com/tintinweb/pi-supervisor
cd pi-supervisor
npm install          # runtime deps, incl. @modelcontextprotocol/sdk

pi -e ./src/index.ts                     # this checkout only, this invocation
pi install .                             # or register this directory as a package
pi -e /path/to/pi-supervisor/src/index.ts
```

`-e` takes a file, so the path must point at `src/index.ts`; `pi install` takes the directory
and reads the `pi.extensions` entry from `package.json`. Both use the dependencies installed in
that directory, so `npm install` is not optional — the MCP discovery path imports the official
`@modelcontextprotocol/sdk` at runtime.

**Supported host:** Pi **1.5.0**. The peer dependencies are pinned exactly to
`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui`
version `1.5.0`; the extension is type- and test-verified against that version and was
smoke-tested on a pi-bolt 1.5.0 host (offline, fake endpoints). Older hosts are not a
supported target.

## Commands

| Command | Description |
|---|---|
| `/supervise <outcome>` | Start supervising toward a desired outcome |
| `/supervise` or `/supervise settings` | Open the interactive settings panel |
| `/supervise stop` | Stop active supervision |
| `/supervise status` | Print backend, goal, phase, iteration, acceptance criteria, last decision |
| `/supervise widget` | Toggle the status widget on/off |
| `/supervise resume` | Hand control back to the supervisor after a pause |
| `/supervise backend` or `/supervise backend model\|mcp` | Show or switch the supervisor backend (`model`, or `mcp` for the Perplexity chat relay) |
| `/supervise mcp …` | Configure the chat relay and its limits (see [Perplexity chat relay](#perplexity-chat-relay)) |
| `/supervise model` | Open the interactive model picker (model backend) |
| `/supervise model <provider/modelId>` | Set supervisor model directly (model backend) |
| `/supervise sensitivity <low\|medium\|high>` | Adjust steering aggressiveness (model backend) |

### Examples

```
/supervise Refactor the auth module to use dependency injection and add 90% test coverage

/supervise model
# Opens pi's model selector — pick any model with a configured API key

/supervise sensitivity low
# Only steer when seriously off track

/supervise stop
```

The agent can also initiate supervision itself by calling the `start_supervision` tool — useful when it recognises a task needs goal tracking. Once active, supervision is locked: only the user can change or stop it.

## UI

### Settings Panel

Run `/supervise` (no args) or `/supervise settings` to open the interactive settings panel:

- **Model** — shows current model; press Enter to browse all available models
- **Sensitivity** — cycle through `low`/`medium`/`high` with Enter or Space
- **Widget** — toggle visibility
- **Outcome** (when active) — shows goal, steer count, and turn count
- **Stop** (when active) — stop supervision directly from the panel
- **Supervisor** — choose the backend: `model` (a supervisor LLM in this process) or `mcp` (a Perplexity conversation through pplx-proxy decides), persisted per project
- **MCP Backend…** (when `mcp` is selected) — open the connection page: proxy endpoint, model, credential variable, turn and time limits

Navigate with arrow keys, Escape to close. Changes are applied on close.

### Live Widget

**Footer** (always visible while supervising):
```
🎯
```

**Widget** (one line, updated live):
```
◉ Supervising · Goal: "Refactor auth module…" · claude-haiku · ↗ 2 · ⟳ turn 4
  The agent has added the DI container but hasn't updated the existing call sites yet…
```

The second line shows the supervisor's reasoning as it streams. Toggle the widget with `/supervise widget`.

## Sensitivity Levels

| Level | When it checks | Confidence threshold | Steering style |
|---|---|---|---|
| `low` | End of each run only | — | Only if seriously off track |
| `medium` (default) | End of run + every 3rd tool cycle mid-run | ≥ 0.90 | On clear drift |
| `high` | End of run + every tool cycle mid-run | ≥ 0.85 | Proactively |

**End-of-run** (`agent_end`): fires once per user prompt after the agent finishes and goes idle. The supervisor must decide `done`, `steer`, or `continue`.

**Mid-run** (`turn_end`): fires after each LLM tool-call cycle while the agent is still working. Steering is injected immediately (interrupting the current run) only when confidence exceeds the threshold. The agent has at least 2 sub-turns to settle before mid-run checks begin.

## Supervisor Model

The supervisor runs on a **separate model** — it can be a cheaper/faster model than the one doing the actual work.

**Resolution order:**
1. Previous session state (persists within a session)
2. `.pi/supervisor-config.json` in the project root (saved by `/supervise model`)
3. Active chat model (`ctx.model`) — so it works out of the box with no configuration
4. Built-in default: `anthropic/claude-haiku-4-5-20251001`

Change at any time with `/supervise model` (interactive picker) or `/supervise model <provider/id>` (direct). The selection is saved to `.pi/supervisor-config.json` if the `.pi/` directory exists.

## Focus and Goal Discipline

The supervisor is a pure outside observer — it does not modify the agent's system prompt. Goal discipline is enforced entirely through steering messages when the agent drifts. If the agent asks an out-of-scope clarifying question, the supervisor redirects it back to the goal rather than answering.

## Stagnation Detection

If the supervisor sends **5 consecutive steering messages** without declaring the goal done, it switches to a lenient evaluation mode: if the goal is ≥80% achieved, it declares done rather than looping forever on minor improvements. The threshold is configurable via `MAX_IDLE_STEERS` in `src/index.ts`.

## Customizing the Supervisor: SUPERVISOR.md

The supervisor's reasoning is controlled by its **system prompt** — not the goal. The goal is always set at runtime via `/supervise <outcome>`. `SUPERVISOR.md` defines *how* the supervisor thinks: its rules, persona, and project-specific constraints.

**Discovery order** (mirrors pi's `SYSTEM.md` convention):

| Priority | Location | Use for |
|---|---|---|
| 1 | `.pi/SUPERVISOR.md` | Project-specific rules |
| 2 | `~/.pi/agent/SUPERVISOR.md` | Global personal rules |
| 3 | Built-in template | Fallback |

The active source is shown when you run `/supervise <outcome>` or `/supervise status`.

### Built-in system prompt

The default prompt the supervisor uses when no `SUPERVISOR.md` is found:

```
You are a supervisor monitoring a coding AI assistant conversation.
Your job: ensure the assistant fully achieves a specific outcome without needing the human to intervene.

═══ WHEN THE AGENT IS IDLE (finished its turn, waiting for user input) ═══
This is your most important moment. The agent has stopped and is waiting.
You MUST choose "done" or "steer". Never return "continue" when the agent is idle.

- "done"  → only when the outcome is completely and verifiably achieved.
- "steer" → everything else: incomplete work, partial progress, open questions, waiting for confirmation.

If the agent asked a clarifying question or needs a decision:
  FIRST check: is this question necessary to achieve the goal?
  - YES (directly blocks goal progress): answer with a sensible default and tell agent to proceed.
  - NO (out of scope, nice-to-have, unrelated feature): do NOT answer it. Redirect:
    "That's outside the scope of the goal. Focus on: [restate the specific missing piece]."
  DO NOT answer: passwords, credentials, secrets, anything requiring real user knowledge.

Your steer message speaks AS the user. Make it clear, direct, and actionable (1–3 sentences).
Do not ask the agent to verify its own work — tell it what to do next.

═══ WHEN THE AGENT IS ACTIVELY WORKING (mid-turn) ═══
Only intervene if it is clearly heading in the wrong direction.
Trust the agent to complete what it has started. Avoid interrupting productive work.

═══ STEERING RULES ═══
- Be specific: reference the outcome, missing pieces, or the question being answered.
- Never repeat a steering message that had no effect — escalate or change approach.
- A good steer answers the agent's question OR redirects to the missing piece of the outcome.
- If the agent is taking shortcuts to satisfy the goal without properly achieving it, always steer and remind it not to take shortcuts.

"done" CRITERIA: The core outcome is complete and functional. Minor polish, style tweaks, or
optional improvements do NOT block "done". Prefer stopping when the goal is substantially
achieved rather than looping forever chasing perfection.

Respond ONLY with valid JSON — no prose, no markdown fences.
Response schema (strict JSON):
{
  "action": "continue" | "steer" | "done",
  "message": "...",     // Required when action === "steer"
  "reasoning": "...",   // Brief internal reasoning
  "confidence": 0.85    // Float 0-1
}
```

### Writing a custom SUPERVISOR.md

You must preserve the JSON response schema. Everything else is up to you.

```markdown
You are a supervisor for a TypeScript project. Your priorities: type safety and test coverage.

Rules:
- Steer if the agent uses `any` types or skips tests for new code
- When steering, be direct: one sentence max, reference the specific file/function if possible
- "done" only when the new code has types and tests — not before
- Do not steer about code style, naming, or documentation

Response schema (strict JSON, required):
{
  "action": "continue" | "steer" | "done",
  "message": "...",
  "reasoning": "...",
  "confidence": 0.85
}
```

## Perplexity chat relay

The supervisor can be Perplexity itself, with the local worker as its hands. One conversation
is opened per goal: each reply from Perplexity becomes the worker's next instruction, and what
the worker actually said goes back into the same conversation. There is no JSON in this path —
prose in, prose out — and the only thing read from a reply is its final line.

```
you   /supervise make the flaky test deterministic
          │  conversation opened: the goal + how the relay works
      ←   "Write a failing test that reproduces the race, then stop."
          │  forwarded to the worker verbatim → the worker runs
      →   "Local coding agent result:\n<the agent's own final response>"
      ←   "Now fix the race in readState() and run the suite twice."
          │  forwarded → the worker runs
      →   "Local coding agent result:\n57 passed, twice."
      ←   "The evidence is in the transcript. Goal met.
           [[PPLX_DONE]]"                                  → the run stops here
```

### Why a conversation, and why not the MCP tools

pplx-proxy exposes two different things. Its MCP endpoint (declared inline in `server.py`,
tools at 2866–2960) offers `perplexity_search`,
`perplexity_ask`, `perplexity_reason`, `perplexity_research`, `perplexity_models` — each takes
one query, returns a string, and forgets it; **as declared, none continues a
conversation** — the capability is unused rather than absent, see below. Its
OpenAI-compatible Responses endpoint (`POST /v1/responses`) is the one that keeps state: send
the same `conversation` id and the proxy replays that conversation's history and continues
Perplexity's own session, so only the new message crosses the wire. The relay uses the
Responses API, and MCP is still used to discover the server (`/supervise mcp tools`).

The MCP tools are not incapable in principle — they are not wired to the state that exists.
Each one calls `client.search(query, …)` without the sixth argument, so `last_backend_uuid`
goes upstream as `null` (`server.py:726`), and none of them reads the `backend_uuid` that
arrives in the same stream. A third option — an MCP tool that takes a conversation id and
reuses the proxy's existing `_conversations_index` / `_responses_store` — is feasible without
a separate process, since the MCP app is mounted inside the same FastAPI app
(`app.mount("/mcp", mcp_http_app)`, `server.py:3037`). Until that exists, a "chat" over the
current MCP tools would mean this extension resending the whole history on every call, which
is a stateless call wearing a chat's clothes.

### Select it

```bash
/supervise backend mcp     # the pplx-proxy relay. backend model returns to the built-in evaluator
```

The backend choice is stored in `.pi/supervisor-config.json`, so a project can pin it. The
worker keeps whatever model the session uses; the supervisor side costs Perplexity quota and
nothing else — no API key for the supervisor, no model picker.

### Start a run

```bash
/supervise <outcome>       # opens the conversation, sends the goal, starts the worker
/supervise status          # phase, turns, conversation, last activity, pause reason
/supervise stop            # end it; the worker is left alone
/supervise resume          # continue a paused run in the same conversation
```

A new goal always opens a **new** conversation. `resume` continues the saved one and does not
resend the setup message. A restored session comes back **paused**.

### The two markers

Perplexity ends a run by writing one marker on its own final line:

| Marker | What happens |
| --- | --- |
| `[[PPLX_DONE]]` | the reply above it is shown as the summary; the run ends; nothing is dispatched |
| `[[PPLX_BLOCKED]]` | the reply is shown as the reason; the loop pauses for you; nothing is dispatched |

Both forms are honoured, because both occur:

```
… the evidence is in the transcript. Goal met.
[[PPLX_DONE]]                          marker alone on the final line

… keep going until the suite is green. [[PPLX_DONE]]   marker appended to the prose
```

Only the marker itself is removed from what you are shown; the prose around it is kept
character for character, indentation included.

Anything else is a protocol error and **pauses the run**: a marker mid-reply, one inside a
code fence, one with prose after it, or one followed by text the proxy did not append. The
reply is not forwarded to the worker, and no second request is made to tidy up the
supervisor's formatting — guessing whether `… [[PPLX_BLOCKED]]` mid-sentence was a verdict
or an example is how a blocked run gets sent back to work. An empty or failed reply pauses
the same way, visibly, instead of injecting nothing.

A worker run that ends before it answers — interrupted, or stopped by an API error, or with
no final response at all — also pauses the run, and **nothing is sent to Perplexity**. A run
that completed while reporting failures is the opposite case: that is a result, and it
travels on. When you want the interruption explained to the supervisor, `/supervise resume`
says so deliberately.

### The setup message (`.pi/SUPERVISOR.RELAY.md`)

The first message of every conversation — the one that explains the relay — is configurable
without touching the code. Put it in `.pi/SUPERVISOR.RELAY.md` (project) or
`~/.pi/agent/SUPERVISOR.RELAY.md` (global), or point `/supervise mcp intro <path>` somewhere
else. It is sent once per conversation. Use `{{GOAL}}` where the goal should appear; without
it, the goal is appended as `Goal:\n<your goal>`.

The built-in template establishes: replies are forwarded verbatim, results come back to
Perplexity, answers are ordinary prose with one concrete next instruction, finished stages are
not restarted, repeated instructions are changed rather than repeated, the agent has its own
tools and permission checks, that nothing Perplexity says grants it new permission or approves a prompt on the user's behalf, that evidence is demanded before anything is accepted, and that the two
markers end the run.

### Configure the connection

```bash
/supervise mcp status                 # endpoint, provenance, model, limits, conversation
/supervise mcp base-url http://127.0.0.1:8892
/supervise mcp model auto             # the proxy's model alias, e.g. auto, sonnet, gpt
/supervise mcp api-key-env PPLX_PROXY_API_KEY   # the NAME of the env var; never the value
/supervise mcp intro .pi/relay.md
/supervise mcp worker-chars 24000     # how much of the agent's response travels per turn
/supervise mcp iterations 12          # chat turns per run
/supervise mcp minutes 45             # wall-clock budget
/supervise mcp timeout 120000 · retries 2
```

The endpoint is discovered, in this order — and `/supervise mcp status` says which one won:

1. `relayBaseUrl` (`/supervise mcp base-url`)
2. `PPLX_PROXY_URL` in the environment
3. the origin of the MCP server already configured in pi's `mcp.json` — the same proxy process
4. `http://127.0.0.1:8892`, pplx-proxy's usual port

If a setting cannot be used (an unparseable base URL, a missing intro file), `/supervise <goal>`
refuses to start and names the command that fixes it, instead of failing on the first turn.

### Status, in the real terminal

```
Supervisor: idle · backend pplx-proxy chat relay (127.0.0.1:8892 · model auto · auth PPLX_PROXY_API_KEY unset · max 12 turns · 120s timeout)
Nothing is being supervised in this session — /supervise <goal> to start.
```

While a run is active the same command answers with the phase (`awaiting Perplexity…`, `worker
running…`, `paused — <reason>`, `complete`), the turn and time budget, whether the conversation
is still attached (`attached`, or `NOT attached, the proxy started a fresh turn` if the proxy's
stored context expired), and the most recent activity or error. The readout is built inside a
guard: a broken setting is reported, but it can never make the command print nothing.

### What leaves the machine

Only the text of a turn: the goal and setup on the first turn, then
`Local coding agent result:` followed by the worker's own final response — its actual words, not
a summary. Notes from the extension (an interrupted run, a tool that failed and was not
mentioned) are appended below, labelled as not the agent's words, and only when the reply does
not already say it. Long output is cut in the middle with an explicit
`[[TRUNCATED: n of m characters omitted…]]` marker so nothing silently disappears. Everything
outbound passes through `redactSecrets`, and the proxy token is read from the named environment
variable at request time — never stored, never printed.

### Iteration and time limits

`iterations` and `minutes` are ceilings, not verdicts: reaching one pauses the run and tells
you so. The same applies to repeating the same instruction twice, an interrupted worker run, or
a reply that never arrives. Only `[[PPLX_DONE]]` completes a goal.

### Hard request budget

Beyond the iteration and time ceilings, the transport itself is capped: a run may make at
most **`1 + iterations`** attempts against `/v1/responses` — one initial request plus one
review per worker run. The counter is checked and spent immediately before every send, so
**failures, timeouts, and retries all count**; the fourth-and-later attempt fails locally
without touching the network. Redirects are refused (`redirect: "error"`), and because the
counter lives in the run's persisted state, pausing or resuming **never replenishes** the
budget. `/supervise status` shows the spend as `attempts n/m`.

## Tests are offline by construction

`test/setup.ts` installs a default-deny guard over `globalThis.fetch`
(`test/helpers/network-guard.ts`). Nothing leaves the process — **loopback included**, because
the developer's own pplx-proxy is `http://127.0.0.1:8892`, and an allow-list for loopback is an
allow-list for the one endpoint a test must never reach.

A suite that needs a real HTTP server binds one, registers the exact allocated origin, and
unregisters it during cleanup:

```ts
await new Promise((r) => server.listen(0, "127.0.0.1", r));   // 1. bind: the port now exists
const unregister = allowOrigin(`http://127.0.0.1:${port}`);   // 2. that origin only
// ... the test ...
unregister();                                                 // 3. cleanup
```

Redirects are followed by the guard (the real client is called with `redirect: "manual"`), so
every hop is checked again: a `Location` aimed at an origin nobody registered is a refusal, and
that origin is never contacted. `localhost` is not an alias for `127.0.0.1`, and neither is an
alias for `[::1]` — a registered port does not open the other spellings. Registering the live
proxy origin, or the origin named by an inherited `PPLX_PROXY_URL`, throws: inherited settings
and credentials are data, and only an operator-level `PI_SUPERVISOR_ALLOW_LIVE_PROXY=1` opens it.
The live suite needs that **and** `PI_SUPERVISOR_LIVE_MCP=1`.

What this intercepts is `fetch` — which is what the relay uses (`src/relay/chat.ts` resolves the
global per call) and what the MCP client uses (`@modelcontextprotocol/sdk` builds its transport
fetch as `createFetchWithInit(baseFetch = fetch, …)`). What it does **not** cover: `node:http` /
`node:https` client calls, raw `net` / `tls` / `dgram` sockets, WebSockets, child processes such
as `curl`, or anything out-of-process. It is a strong check on the two routes this extension
takes, not a network sandbox. Most tests need no socket at all: the relay and both backends take
an injected `fetch`, which is the preferred pattern.

## Session Persistence

Supervision state (outcome, model, sensitivity, intervention history) is stored in the pi session file and restored automatically on restart, session switch, fork, and tree navigation.

## Project Structure

```
src/
  index.ts              # Extension entry point, event wiring, /supervise command, start_supervision tool
  types.ts              # SupervisorState, SteeringDecision, backend ids, phases, completion criteria
  state.ts              # SupervisorStateManager — in-memory state + session persistence
  engine.ts             # Snapshot building, SUPERVISOR.md loading, prompt construction, analyze()
  model-client.ts       # One-shot supervisor LLM calls via pi's AgentSession API
  loop.ts               # Supervision loop — one review per run, one injection per decision
  host.ts               # Host capability shims (agent_settled subscription, idle/queue probe)
  decision.ts           # Decision extraction, normalisation, strict validation, repair prompt
  report.ts             # Bounded, redacted activity report for one worker iteration
  redact.ts             # Secret detection and redaction, applied to everything outbound
  workspace-config.ts   # .pi/supervisor-config.json — backend, model, and mcp settings
  backends/
    types.ts            # SupervisorBackend contract, SupervisorRequest/Outcome, failure kinds
    model-backend.ts    # Backend over pi's own model API (mid-run and end-of-run review)
    relay-backend.ts    # Perplexity chat relay — one conversation, prose in, prose out
    mcp-backend.ts      # Structured-JSON backend over an MCP server (kept for discovery/config)
  mcp/
    config.ts           # Endpoint, headers from mcp.json (${ENV_VAR}), clamped settings
    client.ts           # Official MCP SDK over Streamable HTTP; timeouts, retries, redaction
    schema.ts           # Tool and argument selection from the discovered schema
    prompt.ts           # .pi/SUPERVISOR.MCP.md, request assembly, repair prompt
  relay/
    protocol.ts         # Intro template, worker-result message, [[PPLX_DONE]] / [[PPLX_BLOCKED]]
    chat.ts             # Persistent conversation over pplx-proxy's /v1/responses
    config.ts           # Where the proxy is, and what is wrong with the settings
  ui/
    status-widget.ts    # 🎯 footer badge + one-line widget with live thinking stream
    model-picker.ts     # Interactive model picker using pi's ModelSelectorComponent
    settings-panel.ts   # Interactive settings overlay using pi-tui's SettingsList
    mcp-panel.ts        # Interactive MCP settings page, with live tool discovery
test/                   # vitest — offline by default; test:live is opt-in
```

## License

MIT — [tintinweb](https://github.com/tintinweb)
