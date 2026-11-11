# Development log

Append-only historical record of pi-supervisor: milestones, incidents, investigations,
decisions, verification runs, and superseded handoff updates. Dated sections. Entries
preserve the distinction between **observation**, **hypothesis**, and **conclusion**.
Corrections are recorded explicitly — earlier entries are never silently rewritten into
facts that were not known at the time. No credentials, no private reasoning.

`HANDOFF.md` is the current-state snapshot; `AGENTS.md` holds the stable rules, including the
documentation-maintenance rules. Neither document is proof that a test passed — the checks
must be run.

---

## Working tree and environment

### 2026-11-08 00:08 — environment incident: `node_modules` reinstalled mid-session

**Observation.** `node_modules` was reinstalled mid-session (`node_modules/.package-lock.json`
mtime 00:08:33), bumping `@earendil-works/pi-coding-agent` from **0.78.0** (the pin in the
HEAD lockfile, against which this tree last typechecked and against which the 21:30Z live
run executed) to **1.5.0**, and re-resolving 93 shared transitive keys. The uncommitted
`src/model-client.ts`, `src/ui/model-picker.ts`, and `src/ui/settings-panel.ts` (modified
16:52–18:22, before the incident) no longer typechecked against the 1.5.0 host types
(`modelRegistry` on `CreateAgentSessionOptions`; `SettingsManager` vs `ModelRuntime`).

**Response (scoped restore, no unrelated file touched, no blind reset).** The incident
lockfile was backed up to `/tmp/package-lock.1.5.0.incident.json`; `git checkout HEAD --
package-lock.json` restored the last-verified lockfile; `npm install` reconciled it — the
only gap was `@modelcontextprotocol/sdk`, which resolved to **1.32.2**, exactly the version
already in `node_modules` and in the incident lockfile. Result: `node_modules` =
pi-coding-agent **0.78.0** + sdk **1.32.2**; the lockfile diff vs HEAD was the sdk subtree
plus six pi-nested entries hoisted, **zero shared-key version changes**; the 93 re-resolved
keys were back at their verified versions.

**Status: superseded** by the 1.5.0 migration below — the rollback was a stopgap, not the
supported environment (operator decision, 2026-11-08).

### 2026-11-08 00:30–00:50Z — migration to Pi 1.5.0

Operator instruction: migrate the extension to Pi 1.5.0 before any live test; the 00:08
rollback above was a stopgap, not the supported environment. `peerDependencies` became
exactly `1.5.0` for `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and
`@earendil-works/pi-tui`; `npm install` resolved all three plus `pi-agent-core 1.5.0` and
`typebox 1.3.27` (the latter by caret resolution of the existing `^1.1.24` — no unrelated
package was forced). Pre-bump lockfile: `/tmp/package-lock.pre-bump.json`. Lockfile delta vs
HEAD: 51 of 181 shared keys changed; 114 added / 145 removed keys (the 0.78.0 tree replaced
by the 1.5.0 tree) — all under `@earendil-works/*` and their transitives. `npm ls` showed no
stale 0.78.x anywhere.

The compatibility audit against the exact 1.5.0 published types (pi-coding-agent, pi-tui,
pi-ai, and pi-agent-core 1.5.0 tarballs, cross-checked against the installed pi-bolt 1.5.0
build) found exactly the five errors below — no other shape mismatch in any host surface
the extension touches (commands, tools, events, session entries, UI components, model
runtime). One runtime assumption was wrong and is fixed: 1.5.0's `AgentSettledEvent` is
`{ type, aborted }`, not `{ type, reason? }` — the settle handler and the relay e2e test
events were corrected. `agent_settled` is a first-class extension event in 1.5.0, so
`src/host.ts` is now a plain typed subscription (the `agent_end` fallback in `src/loop.ts`
is unchanged and still test-covered); the unused `canObserveQueue` probe was removed — both
methods it probed are required members in 1.5.0.

The five errors, reproduced verbatim after the bump, then fixed with supported APIs:
1. `src/model-client.ts(51,7) TS2353` — `modelRegistry` is gone from
   `CreateAgentSessionOptions` → pass `agentDir: getAgentDir()`; the session builds its
   own `ModelRuntime` from the agent dir's `auth.json` + `models.json` (the host's
   own catalogue, no network refresh).
2. `src/ui/model-picker.ts(33,7) TS2345` and 3. `src/ui/model-picker.ts(36,8) TS7006` —
   `ModelSelectorComponent` takes a `ModelRuntime` instead of
   `settingsManager, modelRegistry`; the custom-UI factory is now async and awaits
   `ModelRuntime.create()`.
4. `src/ui/settings-panel.ts(62,9) TS2345` and 5. `src/ui/settings-panel.ts(65,10)
   TS7006` — the same constructor change; one shared runtime per panel, created at the top
   of the (now async) factory.
No `any`, no `ts-ignore`, no broad casts; `SettingsManager` is no longer imported anywhere.

**Conclusion (versions, stated precisely).** The dependency the extension compiles and
imports (`node_modules/@earendil-works/pi-coding-agent`) is **1.5.0**; the actual Pi host
that runs supervised sessions is the **pi-bolt 1.5.0 build** (deployed 2026-11-07 15:51) —
the `pi` npm binary (`1.3.0`) is a different, unused host. The extension and the host agree
on 1.5.0 on both sides. `.supervisor-smoke/` (untracked scratch, `node:test` style) is
excluded by `vitest.config.ts` rather than deleted — not this session's file to erase, and
it was breaking `npm test`.

## 2026-11-07 21:30Z live run — four root causes, each reproduced

The 2026-11-07 21:30 UTC run in this workspace (pi session
`01a1b7eb-7423-74fc-9721-fce9c4e1d1d9`; entries 3, 12, 13, 20) is preserved as
`test/fixtures/relay-transcript.ts`, generated from the session file rather than retyped.

**1. A status request became a goal, and spent quota.** Three separate layers, only one of
them mine:

- *TUI automation (mine, and the trigger).* The operator's agent drove pi through `script`
  and typed `printf '/supervise status\r'` as one burst. The pty delivered it as a **single
  input chunk**, and `pi-tui/dist/components/editor.js:587-616` matches key bindings per
  chunk: a multi-byte chunk containing `\r` matches neither the newline branch nor
  `tui.input.submit`, so the whole chunk went into the buffer as text and never submitted. A
  later lone Enter then submitted a two-line buffer. **No product defect is needed to
  explain this — but the product must not be breakable by it.**
- *Dispatch (pi, working as designed).* `agent-session.js:_tryExecuteExtensionCommand`
  splits at the **first space** and passes the remainder verbatim, newlines included:
  `/supervise status\n/supervise status` → command `supervise`, args
  `"status\n/supervise status"`.
- *Goal construction (mine, the actual defect).* Every subcommand in the handler was matched
  by exact equality (`trimmed === "status"`), and anything else fell through to
  `state.start(trimmed, …)`. A status request with something attached to it started a
  supervision goal, opened a conversation, and dispatched a worker run.

Fix: `src/command-intent.ts` → `nonGoalReason()`, applied before any subcommand or goal
handling. It rejects an argument that carries a slash command, or whose first line is
exactly a control word with more lines after it. It deliberately does **not** reject a real
goal that merely starts with such a word ("status reporting must retry…"). `statusLines()`
was already read-only; it is now asserted to be, in all four phases.

**2. `[[PPLX_BLOCKED]]` was dispatched as an instruction.** Both of Perplexity's replies
were:

```
… their relevant output if they establish progress. [[PPLX_BLOCKED]]

[Remaining Pro Search: 45]
```

`detectRelayMarkers()` only accepted the marker **alone on the last non-empty line**. Two
facts made that unreachable: the marker was appended to the end of the prose, and
pplx-proxy appends a quota notice after the answer — `f"\n\n[Remaining Pro Search: {rp}]"`
(`server.py:201`, attached by `_response_suffix`, `server.py:427/1682`), which the proxy
itself strips again when rebuilding history (`_REMAINING_NOTICE_RE`, `server.py:1208`). So
the terminal line was the notice, the marker was invisible as a verdict, and the whole text
— marker included — became the worker's instruction.

Fix, two layers, both narrow:
- `relay/chat.ts` — `PROXY_QUOTA_NOTICE` removes the proxy's own notice from the reply and
  keeps it as `turn.notice` (also shown in the turn detail). Mirrors what the proxy does to
  its own history. If the wording changes, the relay degrades to a protocol pause, not to a
  wider rule.
- `relay/protocol.ts` — the grammar accepts the two forms that occur (marker alone on the
  final line; marker appended to the end of the final line of prose), removing **only** the
  marker. A reserved marker anywhere else — mid-reply, in a code fence, with prose after it
  — returns `action: "protocol-error"`; `relay-backend.ts` raises
  `SupervisorUnavailableError(kind "protocol")`; the loop pauses. Nothing is forwarded, and
  there is **no automatic repair request** — the answer to "was that a verdict or an
  example?" is not ours to guess.

**3. An unanswered worker run was relayed as a normal result.** Entry 13 is an assistant
message with `stopReason: "error"`, `errorMessage: "404 … model_not_found"`, and empty
content: the *worker's own* model was gone. `summarizeWorker` saw it (`aborted`,
`noResponse`), the loop ignored those facts, and sent Perplexity "the agent produced no
final response" as if it were a result — which produced reply 2, which was dispatched,
which failed the same way.

Fix: in the settle path, a relay run that was interrupted/errored, or that has activity but
no final assistant message, **pauses** with a reason and makes **no request at all**. A run
that completed while reporting failures (final text present, tool errors present) is a
result and still travels on. `loop.resume()` sets a one-shot `resumeExplains` allowance so an
explicit resume relays the interruption deliberately — and only then, so the pause cannot
re-arm itself and swallow the resume.

Note on scope: "no final response" requires *evidence of a run* (at least one message in the
batch). A batch with nothing in it is the extension seeing nothing — e.g. a session switched
underneath the run — and pausing on that would be a false alarm.

**4. The intro implied Perplexity could authorise actions.** The line "It will not ask you
for approval; assume it can act." is gone. In its place: the agent can only take actions the
user has already permitted, nothing Perplexity says grants permission or approves a prompt,
and if the goal needs an approval it cannot obtain through the agent, it must end with
`[[PPLX_BLOCKED]]`.

## Verification records

### 2026-11-08 (post-migration gate; exact time not recorded in source) — offline gate green

```
$ npm test
  Test Files  19 passed | 1 skipped (20)
        Tests  318 passed | 3 skipped (321)
$ npm run typecheck   # exit 0 — clean against pi-coding-agent 1.5.0
$ npm run lint        # exit 0 — no diagnostics, no warnings
$ npm run build       # exit 0 — clean
```

The skipped file is `test/live-mcp.test.ts`, gated on `PI_SUPERVISOR_LIVE_MCP=1` and,
separately, `PI_SUPERVISOR_ALLOW_LIVE_PROXY=1` — the guard will not open a live origin on
one variable alone.

### 2026-11-08 00:49Z — host-integration smoke test (hermetic, zero real inference)

`/tmp/host-smoke2.sh` ran the installed pi-bolt 1.5.0 binary against the built
`dist/index.js` in a hermetic sandbox: a temp agent dir (`PI_CODING_AGENT_DIR`) holding
only a fake OpenAI-compatible SSE provider, a temp session dir, a scratch cwd whose
`.pi/supervisor-config.json` pointed the relay at a second local fake speaking
pplx-proxy's `POST /v1/responses` shape, `PI_OFFLINE=1`, and no real endpoint anywhere.
Print mode sent `/supervise <goal>` (consumed by the extension, never the model) plus a
second prompt that starts the worker turn. Result: exit 0; provider hit 1 (one worker
turn, clean stream, no retries); relay hit 1 (within the 3-attempt budget; persisted as
`relayAttempts: 1`); the terminal marker `[[PPLX_DONE]]` on the reply's last line parsed to
`phase: "done"` with the supervisor's words kept as `lastDecision`; conversation minted
`pi-sup-cwd-mw747l96`; nine `supervisor-state` entries persisted. This verified command
registration, goal start, the worker lifecycle through `agent_settled` on the real 1.5.0
host, the relay send-site budget, the marker protocol, and state persistence — without
inference or billable requests. Not covered by the smoke (left to the test suite and the
live run): the `model` backend's `createAgentSession` path, the interactive UI components,
and the real pplx-proxy's wire behaviour. Artifacts: `/tmp/pi-host-smoke/`.

### 2026-11-08 01:27Z — approved live test attempt (launched, failed at launch)

Operator-approved launch per the plan (one new `pi-sup-*` conversation; 3-attempt budget;
2-worker-run ceiling; retries 0; `timeoutMs 180000`; `maxDurationMs 900000`; no discovery
requests). Launch command (scratch cwd; **host print mode**; the second positional prompt
was a leftover from the smoke script):

```
pi -e /home/pseudobacon/ai/pi-supervisor/dist/index.js \
   --model macbook/unsloth/Qwen3.8-Flash-Next-GGUF:UD-IQ3_XXS --no-mcp \
   -p "/supervise Read README.md and the source file in this scratch directory. Create README-SUMMARY.md containing 3–5 sentences describing this fixture project and its documented start command. Do not modify any pre-existing file or create any other task artifact. Verify the summary against those two files and report the checks." \
   "start working"
```

Result: exit 1 (process exit logged 01:27:24Z; relay request created 01:27:22Z, 200 OK
01:27:24.58Z). Captured stderr (verbatim):

```
Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.
Extension error (<boundary>): turn_end could not resolve the persisted assistant entry ID
Extension error (/home/pseudobacon/ai/pi-supervisor/dist/index.js): This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().
```

Transport track: exactly one line in the proxy log since the previous run —
`2026-11-08T01:27:24.581537269Z INFO: 172.19.0.1:48746 - "POST /v1/responses HTTP/1.1" 200
OK` — the intro round-trip. Conversation
`pi-sup-pi-supervisor-live-scrat-mw75k2qt`, response
`resp_0dc4053c226b4cbfbe921ef8e5d1a31c`. Quota track: the reply ended with the proxy's own
notice `[Remaining Pro Search: 35]` (the relay's quota-notice stripping never ran — the
process died before the reply was consumed); the reply text was a 687-character instruction
with no `[[PPLX_*]]` marker. Worker runs: **1 dispatched, aborted at process exit** — the
reply was non-terminal, so the decision path dispatched it; the in-flight worker turn is
what the "Agent is already processing" error hit when print mode issued the second prompt.
No worker output, no session file was ever flushed for the scratch cwd, no scratch file was
created. Because no session file was flushed, **no supervisor state was persisted** —
`/supervise resume` cannot reach this run. (The proxy retains the conversation — response
plus conversation index — but the extension side does not.)

Root cause (**conclusion — harness error, not the product**): the `/supervise` handler in
the mcp backend **awaits** the intro relay round-trip before returning
(`src/index.ts:898-917`), and the host's print mode processes positional prompts strictly
sequentially, then exits and disposes the session after the last one
(`dist/modes/print-mode.js`). The second prompt collided with the in-flight first turn; the
error path disposed/replaced the session (the stale-ctx errors above) and the process
exited. Print mode cannot host a `/supervise` run even with a single prompt: the
supervision flow (worker dispatch → settle → attempt 2) continues past prompt completion as
extension background work, and print mode exits and `disposeRuntime()`s right after the
last prompt. The flow needs a live interactive session.

Post-attempt audit: the strict baseline set is byte-identical (`hello.js`, `README.md`,
`.pi/supervisor-config.json` all OK against `~/pi-supervisor-live-baseline.txt`); no
`README-SUMMARY.md`; no other additions; no git commit (none ever — matching baseline); the
scratch `.git` index stat-cache was refreshed by the audit's own `git status` commands (no
content change). **Side observation outside the test's scope (attribution unresolved):**
`~/.pi/agent/settings.json` was rewritten at 01:27:56 — after the crashed process had
exited (01:27:24); the only diff against the 00:47 state is `"theme": "cc-my-pi-dark"` →
`"theme": "system"` (the removed cc-my-pi package's dangling theme falling back); the only
pi process alive at 01:27:56 was this session's host.

Outcome: the budget stands at **1 of 3 attempts consumed**; the launched run is
unrecoverable through the product. **Operator decision (2026-11-08): stop at 1/3 — no
further live requests.** The live end-to-end relay run remains unverified.

**Correction (recorded 2026-11-08, same session):** an interim report of this attempt said
the reply carried "no quota notice". The full reply text (687 characters, read completely)
ends with `[Remaining Pro Search: 35]` — the interim report had read only the first 500
characters. The relay's notice-stripping never ran because the process died before the
reply was consumed; that part of the interim report was correct.

### 2026-11-08 (same phase as the migration; exact times not recorded in source) — network guard, offline gate, and added tests

**Offline by construction, and the guard is tested.** `test/setup.ts` installs
`test/helpers/network-guard.ts`: a **default-deny** registry over `globalThis.fetch`.
Loopback is *not* allowed — the developer's pplx-proxy **is** `http://127.0.0.1:8892`, so a
loopback allow-list was an allow-list for the one endpoint the suite must never reach. The
list starts empty; a suite that needs a real server binds it first, registers that exact
origin (`http://127.0.0.1:<allocated port>`), and unregisters it during cleanup. Redirects
are followed by the guard (real fetch gets `redirect: "manual"`), re-checking every hop.
`test/network-isolation.test.ts` (12 tests) proves: the list is empty by default;
`POST http://127.0.0.1:8892/v1/responses` is refused **with zero real-transport calls** —
the counter is the evidence that the refusal precedes the transport, and that address is
never contacted; so is `PerplexityChat` pointed at it with an inherited
`PPLX_PROXY_API_KEY` present; one registered port answers while a second, bound-but-
unregistered loopback port stays closed; `localhost` and `[::1]` are not aliases for a
registered origin; a redirect to an unregistered origin is refused and that server's own
hit counter stays at 0, while a redirect whose every hop is registered is followed;
`allowOrigin("http://127.0.0.1:8892")` — and any origin inherited from `PPLX_PROXY_URL` /
`PI_SUPERVISOR_LIVE_URL` — throws unless the operator also sets
`PI_SUPERVISOR_ALLOW_LIVE_PROXY=1`, so inherited URLs and credentials cannot enable live
access. Two removal experiments confirmed the guard is on both real paths and not just on
raw `fetch`: with the registration line commented out, the MCP suite failed with `MCP
connect failed: blocked by default: no test registered http://127.0.0.1:39235` and the
relay suite with `Cannot reach pplx-proxy at http://127.0.0.1:45091/v1/responses: blocked
by default` — proof that `@modelcontextprotocol/sdk` (`shared/transport.js:24`,
`createFetchWithInit(baseFetch = fetch, …)`) and the relay (`src/relay/chat.ts:67`,
`fetchImpl … = fetch`) both resolve the global. The live suite now needs two variables:
`PI_SUPERVISOR_LIVE_MCP=1` **and** `PI_SUPERVISOR_ALLOW_LIVE_PROXY=1`. Independently, the
relay e2e suite resolves its own endpoint after writing its config and throws unless it is
the fake proxy.

**Scope, stated plainly.** The guard intercepts `fetch` only. It does not cover
`node:http` / `node:https` client calls, raw `net` / `tls` / `dgram` sockets, WebSockets,
child processes (`curl`, `git`), or anything out-of-process. It is a strong check on the
two routes this extension actually uses, not a network sandbox; injected fake transports —
which the relay and the model backend both accept as a parameter — remain the preferred
pattern for tests that do not need a socket.

**No live call was made in this phase — except the single approved launch attempt of
2026-11-08 01:27Z, recorded above.** Before that, the last supervisor request was
**21:30:34Z**, the accidental pair from the earlier phase, documented in the quota
incidents below. Audit probes use that filter and not a bare `POST|GET`: the container's
own healthcheck logs about two `GET /health` per minute (89 in that window), which is
neither supervisor traffic nor a quota event — exactly the kind of noise that makes an
audit claim unreliable.

**The live gate fails closed.** `env PI_SUPERVISOR_LIVE_MCP=1 npx vitest run
test/live-mcp.test.ts` — one opt-in instead of two — failed in `beforeAll` with `refusing
to register http://127.0.0.1:8892: … only the operator can, with
PI_SUPERVISOR_ALLOW_LIVE_PROXY=1`; its three tests skipped, and the proxy log stayed
empty. That run is safe by construction: the origin is refused before a client exists, and
any request that somehow got past it would still face the default-deny check.

**Tests added, all from the transcript or the failure mode** (`test/relay-e2e.test.ts`,
`test/relay-protocol.test.ts`, `test/command-intent.test.ts`,
`test/network-isolation.test.ts`):

- the exact multi-line status submission: zero requests, zero injections, "not treated as
  a goal", and the saved goal unchanged;
- both fixture replies end-to-end through the fake proxy: blocked → visible
  `Supervisor is blocked: … /supervise resume once it is resolved`, nothing injected, no
  second request;
- a non-terminal marker: `Supervisor paused (protocol)`, one request only, no repair
  attempt;
- a worker run that errored with no final response: pause, no request; and the same for an
  empty final response — while a completed run reporting `npm test failed: 2 of 57` still
  reaches Perplexity with the agent's own words;
- only `resume` explains the interruption (turn 2's input carries the explanation, and
  nothing before the resume asked);
- a stop mid-turn dispatches nothing late and the following settle opens nothing;
- `status` in idle / running / paused / completed: `expect(attempts()).toBe(baseline + 3)`
  — the three fetches are the relay's three turns, so no status call touched the network.

**Two old tests were changed, because they encoded the old rules** — recorded plainly
rather than pretending the suite always said this:
- "ignores a marker anywhere but at the end — that is a quote, not a verdict" asserted
  `continue`, i.e. *forward it*. That is exactly what dispatched a blocked verdict; it now
  asserts `protocol-error`.
- "does not treat a marker quoted inside the agent's output as completion" used a
  supervisor reply that itself contained a mid-text marker; under the new rule that reply
  is refused. Its first reply is now marker-free, and the test still proves the guarantee it
  named: a marker inside the **worker's** text ends nothing (turn 2 carries it verbatim,
  the run continues).

**Not verified by TUI.** No automated keystrokes were used in this phase, and none should be
aimed at a live proxy: that is how two requests were spent earlier. If TUI proof is needed
again, do it with `PPLX_PROXY_URL=http://127.0.0.1:1` (refused locally) and a `sleep`-paced
input, never a burst.

## MCP continuity investigation — options A/B/C (date not recorded in source; predates the 2026-11-08 live-test preparation)

All citations are `~/ai/pplx-proxy/server.py` unless noted. **Correction recorded in the
source at the time:** there is **no `mcp_server.py`** — an earlier HANDOFF cited one; that
was wrong, and the earlier "the MCP tools cannot do this structurally" framing overstated
the case.

- **The tool that talked to Perplexity successfully** is any of the five MCP tools —
  `perplexity_search` (2866), `perplexity_ask` (2902), `perplexity_reason` (2915),
  `perplexity_research` (2947), `perplexity_models` (2960). Each takes only `str` arguments
  and returns `str`.
- **Continuity is available but unused.** Every one of them calls
  `client.search(query, mode, pref, src, language)` — five positional arguments. The sixth,
  `follow_up_uuid`, defaults to `None`, and that is the only continuity field upstream:
  `"last_backend_uuid": follow_up_uuid` (726). Upstream returns `backend_uuid` in the
  stream; the MCP loops read `error`, `actual_model`, `answer`, `done` and **discard it**
  (no occurrence of `backend_uuid` anywhere in 2865-2975). So MCP calls are stateless *by
  omission*, not by impossibility.
- **Implicit continuity exists, but MCP never touches it.** `_session_lookup` is called
  from exactly one place (`_prepare_pplx_from_messages`, 1587) — the `/v1/responses` and
  `/v1/chat/completions` paths — keyed on `sha256(json.dumps(history))[:16]` (`_session_key`,
  314-318), stored after the turn by `_session_store` (333; callers 1679, 2575, 2683),
  TTL 3600s. No MCP tool calls either function, so MCP can neither influence nor read that
  key.
- **Are conversation ids discarded by the MCP wrapper?** Not discarded — never present. No
  MCP signature has one, the wrapper returns only `TextContent` (plus FastMCP's duplicated
  `structuredContent.result`), and unknown arguments are dropped silently (pydantic's
  default `extra="ignore"` in `mcp/server/fastmcp/utilities/func_metadata.py:84-86,
  70-78`), so sending `conversation_id` today is ignored rather than rejected.
  `backend_uuid` is the value that is genuinely received-and-thrown-away.
- **Conversations are caller-owned.** The proxy never mints an id; it mirrors the one you
  send (`conversation=body.get("conversation")`, 2152; `_responses_apply_previous`,
  1528-1552; `_conversations_index[conv_id] = rec["id"]`, 1382).

**A. Existing MCP calls with explicit bounded history.** Workable today: keep sending the
conversation from this extension and re-include a bounded transcript each turn. It is *not*
a continuing chat — every turn re-pays the context, upstream session memory is never used,
and Perplexity's own `last_backend_uuid` optimisation never applies. Honest label:
stateless calls carrying history.

**B. A conversation-aware MCP tool backed by existing proxy state.** Feasible without a
second process: `mcp.streamable_http_app()` / `sse_app()` (2978-2979) are routed by
in-process ASGI middleware (2987-3033) and `app.mount("/mcp", mcp_http_app)` (3037) inside
the same FastAPI app, so a tool can read `_responses_store` / `_conversations_index`
directly. A tool would take `conversation` + `input`, then go through
`_responses_apply_previous` (1528) → `_prepare_pplx_from_messages` (1555) →
`client.search(..., follow_up_uuid)` (702/726) → `_responses_collect_answer` (1701) →
`_responses_finalize` (1677, which does the `_session_store` and `_responses_put`).
Obstacles to solve, not excuses: the store is in-memory dicts hydrated from
`/data/.responses_store.json` under a `threading.Lock` (1307-1309, 1379-1381) — blocking I/O
on the event loop; `_responses_load` deliberately raises on a corrupt file (1324);
`_responses_put` can raise a 429 `OpenAIAPIError` that FastMCP flattens into a `ToolError`
(base.py:116-117), losing the code; and since MCP tools return `str`, the id must either be
embedded in the text or the tool re-typed (changing `outputSchema`). **This is the option
that would give a genuinely continuing chat over MCP.** It needs a change to
`~/ai/pplx-proxy` — a different workspace, so its own authorization.

**C. Direct `/v1/responses` chat relay.** What is implemented: one `conversation` id owned
by this extension, `POST {base}/v1/responses` per turn, continuation verified by
`previous_response_id` on the response (and `lostContext` recorded when the proxy starts
fresh). Only the new message crosses the wire; proxy-side context expires after 7 days
(`_RESPONSES_MAX_AGE`, 1305), which surfaces as `NOT attached, the proxy started a fresh
turn`.

A continuing visible chat requires B or C. A is a stateless call with history, and should
not be described as a conversation.

## Quota incidents — 2026-11-07 (read before running anything live)

Two earlier mistakes of the agent spent real Perplexity quota, without permission:

1. `loadMcpSettings()` rebuilt its object field by field, so the relay keys added then
   were silently dropped; the endpoint fell through to the default
   `http://127.0.0.1:8892` and "fake proxy" tests reached the real container: **43
   requests between 21:08 and 21:15 UTC**.
2. The TUI automation described in root cause 1 submitted a goal: **2 requests at
   21:30:32 and 21:30:34 UTC**.

Side effects still in the proxy store (`/data/.responses_store.json`) at the time of
recording: 52 responses across 37 conversations, all `pi-sup-*` — none of them the
user's, all of them the agent's. Pruning is the user's call, not the agent's.

Controls then put in place: the loader lists every relay key (round-trip tested); relay
suites refuse to send unless the resolved endpoint is their fake proxy; `test/setup.ts`
installs a default-deny `fetch` guard for the whole suite — loopback included — and that
guard is itself tested. No unapproved live request was made after 21:30:34 UTC. The single
approved live request is the 2026-11-08 01:27Z launch attempt, recorded above.

**Observation (2026-11-08, after the 01:27Z attempt):** the store now holds **53
responses across 38 conversations** — the 52/37 above plus
`resp_0dc4053c226b4cbfbe921ef8e5d1a31c` / conversation
`pi-sup-pi-supervisor-live-scrat-mw75k2qt` from the approved attempt. Pruning remains the
operator's call.

## Provider observation — a thinking-only completion (2026-11-07, 23:24 UTC)

The last assistant turn of a session (`01a1b6ed-…`, 23:24:04Z, response
`chatcmpl-47344fe3ba85d08e449fdbe9ad16eec4`) ended right after a successful tool result;
`usage` showed `output 178, reasoning 178` — every output token was reasoning. Only
metadata was inspected; no reasoning content was read or reproduced.

**Observed.** The provider reported `finish_reason: "stop"` (recorded as
`rawStopReason: "stop"`; that session's tool turns recorded `"tool_calls"`, so the field
is faithful). Pi recorded an assistant completion whose only content block was a thinking
block — no final text, no tool call, no `errorMessage`.

**Not established.** That this was an actual EOS/stop-token match, that it was a
particular chat-template failure, or which component (server sampler, template, or
client) produced the visible response without visible content. The inference server is
remote (`192.168.1.197:8000`) and has no local logs, so its sampler view is not available
offline.

**Response.** No change to sampler settings, stop sequences, chat templates, or retry
behaviour on this evidence alone. If this shape occurs in a supervised worker run, the
loop pauses instead of relaying silence — no request, no injection, explicit resume
required — and that exact case is pinned offline (`test/relay-e2e.test.ts`: "a
reasoning-only stop pauses visibly, asks nobody, and waits for an explicit resume";
sibling tests cover the empty-text and error-stop shapes).

## Live-test plan (2026-11-08 00:29Z preparation) — retained for a future re-authorization

Scratch: `~/ai/pi-supervisor-live-scratch/` — git-init'd, **no commits ever**. Files:
`README.md` (fixture description, documents the start command `node hello.js`),
`hello.js` (the one source file; verified offline to print `hello from the fixture`, exit
0), `.pi/supervisor-config.json` (top-level `"backend": "mcp"`; `mcp` section:
`relayBaseUrl http://127.0.0.1:8892`, `relayModel "auto"` — proxy-selected, the only id
the free tier accepts (`server.py:508`) — `relayApiKeyEnv PPLX_PROXY_API_KEY`,
`maxIterations 2`, `timeoutMs 180000`, `maxDurationMs 900000`, `retries 0`). All values
are within the loader's `NUMERIC_SETTINGS` bounds; every key is a named loader field.

Exact task wording (entered once, as a single ordinary line — no pty/`script` bursts;
root cause 1 documents that failure mode):

> Read README.md and the source file in this scratch directory. Create
> README-SUMMARY.md containing 3–5 sentences describing this fixture project and its
> documented start command. Do not modify any pre-existing file or create any other task
> artifact. Verify the summary against those two files and report the checks.

Content-based baseline (recorded outside the scratch dir):
`~/pi-supervisor-live-baseline.txt` (2026-11-08T00:29:32Z): relative paths + SHA-256 of
every scratch file **except `.git/**`**, sorted, plus the audit rules in its header.
Post-run audit: (a) every listed file exists byte-identical (no edits — `git status`
alone would miss edits to untracked files — and no removals); (b) the **only** addition in
the strict set is `README-SUMMARY.md` (the task artifact); (c) harness-managed state is
checked **separately and reported separately, never claimed unchanged**: `.git/**` via
`git status --porcelain` (same untracked set plus `README-SUMMARY.md`) and absence of any
commit (`git log` fails — no HEAD); the live pi session's `.jsonl` under
`~/.pi/agent/sessions/` (one new session expected, outside the scratch dir). The dry-run
compare against the manifest passed at recording time.

Limits (kept from the approved shape): one new conversation (minted `pi-sup-*`; nothing
attaches to an existing one, nothing is pruned). Maximum **3 total request attempts** —
the persisted send-site budget `1 + maxIterations = 3`; failures and timeouts count; a
fourth attempt fails locally; redirects are refused locally; there is **no automatic
budget reset or restart after failure** (pause/resume can only spend the remaining budget,
never replenish it). Maximum **2 worker runs**; if the supervisor wants a third, or the
budget runs out first, the loop pauses — neither limit is raised during the run.
**Retries disabled** (`retries: 0`). **No discovery or availability requests** of any kind
(no `/supervise mcp tools`, no model listings, no endpoint probes).

Environment for a run: extension side — `node_modules` pi-coding-agent **1.5.0** (peers
pinned exactly; full gate green; offline host smoke test passed). Host: **pi-bolt 1.5.0**
(deployed 2026-11-07 15:51) — extension and host agree on 1.5.0. The live session must
load the extension explicitly — e.g. `pi -e
/home/pseudobacon/ai/pi-supervisor/dist/index.js` — because no extension discovery
location (global or project) references this checkout; the development session runs
**without** it loaded. Launch must be an **interactive TUI session with the goal typed by
hand** — host print mode (`-p`) cannot host a `/supervise` run (sequential prompts, then
exit and session dispose after the last one; the 2026-11-08 01:27Z launch failed this
way). Worker model: `unsloth/Qwen3.8-Flash-Next-GGUF:UD-IQ3_XXS`, selected on existing
evidence (it produced every turn of the session up to 23:30Z) — e.g. `--model
macbook/unsloth/Qwen3.8-Flash-Next-GGUF:UD-IQ3_XXS` at session start; no availability or
discovery request is made.

Audit — two separate tracks, no 1:1 assumption: (1) Transport: `docker logs
pplx-proxy-pplx-proxy-1` delta of `POST /v1/responses` lines before/after — must be
≤ 3 — cross-checked against the relay's own `attempts n/3` status line. (2) Quota: the
`[Remaining Pro Search: N]` notice recorded per turn from status output; N-start, N-end
and the delta are reported **as observed**, without assuming it equals the request count.
A mismatch between the tracks is reported, not resolved by assumption. Both tracks are
read-only; the proxy store is not pruned.

**Superseded in part:** the attempt was made once (2026-11-08 01:27Z) and failed at launch;
the operator directed a stop at 1 of 3. The 3-attempt budget does not bank — a completion
run would need its own fresh approval.

## Documentation

### 2026-11-08 — HANDOFF.md restructured; this log created

Operator instruction: `HANDOFF.md` must contain only the current, reconciled state
(current goal and acceptance criteria; branch and working-tree state; implementation and
supported dependency/host versions; latest verification results, live versus offline;
blockers and remaining work; current authorization and remaining live-request budget; the
next concrete action; links to historical records), edited in place. Historical material
moves to this append-only log. `AGENTS.md` gains the documentation-maintenance rules.

The prior `HANDOFF.md` accumulated appended updates; its historical sections (working-tree
and environment history, the 2026-11-07 21:30Z root-cause analysis, verification records,
the MCP investigation, the quota incidents, the provider observation, and the live-test
plan) were migrated into this log preserving their earlier order and recorded dates, with
no invented timestamps. Corrections already recorded in the prior document (the missing
`mcp_server.py`, the two changed old tests, the quota-notice correction) remain in their
original entries.

### 2026-11-08 01:48Z — gate re-run for the handoff reconciliation

`npm run typecheck` → exit 0; `npm run lint` → exit 0; `npm test` → 19 files passed |
1 skipped, 318 passed | 3 skipped (321); `npm run build` → exit 0. (Documents-only changes
since the 00:49Z smoke; no code touched by the restructure.)

## 2026-11-08 01:58Z — offline fixes for the chat relay: host-mode gate, template, missing-state diagnosis, end-to-end trace

The four deferred offline fixes plus the requested trace. No live requests, no
commits; the tree stays dirty as before.

### 1. Host run-mode gate

**Fix**: `src/index.ts` — the `/supervise` handler now refuses to **start** and to
**resume** a relay run when `ctx.mode` is `"print"` or `"json"` (the mode is exposed
on the command context in the supported host, `ExtensionCommandContext.mode`, with
the four host modes `tui | rpc | json | print`). The refusal is a warning that lands
before any state is built or any worker is dispatched. Subcommands that stay local
(`status`, `stop`, `backend`, `mcp`, …) still work in every mode, and the model
backend's goal path is untouched — it is the shipped behaviour.

**Why**: a supervised relay run outlives the command handler — the worker dispatch,
the settle, and the next `/v1/responses` request all happen after the handler
returns. The host's print mode processes its positional prompts sequentially and
then exits, disposing the session (`dist/cli/print-mode.js`); the 2026-11-08 01:27Z
attempt died exactly that way — the process was gone before the relay could
consume its own reply.

**Tests** (`test/relay-e2e.test.ts` → "host run mode"): start in print mode → no
proxy turn, no dispatch, no state, warning shown, `status` still local; resume in
print mode while paused → no new turn, no new dispatch, warning. `test/harness.ts`
now gives the mock context a `mode` (default `"tui"`).

### 2. Relay setup template simplification

**Fix**: `src/relay/protocol.ts` — `DEFAULT_RELAY_TEMPLATE` rewritten from ~1,450 to
1,110 characters, keeping every semantic the loop depends on: verbatim forwarding,
the exact `Local coding agent result:` header, no-JSON, do-not-restart-finished
stages, do-not-repeat-no-change instructions, the permission gate, evidence before
acceptance, both terminal markers, and marker placement. The pinned
`test/relay-protocol.test.ts` assertions still pass; a new test pins the required
semantics inside the built-in template.

### 3. Missing-state diagnosis

**Fix**: `src/state.ts` — new pure `missingStateDiagnosis(entries)` and
`SupervisorStateManager.getMissingStateNote()`. When `loadFromSession` finds no
`supervisor-state` entry but does find a user message that started supervision — a
`/supervise` goal, not a control word (exact subcommands excluded; multi-line or
nested submissions rejected via `nonGoalReason`) — it records `MISSING_STATE_NOTE`.
`/supervise status` and `/supervise resume` now show it: the session holds no state,
but a run started and lost its state (the host exited before the session file
flushed, as in the 01:27Z attempt), nothing can be restored, start a new goal.
This makes the silent case of the 01:27Z run explicit instead of generic.

**Tests**: four unit tests in `test/state.test.ts` (string and array-of-blocks
content shapes, a state entry winning over the evidence, control words and
ordinary messages as non-evidence, the note cleared by `start()`) plus one e2e test
in `test/relay-e2e.test.ts` (a session containing only the goal message → both
`status` and `resume` say so explicitly, and nothing reaches the proxy).

### 4. End-to-end trace (verified against both codebases)

Relay → pplx-proxy → Perplexity. Every file:line checked in the 2026-11-08 checkout:

1. **Outbound** (`src/relay/chat.ts`): the persisted budget counter is checked and
   spent *before* every attempt, so failures, timeouts, and retries count; then
   `POST {relayBaseUrl}/v1/responses` with `{ model, input, conversation, store:
   true }`, `Authorization: Bearer ${ENV}` expanded from the named variable at
   request time, `redirect: "error"`, and `timeoutMs` / retries from the resolved
   config — through the extension-injected `fetch`.
2. **Proxy continuation** (`~/ai/pplx-proxy/server.py`): `_responses_apply_previous`
   (1528) mirrors the `conversation` id, loads the conversation's last stored
   response, and rebuilds the message history from the stored record — stripping
   the quota notice (`_REMAINING_NOTICE_RE`, 1208); `_prepare_pplx_from_messages`
   (1555) builds the Perplexity request, and for a normal chat the
   `follow_up_uuid` comes from the implicit session key (1587) — that is what
   continues Perplexity's own conversation; `client.search` (702).
3. **Proxy response** (`server.py`): the answer stream is collected
   (`_responses_collect_answer`, 1701); `_responses_finalize` (1677) stores the
   response, updates the conversation index (1382), and applies `_response_suffix`
   (427, called at 1682) — this is where `\n\n[Remaining Pro Search: N]` (201)
   is appended to the answer text. Stored responses expire after 7 days
   (`_RESPONSES_MAX_AGE`, 1305).
4. **Inbound** (`src/relay/chat.ts`, `src/relay/protocol.ts`):
   `extractResponseText` reads `output_text` (or `output[].content[].text`); the
   quota notice is stripped by `PROXY_QUOTA_NOTICE` and carried as `turn.notice`;
   `redactSecrets` runs on the text *after* parsing (parsing the redacted copy
   corrupts valid replies); `previous_response_id` drives the `continued` /
   `lostContext` flags.
5. **Worker turn** (`src/relay/protocol.ts`): `detectRelayMarkers` applies the
   marker grammar — exactly the two observed forms, only at the terminal position
   of the assistant's own reply, never inside quoted worker output; the terminal
   marker is removed from the displayed text; `buildWorkerResultMessage` builds
   `Local coding agent result:` + the worker's own final response (middle
   truncation with an explicit marker at the size ceiling, plus extension notes for
   tool errors the worker did not mention); that message is the next `input` in
   the same conversation.
6. **Continuity**: the same `conversation` id makes the proxy replay its stored
   history, so only the new message goes to Perplexity. Expiry or a new
   conversation id surfaces as `lostContext` and pauses for review rather than
   restarting silently.

This is the contract the relay holds: one conversation per goal, the worker's own
words arrive back verbatim, and nothing is parsed out of the prose except the two
terminal markers.

### Gate

`npm run typecheck` → exit 0. `npm run lint` → exit 0 with one pre-existing warning
(`unicorn/no-useless-fallback-in-spread`; `src/mcp/config.ts:177`,
`src/report.ts:195-196`, `src/index.ts:441` — none in this phase's changed lines).
`npm test` → 19 files passed | 1 skipped; **326 passed | 3 skipped (329)** — 8 new
tests (4 state, 3 e2e, 1 protocol). `npm run build` → exit 0.

## 2026-11-08 02:09Z — product correction: the relay is a literal transfer of an operator's existing chat; attachment investigation

The operator corrected the product model: **not** a supervisor evaluator and **not** a chat the
extension initializes. It is a literal text relay between an **existing** Perplexity conversation
and the Pi worker. The built-in intro template's use is removed from this flow; the initial
prompt goes to the worker verbatim with **zero** Perplexity requests; each subsequent handoff is
the plain text of one side becoming the next message on the other; completion is a separate,
explicit design choice, never guessed from prose. Docs updated (this entry, `HANDOFF.md`,
`AGENTS.md` relay rules). No code changed yet — the operator asked for the attachment
limitation and the smallest change to be reported first. No live requests, no commits.

### Attachment investigation — what pplx-proxy actually supports

All citations verified in `~/ai/pplx-proxy/server.py` on 2026-11-08.

**Continuable, by proxy-minted id only:**
- `POST /v1/responses` accepts `previous_response_id` **or** `conversation` (string or `{id}`),
  never both (`_responses_apply_previous`, 1528-1536; 400 at 1532).
- `previous_response_id` (strict): unknown id → **HTTP 404** "No model response found with id"
  (1547); not completed → 400 (1549); continuation replays the stored `_history_messages`
  (1550; built at 1696/2208, quota-notice-free because `_responses_finalize` cleans text with
  `_clean_response`/`_strip_appended_notices` — 1208-1212, 1678).
- `conversation` (**permissive — the silent-substitution trap**): a known id resolves to the
  last response via `_conversations_index` (1540); an **unknown id silently starts a fresh
  history with no error** (1541-1542). Continuity from a locally minted conversation id is
  therefore unprovable from a single request — exactly what the operator forbade.
- Ids visible to callers: records expose `id: resp_<hex>` (1632), `previous_response_id`, and
  `conversation: {id}` (1669) via `_responses_public` (underscore-private fields only).
- Storage: `_responses_store`/`_conversations_index` (1307-1308) persisted to
  `DATA_DIR/.responses_store.json` (1353; `/data` in the container), so continuations survive
  proxy restarts. TTL 7 days (`_RESPONSES_MAX_AGE`, 1305), cap 300 entries (1304), eviction
  drops the conversation index entry with its response (1367-1369). `store:false` requests are
  never stored or indexed (`_responses_put` early-returns, 1371-1372).
- **Zero-cost attachment check**: `GET /v1/responses/{response_id}` (2247-2252) is a pure store
  read behind the API key — no Perplexity call, no quota — and 404s when the seed is absent.

**Not attachable, by any mechanism:**
- A **Perplexity.ai web-app chat**: no request field anywhere accepts a Perplexity thread or
  backend uuid. `follow_up_uuid` is resolved solely from the proxy's own in-memory
  history-hash session cache (`_session_lookup`/`_session_store`, 307-343; consumed at 1587,
  disabled whenever a system message or final instructions are present, lost on restart).
  There is no path from a perplexity.ai thread to the proxy's store.
- The proxy's **`/chat` debug UI** (`/chat` route 1142 → `static/chat.html`, which posts to
  `/v1/chat/completions` at line 280) and **any `/v1/chat/completions` client** (LobeChat etc.):
  stateless OpenAI shape — the client re-sends the whole history and no id is issued; verified
  that the chat-completions handler (2441-2841) contains **no** `_responses_put` /
  `_responses_store` / `_conversations_index` reference.

**Conclusion (the limitation to report):** the extension can attach **only** to chats that ran
through this proxy's `POST /v1/responses` with `store` not `false`, and the operator must hold
the `resp_*` response id (or the originally supplied `conversation` id) from that chat, within
7 days and under the 300-entry cap. A prompt from the Perplexity web app or from any
chat-completions client has no seed and cannot be attached; the fix for the operator is to
originate such chats through an OpenAI-Responses client pointed at the proxy.

### Smallest required change (proposed, not yet implemented)

1. New named setting `relaySeedResponse` (a `resp_*` id from the original chat; operator sets
   it; `loadMcpSettings`/`resolveRelay` must name it or it is silently dropped — AGENTS rule —
   with a `relay-config.test.ts` round-trip).
2. Start: validate attachment **before dispatch** with `GET /v1/responses/<seed>` (through the
   injected fetch and the network guard; no POST, no quota). Non-200 → visible failure naming
   expiry/eviction/never-through-this-proxy as the possibilities; **no** worker dispatch, **no**
   fallback conversation. 200 → dispatch the operator's initial prompt to the worker verbatim;
   zero `/v1/responses` POSTs happen before the first worker result.
3. Continuation: every POST uses `previous_response_id` chained from the latest response id;
   never send `conversation`; a mid-run 404 pauses visibly (chain broken by expiry/eviction),
   never reseeds silently. The persisted attempt-budget counter keeps counting POSTs (the
   validation GET is store-only; whether it also counts is an open operator decision —
   recommendation: count it, it is one outbound request).
4. Remove from this flow: `buildIntroPrompt`/`DEFAULT_RELAY_TEMPLATE` use, `relayIntroSent`,
   minted `pi-sup-*` ids, the `Local coding agent result:` header and appended notes, the
   tool-error append. Empty worker output already pauses — keep.
5. Worker→chat `input` is the exact final text string (never JSON); chat→worker is the exact
   reply, minus only the proxy quota notice (proxy artifact). Keep middle truncation as the
   documented ceiling brake.
6. Completion: default manual stop + ceilings. Marker detection behind an explicit opt-in
   setting (default off); when enabled, keep the existing terminal-position grammar and
   document marker removal as the one verbatim exception.
7. Tests: replace intro-semantics tests; add the operator's exact-message tests (verbatim
   initial dispatch with zero POSTs; worker text → next `input` byte-equal; reply → next worker
   instruction byte-equal; continuation asserted by seed + `previous_response_id` chain on the
   fake proxy; unknown seed → visible failure, zero POSTs, zero dispatches).

## 2026-11-08 09:44Z — route decision investigation (offline only; no live requests, no proxy calls, no browser action, no installs, no code changes)

Operator decision task: pick the route for the literal Perplexity↔Pi text relay. Requirements
separated per the operator: **A** = continue the exact existing Perplexity web-app
conversation (primary); **B** = accept a different, simpler, reliable chat interface;
**C** = carry task context without necessarily the same visible chat.

### New facts verified today (local source, `~/ai/pplx-proxy/server.py`)

- The upstream is the **web service**, not the official API: `PPLX_BASE` (349) =
  `https://www.perplexity.ai`; `PPLX_SSE_ASK` (350) = `/rest/sse/perplexity_ask`;
  authenticated with the operator's web session cookie (`COOKIE_FILE` 50,
  `.cookie_cache.json`, `__Secure-next-auth.session-token` 106-115). The proxy's own MCP
  instruction string is "Perplexity Pro Search reverse proxy" (2863).
- Continuity primitives are proxy-local: `previous_response_id` replays stored
  `_history_messages` (1550), unknown → 404 (1548); `conversation` resolves against a
  persisted local index (1308-1353), unknown → silently fresh history (1540-1543); the two
  are mutually exclusive (400, 1532). `GET /v1/responses/{id}` (2247-2252) = pure store read.
- The web service's server-side continuity token is `backend_uuid`, delivered in the SSE
  stream (846-847, 929-951). The proxy stores it keyed by a hash of its **own** history
  (307-340) and uses it only for its **own** follow-ups (726). **No request field or
  endpoint accepts a foreign conversation id or `backend_uuid`** → a conversation-aware
  proxy tool could only continue proxy-originated conversations; it cannot attach to a
  web-app chat. No supporting implementation was found; this closes the open item from
  02:09Z.
- `/v1/chat/completions` (2441+): no conversation/session parameter in the param surface;
  stateless (store never written). The proxy's own `/chat` UI (`static/chat.html:280`)
  calls it, so even the proxy's chat UI cannot drive a `/v1/responses` conversation.
- MCP tools (2902-2978): `perplexity_ask`, `perplexity_reason`, `perplexity_research`,
  `perplexity_models` — all stateless one-shot `client.search(query, …)`, no conversation
  parameter. Existing MCP cannot carry continuity.
- The proxy's environment includes an optional challenge-solving integration
  (`FLARESOLVERR_URL`), indicating active bot-defence on the web endpoints the proxy calls.

### Public documentation (no browser action performed)

- Playwright core: `chromium.connectOverCDP('http://localhost:9222')` attaches to a running
  Chromium-family browser; the existing logged-in context and tabs are exposed via
  `browser.contexts()[0]` / `context.pages()`; tab selection by URL; Playwright does not
  own the browser (a connected browser must not be closed from the script); Chromium-only;
  CDP attachment has lower fidelity than the Playwright protocol (playwright.dev
  BrowserType / BrowserContext docs).
- Playwright MCP: two documented attach modes — `--cdp-endpoint=http://localhost:9222` and
  `--extension` (Playwright Extension installed in Chrome/Edge; reuses logged-in sessions
  and cookies; `--profile-dir-name`, `--background`, `--no-tab-group`). The docs state the
  attached browser acts with the real signed-in session and is explicitly "not a security
  boundary" (playwright.dev/mcp/configuration/browser-extension).
- Perplexity web ToS: "These terms do not cover the separate Perplexity API." §5.2: "You
  may not do any of the following in connection with your use of the Services, unless
  applicable laws or regulations prohibit these restrictions or you have our written
  permission to do so:" — including §5.2(i): "use any robot, spider, crawlers, scraper, or
  other automatic device, process, software or queries that intercepts, 'mines,' scrapes,
  extracts, or otherwise accesses the Services to monitor, extract, copy or collect
  information or data from or through the Services, or engage in any manual process to do
  the same." The API is governed by its own API ToS + Acceptable Use Policy.
- Interpretation (mine, not Perplexity's): both the existing cookie proxy and a browser
  route fall in the §5.2(i) category; owning the account is not, in the published terms, a
  safe harbour for automating it. Enforcement is unknown.

### Option comparison (summary; the session memo holds the full table)

1. **Proxy `/v1/responses` + a Responses-speaking frontend** — meets B/C. API, store, and
   zero-cost 404 validation already supported; the human-facing frontend is proposed (the
   proxy's `/chat` UI is stateless chat/completions). Strict identity (unknown id → 404);
   persisted store (7-day / 300-entry lifetime, 1304-1305). Low effort, low maintenance.
2. **Existing MCP tools with explicit history** — meets C (weaker). Stateless; transcript
   re-embedded per call; 96000-char tool-conversation limit (2053). No persistent chat
   object, no identity guarantee.
3. **New conversation-aware MCP tool (proxy extension)** — meets B/C only. Wraps what
   `/v1/responses` already exposes; **cannot attach to web-app chats** (verified above).
   Medium effort for marginal gain.
4. **Playwright MCP attached** — meets A. Attachment documented; its capture surface is
   accessibility snapshots (lossy for a verbatim relay); needs a deterministic MCP client
   layer to avoid model-driven use.
5. **Direct Playwright adapter** — meets A (the only option that does). Attachment
   documented; verbatim capture and streaming-vs-completion detection **not verified** —
   the read-only experiment below is the gate. New loopback adapter process (pin tab, read
   last assistant message, submit once, status); the relay backend swaps the transport
   mapping only — loop, budgets, redaction, and lifecycle stay.
6. **Manual copy/paste** — C (degenerate). Zero code; one-time manual bridge for the
   initial prompt; otherwise hand relay. Fallback, not a product.

### Recommendation

- **For A: the direct Playwright adapter (option 5)**, gated on (1) the operator's explicit
  acceptance of the §5.2(i) exposure and (2) the read-only feasibility experiment passing.
  Not Playwright MCP for the relay hot path: the relay's caller is deterministic extension
  code, and verbatim capture needs exact DOM text, not a11y snapshots.
- **If B is accepted: option 1** — the relay conversation runs through the proxy's
  `/v1/responses` with a small chat frontend in front. Strong identity guarantees and
  roughly 90% reuse of the existing offline work; the cheapest route overall.
- **C** = the current corrected flow with a one-time manual paste bridge; it requires
  relaxing the "never mint a replacement conversation" invariant for this flow (the relay
  conversation is born at the first worker result) — a product decision, not an
  implementation detail.
- MCP adds no continuity value to the relay (it is a tool-transport protocol); the existing
  proxy MCP is kept only for the separate `mcp`-backend path.

### Smallest next experiment (read-only; NOT executed — awaiting approval)

1. Playwright installed in an isolated scratch location (not a pi-supervisor dependency).
2. Operator launches a browser (recommended: a dedicated profile, manually logged in —
   conversations are account-scoped server-side, so another profile can open the same
   chat) with `--remote-debugging-port=9222`, and selects exactly one existing Perplexity
   conversation tab by URL.
3. One ephemeral script (nothing committed): `connectOverCDP` → list pages (URLs only) →
   select the pinned tab → print title + URL → extract the last assistant message's text
   (print text + length; re-read once for byte-stability) → print observed
   streaming/completion indicators → disconnect (no `browser.close()`, no navigation, no
   clicks, no typing, no sending, no relay, no worker dispatch).

Proceed if: attachment + tab selection work; the last completed assistant answer extracts
verbatim and is byte-stable across two reads; a completion-vs-streaming signal is
identifiable; no challenge/login wall. Abandon or rescope if: CDP attach fails; a challenge
appears (stop — do not bypass it); extraction is unstable; no completion signal can be
identified.

### Approvals required before that experiment

1. Explicit ToS acceptance (§5.2(i) category for browser automation of the web app).
2. Isolated scratch install of Playwright (outside the repo, not a dependency change).
3. Operator-launched CDP-enabled browser (or Playwright Extension) and operator-selected
   pinned conversation tab; operator login in a dedicated profile if that variant is used.
4. Acceptance of the exact read-only scope above.

### Status

No live requests, no proxy calls, no browser action, no installs, no code changes, no
commits. `HANDOFF.md` updated in place (decision state, attachment additions, blockers,
next actions). Waiting on the operator's route decision.

## 2026-11-08 10:21Z — route A accepted; browser-relay contract fixed; probe staged (no browser action yet)

**Operator decisions, verbatim intent.** "I accept 5.2 exposure." Route **A** (browser route)
is chosen. The session-start flow the operator specified:

1. The operator chats in the Perplexity **web app**; that chat produces a prompt.
2. The session is started with `/supervise` — the operator pastes that prompt.
3. The harness works until it stops with a result.
4. The result is put into the chat that receives harness responses — **"no prompt, just as
   is"** (verbatim, no wrapper).
5. Wait for the Perplexity thread to produce a reply; **that reply contains the next
   instruction as a code block**; that code block is sent back to the harness; loop.
6. "The only time this loop stops is when perplexity chat says the work is complete. We can
   also safeguard this by making sure that there are no todos left based on the latest chat
   response."

**Four design questions asked and answered (all: recommended option selected).**

1. **Instruction-block selection = labelled fence ` ```prompt `.** Only a fenced block whose
   info string is `prompt` is taken as the instruction (other languages' blocks, e.g. the
   code being written, are ignored). No matching block = no next instruction. Chosen over
   "exactly one block else pause", "last block wins", "everything after a divider".
2. **Completion = no instruction block AND empty worker todos.** A reply with no `prompt`
   block (no next instruction exists) **and** the Pi worker's todo list with no
   `pending`/`in_progress` entries completes the run. Never inferred from prose: a chat that
   says "done!" while still handing over a block keeps running. Chosen over a phrase
   whitelist, either-signal-alone, and manual-stop-only. This supersedes the
   `[[SUPERVISOR: COMPLETE|STOP]]` marker convention **for this route**; that grammar is not
   deleted yet — removal is a separate, explicit step.
3. **Initial prompt = pasted into `/supervise start <prompt>`.** Verbatim, **zero browser
   reads at start**; the adapter thereafter only writes results to the pinned tab and reads
   replies. Chosen over reading it from the pinned tab and over a `--from-chat` flag.
4. **Next step = the read-only feasibility experiment** (below), before implementation.

The operator also accepted the simplification "assume the latest chat thread is the one
receiving harness responses". Recorded honestly: that is ambiguous when several
`perplexity.ai` tabs are open, so the adapter must **refuse rather than guess** (pin = the
single matching tab, or an explicit override), never silently pick one.

### New blocking environment fact (verified, changes the launch procedure)

`google-chrome-stable --version` → **Google Chrome 157.0.8103.38**. From **Chrome 136**
onward `--remote-debugging-port` and `--remote-debugging-pipe` are **ignored when Chrome uses
its default user-data directory** (developer.chrome.com/blog/remote-debugging-port;
crbug 417456892, 429117827) — anti-cookie-theft hardening; a separate `--user-data-dir` gets
its own encryption key. Therefore attaching over CDP to the everyday `~/.config/google-chrome`
profile is **impossible by design** on this machine. The browser route necessarily attaches to
a **dedicated profile the operator logs into manually**. Requirement A survives because
Perplexity conversations are account-scoped server-side — after signing in with the same
account the existing threads are reachable there (**to be confirmed by the probe, not
assumed**). Also documented: `browser.close()` on a `connectOverCDP` browser *disconnects*
that client and does not quit the browser process (types `Browser.close`: "In case this
browser is connected to, clears all created contexts belonging to this browser and disconnects
from the browser server") — the probe still avoids calling it, exiting the process instead.

### Probe staged (isolated, not a repo dependency; no browser action performed)

`~/ai/scratch/pw-probe/`:
- `package.json` + `playwright-core@1.65.0` installed there only; **not** added to
  `pi-supervisor`'s dependencies. No browser download needed — attachment is over CDP to
  the operator's Chrome. (`~/.cache/ms-playwright/chromium-1105` exists from an unrelated
  install and is unused.)
- `probe.mjs` — read-only. `connectOverCDP` → list every tab (ctx/pg index, URL, title) →
  pin exactly one tab (`--tab=<substring>`, or the single `perplexity.ai` tab; **refuses and
  exits if the selector is ambiguous**) → read-only document facts (`readyState`, body char
  count, `aria-busy` count, login-wall signals `input[type=password]` + log-in text,
  challenge signals via captcha/turnstile iframes + "verify you are a human" text, relevant
  button labels) → **selector discovery**: node counts for candidate assistant-message
  containers → extract the last matching node's `innerText`, wait 2500 ms, re-read, and report
  **byte-stability** (sha256 of both reads) → rehearsal of the ` ```prompt ` fence extraction
  on that text (counts only, dispatches nothing) → optional `--shot=` diagnostic screenshot.
  Issues **no** navigation, clicks, keystrokes, form input, sends, scrolling, `page.close()`,
  or `browser.close()`; disconnect is process exit.
- `launch-chrome.sh` — the mandatory launch (dedicated `--user-data-dir`
  `$HOME/ai/scratch/pw-probe/profile`, `--remote-debugging-port=9222`, `--no-first-run`,
  `--no-default-browser-check`, `--disable-background-timer-throttling`), with the Chrome 136
  reason in comments, and a preflight that refuses if port 9222 is already listening.
- Selector candidates are **discovery candidates, not assumptions**. Two are sourced from
  real evidence: `pplx-proxy`'s own comments describe Perplexity's DOM as `message-bot-response`
  divs (server.py:1081) and an `answer-actions` div (1124-1125). The rest are generic
  (`[class*="message-bot"]`, `[data-testid*=message]`, `[data-message-author-role=assistant]`,
  `article`, `[class*="prose"]`). The probe reports each candidate's match count so the real
  DOM is learned rather than guessed; **no selectors or completion signals are claimed yet.**
- Verified: `bash -n launch-chrome.sh` OK; `node --check probe.mjs` OK (after fixing a
  backtick-in-template-literal syntax error found by the check); `node probe.mjs` with no
  browser running prints
  `PROBE FAILED: browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9222` plus the
  remediation hint, **exit 1**. `ss` is available for the preflight.

### Not yet done

The operator must launch the dedicated-profile Chrome, sign in to Perplexity, and open the
conversation to pin. Then the probe runs — read-only — and its observations decide the real
selectors, the completion-vs-streaming signal, and whether requirement A is feasible at all.
No implementation of the browser transport has been written; `pi-supervisor` code is
unchanged this phase (docs only), and the offline gate results from 05:33Z still stand.

## 2026-11-08 11:40Z — browser-attachment experiment EXECUTED (read-only). Route A feasible for attach+read; submission untested; two design-breaking findings.

Operator ran `~/ai/scratch/pw-probe/launch-chrome.sh`, signed in, and pinned a thread. The
read-only probe was then run, plus a read-only streaming observation during which **the
operator** (not the tooling) sent one follow-up in the browser tab. No message, keystroke,
click, scroll or navigation was issued by any script; disconnect was process exit. Nothing
in `pi-supervisor` was changed this phase; no commit.

### Attach: WORKS

- CDP live: `Chrome/157.0.8103.38`, `--user-data-dir=~/ai/scratch/pw-probe/profile`
  (the dedicated profile is mandatory — Chrome 136+ ignores `--remote-debugging-port` on the
  default dir). `connectOverCDP` → `contexts()=1`, one `perplexity.ai` tab, pinned by URL.
- Conversation URL form: **`https://www.perplexity.ai/session/<uuid>`** (not `/answer/`).
  Operator chose pinning = **exact session URL, refuse otherwise**.
- No login wall (`input[type=password]`=0, no log-in text), **no challenge** (no
  captcha/turnstile iframe, no "verify you are a human"). `readyState: complete`.
- Verbatim read of a completed answer: **byte-stable** — 7 327 chars, sha256 prefix
  `33017e8f794bcccc` identical across two reads 3 s apart.

### Selectors: every proxy-era guess is dead; the working hooks are `data-workflow-*`

`pplx-proxy`'s DOM comments are stale: `div.message-bot-response`, `[class*=message-bot]`,
`.answer-actions`, `[data-testid*=message]`, `[data-message-author-role]`, `article` —
**0 matches each**. Hashed CSS-module classes (`_root_128yu_7`) are unusable. Observed hooks:

- `div.prose[data-renderer="lm"]` — an `lm`-renderer block. **NOT assistant-only**: the user
  bubble carries `data-renderer="lm"` too (inside a `_root_…` wrapper), and a user's fenced
  message is a `pre` inside such a node. `:not([data-message-bubble] *)` excludes the right-
  aligned bubble (verified: 1 match when the old turn was unmounted, more after re-render),
  so **prose+renderer alone is not a safe answer anchor.**
- **`[data-workflow-final-text]`** (+ `data-workflow-items-first`, `data-workflow-items=
  "populated"`) wraps the **answer partition** — status line + answer; it does not wrap the
  user turn. **`[data-workflow-entry="<n>"]`** numbers turns (observed `="20"` on the newest
  user partition). `data-workflow-text-footer` marks the (icon-only, 0-char) action row.
  These are the semantic anchors to build on; `data-state` is Radix noise.
- User turns: `[data-message-bubble="right"]`. Composer: `div[contenteditable=true][data-
  lexical-editor=true][aria-label="Ask a follow-up"]` — a **Lexical** editor, so submitting is
  non-trivial and still untested.

### FINDING 1 — markdown fences do not exist in `innerText`; the agreed grammar cannot work as written

The agreed instruction rule was "take the ` ```prompt ` fenced block". Read from the DOM,
**rendered code blocks contain no backticks at all**: on a real reply containing two fenced
blocks, the regex `/```…```/` matched **0** fences and the text contained **0** fence
markers — so the agreed grammar reads *"no instruction"* and the loop would stop on a reply
that in fact carries two instructions. Structure observed per code block:

```
div.my-3.w-full.first:mt-0.last:mb-0.md:max-…
  pre.not-prose.w-full.rounded.font-mono.text-…
    figure.relative.flex.w-full.min-…
      span "text"                    <- language label chip (first line of pre.innerText)
      div.ml-auto.flex.items-center…  <- controls (copy button, icon-only)
      code                            <- CLEAN content
```

`pre.innerText` is **contaminated by the label chip**: measured `preChars − codeChars = 5`
("text") on all three blocks observed (7195/7190, 776/771, 150/145). Therefore extraction is
DOM-based: **read the `code` element**, and match the language from the **label chip**, not
from a backtick info string. No `language-*` classes exist. The label observed is `text`;
a `prompt` label has never been seen — the operator chose to add that convention to the chat
themselves, and it must be verified against a real reply before it can be relied on.

### FINDING 2 — the status cell says "Finished" while the answer is STILL streaming

Read-only 300 ms poll during the operator-sent turn (`observe.log`): the composer held text
(`compLen 1→37`) at t+35.7 s; on submit `compLen→1` and `userBubbles 1→2`, status became
`Finished|Working` (t+38.8 s); the new answer mounted at **t+42.2 s with only 50 chars and
status ALREADY back to `Finished`**, while its text kept growing monotonically
50→123→…→2 343 chars until **t+51.9 s**. So **`title="Finished"` is not a completion signal** —
acting on it would have relayed a 50-character truncated answer. Completion must be gated on
**answer-text byte-stability across consecutive reads**, optionally plus "no Stop control".

- `aria-busy="true"` never appeared during generation → useless here.
- Stop control: while **idle**, `stop/cancel/pause`-like **short** aria-labels = `[]`; during
  generation the count of elements whose aria-label matches `/stop/i` went **12→13→12**, but
  the baseline 12 are **citation buttons whose aria-label is an entire answer body** (they
  contain the word "stop"). A presence test must therefore be restricted to **short labels**
  (≤24 chars, `/^\s*stop\b/i`); the exact label is still unidentified.
- Virtualisation is real: the rendered answer count oscillated **1↔2** purely with scroll.
  `.scrollable-container` reports `distanceFromBottom` (0 when at bottom) — use it, and treat
  "last answer" as the last `[data-workflow-final-text]` partition, cross-checked against the
  newest `[data-workflow-entry]` user turn, rather than trusting a bounding box (a tall
  answer reported `rect.top = −3056` while being the current answer).

### Verdict against the pre-registered proceed/abandon criteria

Proceed conditions **met**: attach works; one tab pins unambiguously; a completed answer
extracts verbatim and is byte-stable; **no** challenge/login wall. One condition **partly
met**: a completion signal is identifiable, but *not* the one assumed — the status label is a
decoy, so completion is text-stability-based. **Unproven**: submission (Lexical), the exact
Stop label, and a `prompt`-labelled code block ever appearing.

### Corrected smallest next step (NOT executed — it WRITES to the chat, needs explicit approval)

A single controlled exchange, no Pi worker: submit one harmless message into the pinned tab
**once**, observe the new answer to completion by byte-stability, and confirm the Stop label +
the `code`-element extraction path end-to-end. An ambiguous submission outcome **pauses and
never resends**. It spends one Perplexity query from the operator's own quota and mutates the
pinned thread, so it is the operator's call. Only after that does the adapter get wired to the
existing relay loop.

## 2026-11-08 11:58Z — CONTROLLED EXCHANGE executed in a fresh disposable thread (1 query, operator-authorized). Submission works; the `prompt`-label convention FAILED.

Scope as authorized: one harmless message submitted **once** into a **new** thread, no Pi
worker, no relay loop. Outcome: **submitted, answered, extracted.** Budget spent: exactly 1
Perplexity query. Nothing in `pi-supervisor` changed; no commit.

### Submission mechanism: works

`submit.mjs` focused the composer, `keyboard.insertText(TEXT)` (one insertion), verified the
composer held **exactly** the intended text (`sha=373624c9e9055505`, 133 chars), pressed
**Enter exactly once**, then confirmed both post-submit conditions (composer cleared **and**
our text present as a bubble). Guards exercised before any action: exactly one Perplexity tab;
`--expect-fresh` required `url=https://www.perplexity.ai/` **and zero turn nodes**
(`[data-workflow-entry],[data-workflow-final-text]` = 0 — proves it is the new chat, not the
design thread); exactly one visible Lexical composer; composer normalized-empty; refuse if our
text already appears as a bubble. Two real bugs were caught by preflight before any write:
`norm` referenced inside `page.evaluate` (Node closure is not in page scope), and the
empty-composer gate testing **raw length** — Lexical's empty composer reads `"\n"` (1 char),
so raw length would have refused forever; the gate now tests **normalized** emptiness.

### URL forms (matters for pinning)

A new chat is transiently **`/search/new/<uuid>`** (observed
`/search/new/1ea022cf-ab4e-44ad-b741-7d06d7332727` immediately after the first submit) and
settles to **`/session/<uuid>`** (verified afterwards:
`https://www.perplexity.ai/session/e879e74f-54cd-4bd3-9a39-421a4eb95af3`). Pin-by-exact-URL
therefore cannot apply to the *first* message of a brand-new chat — that case needs the
zero-turn-nodes guard instead, which is what was used.

### Composer selector: never match on `aria-label`

Home page: `aria-label="Type / for search modes"`. Inside a thread: `aria-label="Ask a
follow-up"`. Same control (`data-lexical-editor="true"`, same class prefix). The adapter must
select `div[data-lexical-editor="true"][contenteditable="true"]` filtered to **visible**, and
refuse unless exactly one is visible. (The first version of the script used the thread label
and correctly refused to act on the home page rather than guessing.)

### Exact code-block structure (the instruction carrier) — label is `figcaption`

```
pre.not-prose… > figure.relative.flex…
  figcaption  → "text"     <- the language label, and ONLY here
  div         → "ping"     <- content wrapper
    code      → "ping"     <- clean content, no label contamination
```

Confirmed by DOM dump: `figureChildren: [figcaption:"text", div:"ping"]`,
`codeText: "ping"`, `codeChars: 4` vs `preChars: 9` (Δ5 = the `text` label leaking into
`pre.innerText`). The earlier "first short span" heuristic is **fragile** — short spans also
contain the code's own text (`allSpans: ["text","ping","ping"]`). Read the label from
**`pre figure > figcaption`** and the content from **`code`**.

### FINDING 3 — Perplexity did NOT honour the `prompt` language label

The submitted text asked, in words, for "a code block labelled prompt". The reply's block came
back labelled **`text`** (Perplexity's default). So the agreed primary rule — "take the
`prompt`-labelled block" — **cannot be relied on**; only the agreed *fallback* fired: exactly
one block in the answer, label `text` → dispatch its `code` content (`"ping"`). Two readings
remain open and are not resolvable from one sample: (a) Perplexity ignores/sanitizes unknown
info-strings to `text`, or (b) it simply chose not to label this one. Unknown whether any
label survives (untested).

**And the fallback breaks on real answers**: the earlier real reply (2 343 chars) contained
**two** `text` blocks — the first was the actual instruction ("Approved: perform only the
proposed read-only browser-attachment test…"), the second an acceptance-gate quote, not an
instruction. "Exactly one block" therefore declines to dispatch, `prompt`-labelling cannot be
depended on, and "last block" would have picked the wrong one there. **The instruction-carrier
rule is an open product decision, not a detail.**

### Stability target: measure the ANSWER node, not the partition

`[data-workflow-final-text]`'s `innerText` **includes the status line** — final verified text:
`"Finished\ntext\nping"`. During generation that line changes (`""`/`"Working"` → `"Finished"`),
which mutates the partition length and would reset a byte-stability counter measured at the
partition. The correct measurement target is the **answer node inside the final-text partition**
(`div.prose[data-renderer="lm"]` scoped to `[data-workflow-final-text]`) — here `9` chars
("text\nping"), stable; the partition is 18.

### Still unproven

- **The Stop control and any "is generating" signal**: the reply was one word, so
  `stopLabels` sampled `[]` throughout and the control was never observed. Idle-state evidence
  stands: zero short stop-like labels; the 12 baseline `/stop/i` matches are citation buttons
  whose aria-label is an entire answer body.
- **Timing edges**: the answer partition appeared at **t+519 ms** with no text, and the
  byte-stability gate declared completion at **t+2 027 ms** — correct for a 4-char answer by
  luck, far too tight for a real one. The window must be widened and cross-checked; a
  partition appearing is NOT an answer arriving. `[data-workflow-text-footer]` was present (1)
  at completion; whether it is absent during generation is unobserved.
- Whether a thread's `data-workflow-entry` numbering is per-thread (observed `["0"]` in the new
  thread vs `["20"]` in the long one) — consistent with per-thread, single sample.

## 2026-11-09 00:57Z — browser relay implemented offline: marker rule, todo gate, adapter, commands. Gate clean. No live requests, no browser action.

Operator decision that unblocked blocker 1 (the `prompt` language label): *"a text or prompt
code block, with the first line of the code block being NEXT AGENT INSTRUCTION"*. Language is
ignored; the marker's **first line** inside the block is the carrier. This is now implemented,
so the open product decision is closed. It supersedes the `[[PPLX_DONE]]`/`[[SUPERVISOR:…]]`
conventions for this route.

### Observations (verified in this session, not inherited)

- **Plain pi 1.5.0 has no todo concept.** `grep -rn "todoList\|TodoItem" node_modules --include="*.d.ts"`
  printed nothing; the only files mentioning them are pi's own examples (`examples/extensions/todo.ts`
  registers `name: "todo"` with `add`/`toggle`/`clear` + `done`; `examples/extensions/plan-mode/utils.ts`
  has a `TodoItem` with `status`). Real pi session files on this machine contain **zero** `todo` tool
  calls. An Explore subagent reported an `AgentSessionState.todoList` accessor in `pi-ai/dist/types.d.ts`;
  that citation is **fabricated** (path does not exist) and contradicted its own concluding sentence.
  Consequence recorded: on plain pi the todo half of the completion rule **cannot** be satisfied, so a
  browser run pauses instead of auto-completing. This is an operator decision, not an implementation gap.
- `ReadonlySessionManager` (dist/core/session-manager.d.ts:178) does expose `getEntries()`/`getBranch()`,
  so an entry-scanned todo reader is implementable — hence `src/browser/todos.ts`.
- CDP on 127.0.0.1:9333 is **down** (the probe's dedicated Chrome was closed); port 8731 free.

### What was built

- `src/relay/instruction.ts` — marker rule + `decideCompletion()`: **complete requires no marked block
  AND zero pending/in-progress todos**; every disagreement (no block + open todos, unreadable todos,
  two marked blocks, empty marked block) returns a stall with a reason, never a guess.
- `src/browser/protocol.ts` — strict validators + `assertLoopbackOrigin` (refuses https, LAN hosts,
  resolvable names, paths); `toReplyBlocks` keeps `answerText` verbatim and adds blocks.
- `src/browser/client.ts` — `BrowserChat`: `/submit` then `/wait`, no retries at any layer, attempt
  budget spent **before** the submit, aborts propagate as aborts.
- `src/browser/todos.ts` — conservative entry scan; returns `null` (undecidable) for a status-less list,
  a single-item mutation, or an unknown status.
- `src/backends/browser-backend.ts` — separate class, same `mcp` backend id. Chosen over a transport
  branch inside `ChatRelayBackend` because the proxy path is shipped behaviour with ~300 assertions.
- `scripts/perplexity-browser-adapter.mjs` — loopback-only HTTP server (the Playwright side; the
  extension imports nothing from it, so `playwright-core` is not the extension's dependency).
- Commands: `/supervise mcp transport proxy|browser · adapter <http://127.0.0.1:port> · session
  <perplexity /session url>|clear · marker <text> · stable-ms <n> · max-wait <ms> · attempts <n>`, each
  validated at save time with the same rules `relayConfigIssues` applies.
- Defaults as shipped: `relayTransport "proxy"`, `browserAdapterUrl http://127.0.0.1:8731`,
  `browserSessionUrl ""`, `instructionMarker "NEXT AGENT INSTRUCTION"`, `browserStableMs 8000`
  (1500–60000), `browserMaxWaitMs 240000` (15000–1800000), `browserMaxAttempts 12` (1–100).

### Verification (offline only; re-run to trust)

- `npm run typecheck` exit 0. `npm run lint` exit 0 — **zero errors and zero warnings** (the two
  warnings seen mid-session were mine: an unused `private readonly` constructor param, and a
  `!adapter ||` chain BIOME flagged; both fixed by hand, not by blind autofix). `npm test` exit 0:
  **24 files passed | 1 skipped; 408 passed | 3 skipped** (up from 326 before this branch).
- New suites: `test/browser-client.test.ts` (22), `test/browser-config.test.ts` (16),
  `test/browser-backend.test.ts` (16), `test/browser-todos.test.ts` (10). The client suite binds a real
  loopback port and leaves it **unregistered** to prove the suite-wide default-deny guard covers this
  transport too (transportCalls unchanged, port never reached).
- Adapter refusals measured, each exiting 1: `--host=0.0.0.0`, `--host=192.168.1.5`,
  `--url=https://example.com`, `--url=not a url`, `--port=99999`, and the missing-dependency path.
- Two real defects found and fixed by the gate, not by review: a null-entry crash in
  `browser/todos.ts` (caught by its own junk-shape test) and a widened `mcpBackend` type that needed
  `?.dispose?.()` at both sites because the seam's `dispose` is optional.
- My own reporting bug, again: `echo "lint exit=$?"` after a pipe measured `tail`, not the linter.

### NOT verified (stated plainly)

- **`scripts/perplexity-browser-adapter.mjs` has never run against a browser.** It is a rewrite of the
  logic proven live in `~/ai/scratch/pw-probe/submit.mjs`; the selectors, the one-insertion/one-Enter
  submission, `[data-workflow-final-text]` extraction, `code.innerText` (not `pre`), and the
  stop-button-as-generating signal are carried over from that experiment, but this file is unproven.
- No live Perplexity request, no browser read, no chat write in this session. Live budget unchanged:
  1 of 3 attempts consumed on 2026-11-08 01:27Z, not bankable, no fresh authorization.
- Todo sourcing on the operator's actual worker host is undecided (see Observations).

## 2026-11-09 01:15Z — CORRECTION to the 00:57Z entry: the todo half DOES work on the operator's actual host

The 00:57Z entry concluded "on plain pi the todo half of the completion rule cannot be
satisfied… every browser run would end by operator stop." That was right about **pi 1.5.0** and
wrong about **this deployment**, because the worker is not a separate process: the relay dispatches
with `pi.sendUserMessage`, so the worker runs in the *same* Pi-Bolt session that holds the todo
list. The conclusion it fed was too pessimistic, and the claim it rested on — that a mutation-shaped
tool is unreadable, so the reader should refuse — was the part worth attacking.

Discovered by observation, from this session's own file
(`~/.pi/agent/sessions/--home-pseudobacon-ai-pi-supervisor--/…01a1b6ed….jsonl`, 3 664 entries,
58 `todo` calls):

- `role: "toolResult"` messages carry `toolName` and the tool's text; my first scan looked for a
  result *block* inside the content and therefore reported **zero** results. Wrong scan, not
  missing data.
- Pi-Bolt's built-in `todo` prints: `Created #1: <title> (pending)`, `Updated #1 (pending → completed)`,
  `No change: #12 already matches the requested values (status: completed)`, and `Cleared N todos`.
- A `todo list` result is a **full snapshot**: `[completed] #1 <title>` / `[in_progress] #2 <title> (activeForm)`.
- pi's shipped **example** extension is a different tool with different words (`Added todo #1: …`,
  `Todo #1 completed`, `Cleared 4 todos`) — grepping `examples/extensions/todo.ts` describes that
  one, not Pi-Bolt's, which is compiled into the bundle and not greppable as JS.

`src/browser/todos.ts` now reads three sources in order of authority — snapshot, status-bearing
call arguments, replay of mutation results — and still returns `null` for anything unrecognised,
including a single unparseable todo result line (half a history is worse than none). Tool *errors*
(`Error: id required for update`, validation failures, `not found`) deliberately neither change nor
poison a reading: they say nothing about the list.

Verification: `test/browser-todos.test.ts` **21 passed** (11 new, every string copied from the host's
recorded output rather than hand-written). Full gate re-run after the change: typecheck 0, lint 0,
`npm test` **419 passed | 3 skipped** (was 408), build 0.

Consequence for the product, stated precisely: **automatic completion can fire when the worker runs
under a host with a todo tool (Pi-Bolt here), and still pauses when it does not (plain pi 1.5.0,
where the tool simply does not exist).** The fail-safe direction is unchanged in both cases.

## 2026-11-09 10:00Z — FIRST FULL LIVE BROWSER-RELAY RUN. The loop ran end to end; two real bugs found and fixed; completion correctly REFUSED to fire.

Operator authorization for this session: full supervised run, operator-started Chrome, worker model = the only one served, prompt source = "I bootstrap the thread", session host = "I drive it over RPC". No further authorization sought or used beyond that.

### Environment, all measured

- Dedicated CDP Chrome: `scripts/launch-chrome.sh` → `Chrome/157.0.8103.38`, `user-data-dir ~/ai/scratch/pw-probe/profile`, CDP on 127.0.0.1:9333. Signed in (2 285 nodes, `New ⌃I` shell, no login words, `pplx.session-id` cookie).
- `playwright-core@1.65.0` installed `--no-save`; `package.json` and `package-lock.json` verified byte-identical afterwards (`M` status of both is pre-existing work, not this install).
- Adapter first-ever run: `connected to Chrome over CDP 9333` … `attached to … (0 turn nodes, composer ready)`; `/health` → `{"ok":true,"attached":true,"perplexityTabs":1}`.
- Harness: `scripts/live-run-driver.mjs` (RPC). Chosen because print mode cannot host a run (`src/index.ts` refuses print/json for start and resume), there is no tmux here, and `docs/rpc-commands.md` documents that RPC executes extension commands immediately. `{"type":"prompt","message":"/supervise …"}` → `disposition=handled`. The extension uses only `ui.notify`/`ui.setWidget` (71 + 3 sites) — no `select`/`confirm`/`input`/`editor` — so no RPC client response is ever awaited and nothing can stall.

### What the live thread proves, turn by turn

Thread `fb3326c7-7d6a-477b-9d86-232a15f823a0`, 3 user turns, 3 Perplexity queries.

1. Bootstrap ask (the marker convention stated IN the chat): answer came back with **one code block, label `text`, first line `NEXT AGENT INSTRUCTION`**. The carrier rule works on a real reply, and the label was `text` — the very value that killed the language-label rule.
2. `/supervise <instruction>` → `phase=starting → reviewing`, `lastDecision = steer: <instruction verbatim>`, `relayAttempts = None` → **the first instruction reached the worker with zero chat requests**. Criterion 2, live.
3. Worker run 1 (5 turns) → `/submit` attempt 1 → **504, paused**, "Enter was pressed once and will not be pressed again". Budget 1/4, no retry.
4. `/supervise resume` → attempt 2 → the new dedup returned "already the newest user turn — not sending it twice" → then the client rejected the `/wait` body: `protocol: adapter field "ok" is not a boolean`. Paused at 2/4.
5. After both fixes: attempt 3 → real write of the worker's report → answer block `NEXT AGENT INSTRUCTION Update README.md so its documentation accurately states that node hello.js prints Hello, World!` → dispatched. Worker run 2.
6. Attempt 4 → real write of report 2 → answer **152 chars, zero code blocks** → `paused`: `the chat gave no next instruction, but the worker's todo list could not be read, so completion was not automatic`.

Fixture verified independently of the state machine: `hello.js` prints `Hello, World!` + `\n` (confirmed by `od -c`), and `README.md:11` was updated to match.

### Two real bugs, both found only by running the thing

- **Confirmation by text equality is impossible for markdown.** The worker's report contains ``` fences, `**bold**` and inline code; a user bubble is RENDERED, so `**Change**`→`Change`, ```` ```diff ````→`diff`, and a second fence gains an inserted `text` chip. `sent 669 chars` vs `turn 639 chars`, plus a leading `09:47` timestamp. Exact and substring matching (even alphanumeric-folded) both fail. Fixed with an in-order **subsequence over word tokens**, which survives both lost punctuation and inserted labels.
- **`/wait` omitted `ok`.** `parseAdapterAnswer` requires it; the adapter and the contract were written separately, and the endpoint had been hand-checked with `curl`, which never validated the shape. Fixed, and the class is now pinned: `test/browser-live-wait.test.ts` feeds a real captured `/wait` body through the real validators and asserts that removing `ok` throws.

Also added, because the first bug would otherwise cause real damage on resume: **never send the same report twice**. A send can succeed while its confirmation fails, so `/submit` now checks whether the newest user turn already holds the text (same subsequence test) and returns ok without touching the composer. Proven live: attempt 2 reused the already-landed report instead of duplicating it.

### The completion rule, live

Perplexity signalled completion exactly as the convention says — by omitting the block. The run did **not** complete, because the worker never created a todo, so `countOpenTodos()` returned null and `decideCompletion()` refused to read "unreadable" as "nothing open". That is the designed fail-safe direction, observed rather than asserted: an finished-looking run ended at operator stop / ceiling, never on an inference. Whether that is the desired product behaviour is now an operator decision with live evidence in front of it.

### Offline, after the live run

Gate re-run: `build`/`typecheck`/`lint` exit 0 (lint zero errors, zero warnings), `npm test` **26 files | 1 skipped; 427 passed | 3 skipped** (from 419; new: `test/browser-live-fixture.test.ts` 5, `test/browser-live-wait.test.ts` 3).

## 2026-11-09 — completion rule corrected: the conversation contract decides, not the worker's todo list

The live run at 10:05Z completed its fixture task and relayed both ways, but it **ended in
`paused`, not `done`**. The chat had closed the thread exactly as the run's own convention
requires — a plain answer with no instruction block:

> "The task is complete: hello.js prints Hello, World! with a trailing newline, and README.md now
> documents that behavior accurately. Nothing remains open."

and the relay refused to accept that, reporting: *"the chat gave no next instruction, but the
worker's todo list could not be read, so completion was not assumed."*

### What was changed, and why

Per the operator's directive, completion for this mode is now decided by the conversation contract
alone. In `src/relay/instruction.ts`, `decideCompletion(picked, todos)` is gone; in its place:

- **`assessCapture(answer)`** classifies the reply as `complete` / `incomplete` / `unreadable`
  **before** its content is read. `incomplete` covers a still-generating page and any adapter that
  did not confirm the reply finished; `unreadable` covers an extraction that found nothing.
- **`decideConversationCompletion(picked, capture)`** returns `instruct` for one marked block,
  `ambiguous`/`empty` for a malformed one, and `complete` — carrying the reply's own text for
  display — for a confirmed reply with no block. Capture is checked first, so an unconfirmed reply
  can neither complete a run **nor** dispatch a block: a half-written instruction is worse than none.
- The todo requirement is removed from this gate entirely. `src/browser/todos.ts` still exists and
  the counts still appear, on the terminal outcome's `detail`, marked `(informational)`. A worker is
  not required to keep a todo list, and a host without a todo tool must not be able to prevent a
  conversation from ending.

Three findings came out of writing the tests, all of them real:

1. **`String.prototype.trim()` does not strip zero-width characters.** An extraction of `"\u200b"`
   was a *non-empty* answer, so under "no block means done" it would have **ended a live run on an
   answer that renders as nothing at all**. `assessCapture` now blanks `\u200b-\u200f\u2028\u2029\u2060\ufeff`
   before asking whether there is an answer, and the displayed reply is stripped the same way.
   Caught by a test written for the wrong reason.
2. **The test fake was masking the thing under test.** `withPage` re-wrapped every fixture answer in
   its own `answer()` helper, which defaulted `answerComplete` back to `true`. An explicitly
   unconfirmed answer became confirmed inside the harness, and the capture gate looked broken in a
   way it never was in production. The fake now passes fixtures through verbatim.
3. **Extraction could not be tested at all**, because it lived inside a `page.evaluate` closure. It
   is now `scripts/browser-page-probe.mjs` — a dependency-free `probePage()` the adapter hands to
   Playwright and the suite runs against a fixture DOM, so there is one implementation and two call
   sites. Reading it revealed `innerText` with no fallback; it now falls back to `textContent`, which
   is inert in a browser and what makes the offline test possible at all.

The adapter now reports `answerComplete` and means it: `true` only when its settle loop saw both
signals agree, `false` on timeout. `parseAdapterAnswer` leaves the field **absent rather than
defaulting it**, because "the adapter never said" and "the adapter says no" must stay distinguishable.

### Follow-up suggestions, proven excluded

`probePage()` clones the answer partition and strips buttons, links, `nav`/`aside`/`footer`/`header`,
media, and `*[class*=follow-up]` / `[data-testid*=follow]` / `[aria-label*=suggest]` containers
**before** reading text or blocks — the clone is what makes the endpoint non-mutating, and
`chromeSkipped` reports how much was excluded rather than asserting nothing was.

The new `test/browser-page-probe.test.ts` runs the real probe against a fixture shaped like the live
page, including a suggested follow-up whose text is literally `NEXT AGENT INSTRUCTION` and which
carries its own `<pre>`. It asserts that suggestion appears in neither `answerText` nor `blocks`,
that a copy button inside a code block never contaminates an instruction, and that an absent answer
partition yields `answerText: ""` — which `assessCapture` calls **unreadable**, never "a reply with
no block". jsdom is `--no-save` only, absent from `package.json`; without it the file **skips** (6
skipped, verified by moving the module aside) rather than failing.

### The historical payloads keep telling the truth

The two captured live responses predate `answerComplete`, so under the new gate they now **pause**.
That is asserted as history, not patched around: `test/browser-live-wait.test.ts` and
`test/browser-live-fixture.test.ts` each state that the verbatim 2026-11-09 payload is refused by
the capture gate, and that the same payload plus the confirmation the adapter now emits dispatches.

### Verification, all offline. No live request was sent in this segment.

```
$ npm run build      → exit 0
$ npm run typecheck  → exit 0
$ npm run lint       → "Checked 64 files in 41ms. No fixes applied." exit 0
$ npm test           → Test Files  27 passed | 1 skipped (28)
                        Tests  450 passed | 3 skipped (453)
```

The one skipped file is `test/live-mcp.test.ts`, gated on `PI_SUPERVISOR_ALLOW_LIVE_PROXY`. Local
state checked without sending anything: `8731` not listening (adapter down), `9333` still listening
(the operator's Chrome, left alone), branch `feat/pplx-mcp-supervisor` at `63dff13`, 56 dirty
entries, no commit made.

**Not verified:** that a real Perplexity reply carries `answerComplete` end-to-end through the
current adapter — the adapter was changed after the live run, and rerunning it was explicitly not
authorized. The offline chain is proven (probe → `/wait` body → `parseAdapterAnswer` →
`assessCapture` → `decideConversationCompletion`); the browser leg is not.

## 2026-11-09 — reproducibility fixed; read-only browser verification planned but NOT executed

### Reproducibility: jsdom is now a declared dependency, and the skip is gone

`package.json` declares `jsdom ^31.0.0` and `@types/jsdom ^30.0.0` in `devDependencies`
(`npm i -D`), and `package-lock.json` records both with `dev: true`. `@types/jsdom` is required
because the test imports jsdom statically and `npm run typecheck` must resolve it.

`test/browser-page-probe.test.ts` no longer detects a missing jsdom and skip. The guard is deleted;
the import is static. The reasoning is recorded in the file's header: those six assertions are the
only evidence that a suggested follow-up — including one whose text is literally
`NEXT AGENT INSTRUCTION` and which renders its own `<code>` — cannot reach the worker. A suite that
reports green while executing none of them is worse than one that fails. The only skipping file in
the suite is now `test/live-mcp.test.ts` (3 tests, gated on `PI_SUPERVISOR_LIVE_MCP=1`), confirmed
by grepping the whole `test/` tree for skip conditions.

Verified on a **lockfile-only** tree rather than the working tree, so the manifest cannot be hiding
an unsaved install. The repository was copied to `/tmp/clean-deps-check` excluding `node_modules`,
then:

```
$ npm ci                                              → exit 0        (proves lockfile ⇄ manifest)
$ node -e "require('jsdom/package.json').version"     → 31.0.0
$ npx vitest run test/browser-page-probe.test.ts      → Test Files 1 passed (1); Tests 6 passed (6)   [0 skipped]
$ npm test                                            → 27 passed | 1 skipped (28); 450 passed | 3 skipped
$ npm run typecheck / lint / build                    → exit 0 / exit 0 / exit 0
```

The working tree reproduces the same numbers (`450 passed | 3 skipped`, lint "Checked 64 files in
41ms. No fixes applied."). No commit; 56→57 dirty entries; `HEAD` still `63dff13`.

### Finding: `playwright-core` is not installed here, and the manifest does not declare it

`scripts/perplexity-browser-adapter.mjs:97` does `await import("playwright-core")`, but the package
is absent from this checkout's `node_modules`, from `package.json`, and from `package-lock.json`
(`grep -c playwright-core package-lock.json` → `0`). The adapter therefore **cannot start in this
checkout today**. It ran on 2026-11-09, so the package was present under some path that has since
gone; the prime suspect is the `npm i --no-save jsdom` run earlier in this session, since npm prunes
packages it considers extraneous — but the removal was not observed, and it is recorded here as
inference, not fact. `npm ls --depth=0` currently reports the jsdom tree as `extraneous` in the
working tree, which is consistent.

This is the adapter's own design (`scripts/perplexity-browser-adapter.mjs:14` says the adapter's
dependencies must never become the extension's), so the fix is a decision, not a default: declare
`playwright-core` as a devDependency here, or document and script a separate adapter install dir.
**No live browser step is possible until one of those is settled.** It is listed as a precondition,
not silently resolved.

### Audit of the read path, done because a "read-only" claim must be a read of the code first

Read of `scripts/perplexity-browser-adapter.mjs` and `scripts/browser-page-probe.mjs`, with line
numbers. What the capture path actually does:

- **Tab selection is strict and never by recency** (`:111`, `:127-138`): 0 Perplexity tabs →
  `no_perplexity_tab`; 2+ → `N_perplexity_tabs: close all but the one you want`; a pin whose id is
  not in the open tab's URL → `pin_unmatched`. But **with no pin it adopts the open session thread
  and only logs** (`:137`) — the arbitrary-conversation risk, so a pin is mandatory for any plan.
- **`locate()` raises the tab**: `await page.bringToFront()` (`:139`). Not navigation, not content —
  but it steals window focus, so "zero side effects" would be a lie. `/pin` always calls it;
  `/wait` calls it only when no page is pinned yet.
- **Nothing navigates or reloads.** `grep` for `goto(`, `reload(`, `keyboard`, `insertText`,
  `.click(`, `.fill(`, `requestSubmit` across both files: the only hits are `:327`, `:329`, `:340`
  — all inside `/submit`. The probe reads `scrollTop` but never writes it.
- **`/wait` is bounded, but its default bound is long**: `timeoutMs = 240_000`, `stableMs = 8_000`
  (`:351`), floored at `Math.max(5_000, maxWaitMs)`, polling every `SETTLE_POLL_MS = 500`
  (`:70`). So `stableNeeded = ceil(8000/500) = 16` identical reads — **a floor of ~8.5 s of reads
  even for an answer finished days ago**, and up to 4 minutes if the signals never agree. It is not
  an indefinite wait, but it must be bounded explicitly by the caller. `req.on("close")` aborts the
  loop (`:357`), so an abandoned client stops the polling.
- **`/wait` does not transmit `chromeSkipped`.** The probe computes it
  (`browser-page-probe.mjs:80`) and `/wait` builds its body field by field (`:360-374`) — the
  excluded-chrome count is dropped, and `parseAdapterAnswer` (`protocol.ts`) picks named fields, so
  a field the server omits can never arrive. The plan requires reporting excluded chrome, so this
  needs a one-line pass-through plus the protocol/type addition.
- **There is no per-request access log.** The handler logs some internal events but not each
  request line, so "we never called `/submit`" could only be asserted from discipline, not evidence.
- **`/disconnect` calls `browser.close()` (`:378`) with a comment claiming it closes the CDP
  connection, not the browser.** That is a comment, not evidence, and the thing at stake is the
  operator's own browser. It must be verified against a throwaway Chrome before it is ever run
  against the real one.
- Origin guard rejects any non-loopback `Origin` (`:278-280`); the server binds loopback and refuses
  `--host=0.0.0.0` (measured earlier, exit 1).

### Proposed read-only verification of the completed fixture conversation — **not executed**

Written up and handed to the operator for approval. Nothing in this segment touched the browser:
`8731` was already not listening and was not started; `9333` (the operator's Chrome) was observed
with a local `ss` only. Full plan text in `HANDOFF.md → Proposed read-only browser verification`.

Its essential shape: harden first (a `--read-only` mode that makes `/submit` unreachable at the
server, an access log, the `chromeSkipped` pass-through), then one `/pin` and one `/wait` with
`timeoutMs: 20000, stableMs: 4000`, then evaluate the saved raw JSON offline through
`assessCapture` → `decideConversationCompletion` in a vitest fixture, asserting `done`, zero
`/submit` lines in the access log, and zero worker dispatches because no Pi session is involved at
all. The expected closing text is compared **only** as a content-identity check; it is explicitly
never a completion signal — `answerComplete` must come from the probe's own signals (no stop control
on screen plus byte-length stability), and the report must say so.

**Explicit scope limit:** this checks **capture of an already completed answer**. It says nothing
about completion *detection during live generation* — that needs a turn that is streaming while we
watch, which this conversation cannot provide.

#### Lockfile side effect of that install — reported because it was not intended

`npm i -D` (npm 12.2.2, node v26.13.0) rewrote much more than the two added packages:
`git diff --stat` shows `package-lock.json | 4858 +++---`. Comparing the two lockfiles semantically:

```
packages before: 295  after: 324
version CHANGED for pre-existing packages (same path): 0
REMOVED: 1  → node_modules/@earendil-works/pi-coding-agent/node_modules/lru-cache  11.4.0
ADDED:  30  → jsdom's tree + @types/jsdom (+ its undici-types, tough-cookie types, etc.)
lockfileVersion: 3 -> 3
```

The one removal is a **re-resolution, not a dedupe**: `@earendil-works/pi-coding-agent` stays at
`1.5.0` (verified identical before and after) but its nested `lru-cache@11.4.0` is gone, replaced by a
hoisted `lru-cache@11.5.3`. That peer host is what `src/index.ts`, `src/host.ts` and `src/engine.ts`
compile against, so the bump landed inside the dependency subtree of the tested host — a patch-level
change I did not ask for and did not intend. The rest of the diff is reordering: metadata changed for
only two pre-existing entries (the root, and `undici`).

The clean-install verification above ran **against this lockfile**, so the tree the suite is green on
includes that bump. Pinning the old nested resolution would need an `overrides` entry, which is the
operator's call rather than something to do quietly. `package.json`'s own diff is 18 lines, most of it
pre-existing uncommitted work from earlier sessions plus these two devDependency lines.

## 2026-11-10 — offline/disposable hardening of the adapter (operator-approved scope; no Perplexity contact)

Approved scope was six items, all offline or against a throwaway browser. Nothing here navigated to
perplexity.ai, posted a message, ran the relay, or made a paid request.

### 1. `playwright-core` is now a declared runtime dependency

`package.json` → `"playwright-core": "^1.65.0"` in **dependencies** (the operator asked for a runtime
dependency; `npm i playwright-core`, npm 12.2.2 / node v26.13.0). Chosen because every API this
adapter uses — `connectOverCDP`, `browser.contexts()`, `context.pages()`, `page.url/bringToFront/
evaluate/locator().click()/keyboard.insertText/press` — is present and stable in 1.65.0.

Clean-install proof, and proof that no browser was fetched:

```
$ npm ci                                             → exit 0
$ node -e "require('playwright-core/package.json').version"   → 1.65.0
$ stat -c %y ~/.cache/ms-playwright/chromium-1248    → 2026-11-08 13:05:14   (unchanged; predates this work)
```
`playwright-core` never downloads browsers — that is the `playwright` package — and the cache
directory's mtime confirms nothing was fetched here. No `lru-cache` override was added: the
re-resolution reported earlier (the peer host's nested `lru-cache@11.4.0` → hoisted `11.5.3`) was
observed but never demonstrated to cause a problem, so per instruction it is left alone.

### 2. The adapter's decisions moved into a testable module

New `scripts/browser-adapter-core.mjs` holds `parseConfig`, `validateConfig`, `isPerplexityHost`,
`fingerprint`, `settleLoop`, `createApi`, `pinRef`. `perplexity-browser-adapter.mjs` keeps the
plumbing: flags, CDP connect, the page, the socket. It imports the core and hands it an `ops` object,
so **the router never touches a page** — which is what makes the safety rules assertable.

`validateConfig` returning a list of problems rather than calling `process.exit` turned seven
refusals that had only ever been verified by reading terminal output into code with tests:
non-loopback bind, non-perplexity `--url`, malformed URL, bad port, bad cdp, sub-50 ms poll,
`--read-only` without a positive `--max-read-ms`, and `--allow-host` outside loopback.

New settings, all named by `parseConfig` (the repo rule: an unnamed setting is silently dropped):
`--read-only`, `--max-read-ms`, `--ro-timeout`, `--ro-stable-ms`, `--allow-host`, `--log`.

### 3. Read-only mode

`--read-only`: `/submit` is rejected **at the router, above every `ops` call**; `/pin` and `/wait`
both require an exact conversation pin; `bringToFront` is suppressed (`raise: false`); reads start at
20 s / 4 s and are clamped to `--max-read-ms` (default 30 s), while normal mode keeps its historical
240 s / 8 s untouched.

`test/browser-adapter-core.test.ts` (25 tests) proves it with a fake `ops` that records every call:
a rejected `/submit` leaves **zero recorded calls**, not one `pin`, not one `settle`; the pin-less
`/pin` and `/wait` likewise cost nothing; a pin aimed at another host is refused before enumeration;
read-only passes `raise: false` and normal mode passes `raise: true` (so ordinary operation is
unchanged); the clamp is applied and reported in `bounds`.

### 4. Auditability

`/wait` now returns `chromeSkipped` — and **omits the field rather than inventing `0`** when a
probe did not report it. Request logging (`--log=<file>`, plus stderr) writes one JSON line per
request: timestamp, method, endpoint, outcome, status, and counts. Never a body, never answer text,
never a credential. A conversation id never appears raw: `pinRef()` hashes it to 8 hex chars.
One line per request is enforced by an `audited` marker, so the router's detailed line and the
transport's fallback do not double-record. `GET /health` exposes `counters.{submits,submitRejected,
captures,pins}`, so "no submission endpoint was invoked" is readable from a running adapter.

### 5. Disconnect: established from the implementation, then measured

The installed package (1.65.0 bundles everything into `lib/coreBundle.js`) was read rather than
trusted. Findings, with the file:line evidence:

- `Browser2.close` (64876-64889) only closes the connection when `_shouldCloseConnectionOnClose`
  is set, and that is set **only** by `browserType.connect()` (64934) — never by `connectOverCDP`.
- For `connectOverCDP` the close path reaches `browserProcess.close()`, which there is
  `{ close: doClose, kill: doClose }` (44969): `WebSocketTransport.closeAndWait` → `_ws.close()`
  (41420-41431) plus removal of **local** temp dirs (44952-44956). **No `Browser.close` CDP command
  is sent.** The only `Browser.close` send sites (45064-45067 chromium, 47776-47779 firefox) sit on
  `launch()`'s graceful-close path — killing a process Playwright spawned itself.
- The operator's context is `_defaultContext` with `browserContextId === undefined` (40173), so
  "close clears created contexts" (those are `disposeOnDetach: true`, 40202) does not reach it.
- **There is no `disconnect()` API** in the typings — only the `disconnected` event — so no
  "explicit safe disconnect" exists to use.

Therefore the adapter's `/disconnect` calls **nothing** on the browser: it schedules its own process
exit after the response flushes. Measured against a throwaway Chrome, twice:

```
/disconnect reports the browser was not touched   PASS  browserTouched:false
the adapter process exited                        PASS  exit 0
the operator-owned Chrome survived the teardown   PASS  alive before=true after=true
its tab survived, still on the fixture conversation PASS
measured: browser.close() on a connectOverCDP browser PASS  alive=true, tabs 1→1
```
That last line is the legacy operation, run deliberately against a **second** temporary profile, so
the old comment's claim is now backed by behaviour. It happens to have been correct — but the code
still does not rely on it.

**A real side effect the research surfaced, and it was fixed:** without `noDefaults`, connecting
sends `Browser.setDownloadBehavior { behavior: "allowAndName", downloadPath: <local tmp>,
eventsEnabled: true }` **browser-wide** (`CRBrowserContext.initialize`, 40400-40406; the default is
set at 53319-53320). Attaching to a browser was silently changing how that browser handles downloads,
for the whole browser and not just the tab. `connectOverCDP(..., { noDefaults: true })` now.

### 6. Stability is measured on content

`settleLoop` compares `fingerprint(answer)` — sha256 over the answer text **and every block's label
and content**, plus the generating flag — across consecutive reads, not byte length. The block
contents are in the hash because a code block is the only thing that may be dispatched, and its
content is what matters.

Regression, in both directions:
`"Hello, World!"`/`console.log(1)` vs `"Hello, World?"`/`console.log(2)` are the **same length** and
must not confirm — the test asserts the equal lengths, the differing fingerprints, and that the loop
returns `answerComplete: false` with `without both signals agreeing`. A second case holds the prose
and total JSON length fixed while `+one` becomes `-one`.

The distinction is kept where the operator asked for it: text stability plus no generation control
are **observed signals**; `answerComplete: true` means only that both agreed. The test
"never confirms while a generation control is on screen, however steady the text looks" pins the
silence-is-not-completion rule, and the detail string says so. No completion heuristic was broadened.

### Two regressions I introduced and a near-miss worth reading

1. **Restructuring `/submit` dropped two load-bearing guards.** Rewriting it into
   `ops.submit`, I lost the refusal to post while the page is still generating and, worse, the exact
   composer read-back that decides whether Enter is pressed at all — the control that stops a
   mistyped string becoming a message in the operator's thread. The file is untracked and I had
   edited it in place without a backup, so this was not diffable; it was recoverable only because a
   copy from a previous session happened to survive at `/tmp/clean-deps-check/`. Restored verbatim;
   seven guard strings are now asserted present in both copies. **Lesson: `cp` before editing an
   untracked file, and prefer a diff to a reconstruction.**
2. **Relocating the client-disconnect abort broke every `/wait`.** `req.on("close", …)` was moved to
   the top of the handler. Node emits `close` on a request as soon as its body is consumed
   normally, so the settle loop was aborted 4 ms in. The original placement — after the body read —
   was load-bearing by accident. Fixed by watching the **response** and aborting only when
   `!res.writableEnded`. Found by the disposable-browser run in 4 ms; no unit test would have caught
   it, which is itself the argument for the browser check.

### Verification, all offline or disposable. Gates re-run, not repeated.

```
$ npm run build / typecheck / lint   → exit 0 / exit 0 / exit 0 ("Checked 65 files … No fixes applied.")
$ npm test                           → Test Files 28 passed | 1 skipped (29); Tests 475 passed | 3 skipped
$ node scripts/verify-adapter-disconnect.mjs                    → 25/25 checks passed
$ (same script, in a fresh npm ci tree)                          → 25/25 checks passed
$ offline refusal sweep (7 configurations)                       → all refused, from validateConfig
```

The 25 checks ran against a headless Chrome 157 on a temporary `--user-data-dir` under `/tmp`,
served by a loopback fixture page, on ports 9344/9345/8744 — never the operator's profile, never
CDP 9333, never an adapter on 8731. They cover: real-DOM extraction (`chromeSkipped=2`, the copy
button stripped from the extracted block, the suggested follow-up outside the partition absent from
the answer), `answerComplete=true` from `stableReads=3/3` with `generating=false` — from the
**signals**, never from matching expected text — the `/submit` refusal with `counters.submits=0`, the
page never reloaded (`__bootId` unchanged) and its composer untouched, the audit log carrying no body
and no raw conversation id, and teardown leaving Chrome and its tab alive.

Two of those checks exist because of a past incident: the `/wait` body is now also fed through the
extension's own `parseAdapterAnswer` (`answerComplete` survives the protocol boundary), since the
live run of 2026-11-09 was lost to exactly a mismatch between these two files.

**Not verified:** any contact with perplexity.ai; the live extension→adapter path end to end (the
extension was never started); real signed-in page behaviour. The plan in `HANDOFF.md` remains
unexecuted and awaits approval.

## 2026-11-11 14:55–15:20Z — read-only capture: approved, attempted, stopped before `/pin`

**Authorization.** The operator approved executing the proposed read-only capture exactly once, with no
implementation changes as part of the run: target the existing fixture conversation via CDP 9333, pin the
exact URL, `GET /health` → `POST /pin` → one bounded `POST /wait` → save the raw response before reading
it → counters while running → `POST /disconnect` → offline evaluation through
`parseAdapterAnswer → assessCapture → extractMarkedInstruction → decideConversationCompletion` → audit
inspection. No typing, clicking, focus changes, navigation, refresh, submissions, worker dispatches, or
new Perplexity requests; no browser or tab closed. "If any precondition or assertion fails, stop and
report the captured evidence. Do not retry, repair code, select another tab, or send a message." The
outcome wording was fixed in advance: **pass ⇒ "Real-browser capture of an already-completed answer
verified"**, never "live end-to-end automatic completion verified".

**Precondition 1 — the target was not unambiguous, so the run did not start.** Reading the local DevTools
target list (`http://127.0.0.1:9333/json/list` — a list query; no CDP session, no `page.evaluate`, no
navigation, no focus change) showed exactly one Perplexity page target:

    page targets: 1   perplexity.ai page targets: 1
      URL: https://www.perplexity.ai/session/4913f532-66e6-48f2-96cb-927dc70f5643

That is **not** the conversation the expected reply belongs to, which three documents name as
`fb3326c7-7d6a-477b-9d86-232a15f823a0` (`HANDOFF.md:202`, `:267`, `DEVELOPMENT-LOG.md:1311`). The open id
occurs in this repo only as a config fixture string (`test/browser-config.test.ts:45`), which is not
evidence about today's tab. Per the operator's rule ("ask me for it … do not infer the target from tab
recency") the run was not started.

**Precondition 2 — read-only mode would have changed focus once.** `server.listen` auto-attaches with
`locate(null)`, whose `raise` defaults to true → `page.bringToFront()` (`perplexity-browser-adapter.mjs:178`,
`:192`). `/pin` and `/wait` had been suppressed; the startup path had not. The operator authorized a
one-line fix (`raise: !CONFIG.readOnly` when read-only) and, having switched the tab to `fb3326c7…`, chose
"fix the identifier, re-run once".

**The authorized fix was defective, and the live run is what said so.** I wrote `{ raise: !readOnly }`;
in that file the setting is `CONFIG.readOnly`, so building the argument object threw. Adapter log, 14:57:

    14:57:23 READ-ONLY: /submit is refused before any page is located; no bringToFront; reads clamped to 30000ms
    14:57:24 connected to Chrome over CDP 9333 (browser version 157.0.8103.38)
    14:57:24 listening on http://127.0.0.1:8731 — target https://www.perplexity.ai/session/fb3326c7-…
    14:57:24       will attach on first /pin: readOnly is not defined
    14:57:29 AUDIT {"t":"2026-11-11T14:57:29.739Z","m":"GET","e":"/health","outcome":"ok","attached":false,"tabs":1}
    14:57:29 SIGTERM: unhooking. Tabs are left open, exactly as they were.

The throw happened *before* `locate()` ran, so there was **no attach, no read, no `page.evaluate`, no
`bringToFront`** — zero page interaction. The adapter refused to guess instead of attaching elsewhere.
Post-mortem: audit log one line (`GET /health` only), counters all zero, adapter gone by its own path,
port 8731 closed, Chrome up with one page target at the pinned URL. A `pgrep -f "perplexity-browser-adapter.mjs"`
report of "STILL RUNNING" was pgrep matching its own command line — `ps` showed no such process.

**Attempt 2 (after the identifier fix and a re-gate) stopped on my assertion, not the adapter.** With the
tab precondition re-verified (one page target, URL exactly the pinned one), the adapter attached cleanly:

    {"ok":true,"readOnly":true,"attached":true,"url":"https://www.perplexity.ai/session/fb3326c7-…",
     "threadNodes":7,"perplexityTabs":1,"counters":{"submits":0,"submitRejected":0,"captures":0,"pins":0}}
    …       attached to https://www.perplexity.ai/session/fb3326c7-… (7 turn nodes, composer ready)
    …       no pin supplied — adopting the open thread https://www.perplexity.ai/session/fb3326c7-…

and my driver aborted at `STOP: submits not zero at start` because it read `.submits` instead of
`.counters.submits`. The printed payload above plainly shows `submits: 0`. Stopped, no `/pin`, no `/wait`;
survival re-checked (Chrome up, one page target, exact URL).

**Finding: `--url` pins the requests, not the startup attach.** `--url` becomes `TARGET` and the required
pin for read-only `/pin`/`/wait`, but `locate(null)` at startup adopts whichever single `perplexity.ai`
tab is open and merely logs `no pin supplied — adopting the open thread` (`:189`). Had the open tab been
another conversation, that one would have been read while the log named my pinned URL. **Open.** Not
touched (outside the approved scope); a per-run guard is to assert `/health.url` equals the exact pinned
URL before `/pin`.

**Finding: the suite cannot see this class of defect.** `scripts/` is untracked and the adapter script is
not importable, so `ReferenceError: readOnly is not defined` survived a fully green gate
(`build`/`typecheck`/`lint` exit 0, **475 passed | 3 skipped**, measured before and after the fix). A green
suite is not evidence that the adapter starts.

**Offline preparation for the next attempt, after the operator chose "document only".** Shapes were taken
from source, not memory: `/wait` request keys are `pin`/`timeoutMs`/`stableMs` (**`readTimeoutMs` is
ignored silently** — the bound my aborted driver claimed would have been fiction), `/pin` answers
`{ok,url,threadNodes,composerReady,detail,readOnly}`, `/health` answers
`{ok,readOnly,counters,url,threadNodes,attached,perplexityTabs}` with `attached` a boolean and `submits`
nested. `/wait` answers `{ok,answerComplete,answerText,blocks,status,generating,distanceFromBottom,
stableReads,stableNeeded,chromeSkipped?,fingerprint,turnId,detail,bounds,pinnedUrl}`. The chain lives in
`src/browser/protocol.ts` (`parseAdapterAnswer`, `toReplyBlocks`) and **`src/relay/instruction.ts`**
(`assessCapture`, `extractMarkedInstruction`, `decideConversationCompletion`); `tsconfig outDir` is
**`dist/`**, so the plan's `build/…` is not a real path. Verdict vocabulary is
`instruct|complete|stalled|ambiguous|empty` and capture state `complete|unreadable|incomplete`; the plan's
old `done`/`terminal` wording is superseded in `HANDOFF.md`.

A Phase-B evaluator was written and **proven non-vacuous on synthetic payloads shaped from the source**:
clean → all criteria PASS; and each of wrong answer text, a marked block present, `answerComplete:false`,
a malformed block (`parseAdapterAnswer` **throws**), and an injected `/submit` audit line → the expected
criteria FAIL. The malformed-block case initially printed a stack trace instead of a report, so the
pipeline was wrapped — a throw must still yield evidence. One variant was initially mislabelled "F /submit
in audit" while its mutation was a no-op; relabelled and re-run for real, which is when it was shown to
catch the injection.

**Deliberately not done.** The capture itself. After the second stop the operator instructed
**"Hold the capture; document only"**, so no adapter was started again; no `/pin`, `/wait`, or `/submit`
was ever served this session, and no Perplexity request was made. Nothing was committed. The focus
guarantee is proven **statically** (`bringToFront` is reachable only behind `raise`, which read-only answers
`false` at all three call sites) and **not** re-measured live.

**State.** Branch `feat/pplx-mcp-supervisor`, HEAD `63dff13 add tests`, 57 dirty entries, nothing
committed. Files changed this segment: `scripts/perplexity-browser-adapter.mjs` (the focus fix and its
identifier), `HANDOFF.md`, `DEVELOPMENT-LOG.md`. Artefacts (ephemeral, under `/tmp`): run dirs
`/tmp/capture-145723`, `/tmp/capture-3KEwF4`, drivers `/tmp/phaseA.sh` (record-only) and `/tmp/phaseB.mjs`,
auditor `/tmp/tabs.py`, backups `/tmp/HANDOFF.pre-edit.md` and `/tmp/LOG.bak`. The operator's Chrome and
its single tab at `…/session/fb3326c7-…` are open and untouched; port 8731 is closed.
