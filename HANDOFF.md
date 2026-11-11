# Goal

`pi-supervisor` supervises a Pi coding agent through a supervisor backend:

- **`model`** (shipped, untouched) — a supervisor LLM in this process, reviewing mid-run
  and end-of-run over pi's own model API.
- **`mcp`** (the active work) — a **literal text relay** between an existing Perplexity
  conversation and the Pi worker. The operator obtains the initial coding prompt from a
  Perplexity chat and supplies both that prompt and a reference to **that same conversation**,
  using the proxy's real conversation mechanism. The extension sends the initial prompt to the
  worker **directly, verbatim** (zero Perplexity requests, no intro, no new conversation).
  After each normally completed worker turn, the worker's final output text is sent **as-is**
  as the next user message in the attached chat; Perplexity's completed reply is submitted
  **as-is** as the worker's next instruction; repeat. Nothing is added to either side's text:
  no headers, personas, schemas, goal reminders, or tool context. This replaced the earlier
  "extension-initialized relay" design (intro template, minted `pi-sup-*` conversation,
  `Local coding agent result:` header, unconditional marker parsing) — see `DEVELOPMENT-LOG.md`
  → 2026-11-08 02:09Z.

**Route A ACCEPTED (operator, 2026-11-08): "I accept 5.2 exposure."** The relay's Perplexity
transport is a **browser adapter** on a dedicated, operator-launched, operator-logged-in
Chrome profile driven by Playwright over CDP — it continues the **exact existing web-app
conversation**. Requirements B/C (proxy-conversation, manual bridge) are closed as the chosen
route. The operator accepts the ToS §5.2(i) category exposure (the proxy already operates
there). Memo + six-option comparison: `DEVELOPMENT-LOG.md` → 09:44Z; the accepted contract
and the four sub-decisions: → 10:21Z.

**The accepted loop.** (1) The operator chats in the web app; that chat yields a prompt.
(2) `/supervise start <prompt>` — pasted **verbatim**, **zero browser reads at start**.
(3) The worker runs to a stop with a result. (4) The result is posted into the pinned chat
**as is** — no wrapper, no prompt. (5) Wait for the thread's reply; the next
instruction is the **code block whose first line is the instruction marker** (default
`NEXT AGENT INSTRUCTION`, set by `/supervise mcp marker <text>`); language is ignored, because
Perplexity would not honour a `prompt` label. That block alone is dispatched — the reply's other
code blocks and all of its prose are not. (6) Loop. **Completion = no marked block AND no
`pending`/`in_progress` todo** — never inferred from prose, and a todo list that cannot be read
is *not* an empty one. Supersedes `[[SUPERVISOR: COMPLETE|STOP]]` and `[[PPLX_DONE]]` here.

**Hard environment constraint.** Chrome **157.0.8103.38** here, and from **Chrome 136**
`--remote-debugging-port` is **ignored on the default user-data dir** — so CDP attach to the
everyday profile is impossible by design; the dedicated `--user-data-dir` profile is
**mandatory**, not a preference (its own encryption key also means it cannot read the real
profile's cookies). Requirement A holds only because Perplexity threads are account-scoped
server-side — same account ⇒ same threads — **to be confirmed by the probe, not assumed**.
Record: `DEVELOPMENT-LOG.md` → 10:21Z.

Acceptance criteria for the current phase:

1. Attachment is validated against the proxy's actual capability before anything dispatches;
   an unattachable conversation fails visibly (proxy route; the browser route's attachment
   check is tab pinning + read-back validation). *Investigated (see Blockers 1); not implemented.*
2. Exact-message relay: initial prompt → worker verbatim with zero requests; worker final
   text → next chat input without additions; chat reply → next worker instruction without
   additions. ***Browser route: implemented and tested offline*** — 16 backend assertions,
   including `initial` making zero transport calls and an empty worker result pausing without
   sending. *The proxy route still carries the superseded flow.*
3. Completion follows the conversation, and never prose or a todo list. ***Implemented*** as
   `assessCapture()` → `decideConversationCompletion()` in `src/relay/instruction.ts`: the reply
   must first be confirmed complete and non-blank (zero-width-aware), then one marked block
   dispatches, its absence completes, and every other shape pauses. Todo counts survive only as
   `(informational)` text on the terminal outcome.
4. The extension compiles and runs against the Pi 1.5.0 host. *Offline-verified (gate +
   hermetic host smoke test).*
5. A live end-to-end relay run within an operator-approved budget. ***Achieved on the browser
   route*** (2026-11-09, 3 Perplexity queries, 4/4 adapter attempts): bootstrap instruction in a
   marked block → worker (0 requests) → report posted → README instruction read from the block →
   worker → report posted → closing answer with **no block** → fixture verified by `od -c`.
   It then paused **on a gate that should not have existed** (a todo list the worker never
   created), not for any defensible reason. That gate is removed; see `Reliability findings`.

6. **Closed — what ends a browser run** (operator directive, 2026-11-09). For the configured
   instruction-block mode: one valid `NEXT AGENT INSTRUCTION` block → dispatch it; a **confirmed**
   reply with no block → complete, and show the reply; anything unconfirmed, unreadable, empty of
   real text, ambiguous or malformed → pause with a specific reason. `assessCapture` runs before
   the block is read, so an answer the adapter did not vouch for can neither end the run **nor**
   dispatch a half-written instruction. The worker's todo list is not an input to this decision.
   *The proxy route has never had a successful live run; its one approved attempt failed at launch.*

# Conversation-attachment reality (pplx-proxy, verified 2026-11-08)

All line numbers are `~/ai/pplx-proxy/server.py` as of 2026-11-08. Full record:
`DEVELOPMENT-LOG.md` → 2026-11-08 02:09Z.

- **The proxy can continue only conversations that ran through its own `POST /v1/responses`
  with a stored response** (`store` not `false`). Attachable ids: `resp_*` response ids and,
  if one was supplied originally, the `conversation` id (record shape `1669`, store 1307-1353).
- **Strict form — `previous_response_id`**: unknown id → **404** `No model response found`
  (1547); continues by replaying the stored `_history_messages` (1550). Mutually exclusive
  with `conversation` (400, 1532). This is the only safe continuity mechanism.
- **Permissive form — `conversation`: an unknown id silently starts a fresh history**
  (1540-1542 returns no error). It must never be trusted to prove attachment.
- **Zero-cost attachment check exists**: `GET /v1/responses/{response_id}` (2247-2252) is a
  pure store read — API key, no Perplexity call, no quota — 404 when absent.
- **Not attachable, by any means**: a **Perplexity.ai web-app chat** (no request field accepts
  a Perplexity thread/backend uuid — `follow_up_uuid` comes only from the proxy's internal
  in-memory history-hash session cache, 307-343/1587, disabled by any system message, lost on
  restart); chats made through the proxy's `/chat` debug UI (2441-range handler, `static/
  chat.html:280`) or any `/v1/chat/completions` client — stateless, the store is never written
  (verified: no `_responses_put` call in the chat-completions path), so no id is ever issued.
- **Lifetime**: stored responses expire at 7 days (`_RESPONSES_MAX_AGE`, 1305) or 300 entries
  (1304); persisted at `DATA_DIR/.responses_store.json` (1353), so attachment survives proxy
  restarts but not expiry/eviction.
- **Additions (verified 2026-11-08 09:44Z)** — upstream is the web service: `PPLX_BASE` (349)
  `https://www.perplexity.ai`, SSE ask endpoint (350), authenticated with the operator's web
  session cookie (50, 106-115) — the proxy is a web-service reverse proxy, **not** a client
  of the official API. The web service's continuity token `backend_uuid` arrives only in the
  proxy's own SSE streams (846-847) and is stored keyed to the proxy's own history
  (307-340, 726); **no field or endpoint accepts a foreign conversation id or
  `backend_uuid`** — a conversation-aware proxy tool can only continue proxy-originated
  conversations, never a web-app chat. `/v1/chat/completions` (2441+) has no conversation/
  session parameter and never writes the store; the proxy's own `/chat` UI
  (`static/chat.html:280`) speaks it, so it cannot drive a `/v1/responses` conversation. The
  proxy's MCP tools (2902-2978: `perplexity_ask`, `perplexity_reason`, `perplexity_research`,
  `perplexity_models`) are stateless one-shot with no conversation parameter. Perplexity web
  ToS: "These terms do not cover the separate Perplexity API"; §5.2(i) prohibits "any
  robot, spider, crawlers, scraper, or other automatic device, process, software or queries
  that intercepts, 'mines,' scrapes, extracts, or otherwise accesses the Services," except
  under applicable law or written permission; the API is governed by its own ToS + AUP.
  Playwright (documented, no test performed): `connectOverCDP` attaches to a running
  Chromium browser and exposes its existing logged-in context and tabs; Playwright MCP
  offers `--cdp-endpoint` and `--extension` attach modes and states an attached browser is
  "not a security boundary." Record: `DEVELOPMENT-LOG.md` → 2026-11-08 09:44Z.

# Branch and working tree

- Branch `feat/pplx-mcp-supervisor`; HEAD `63dff13 add tests`.
- The tree is deliberately dirty: 57 `git status` entries — 13 modified, 44 untracked (the whole of
  `scripts/` is untracked, which matters every time the adapter is rewritten; see `Reliability
  findings` 10). Work of this
  project, including `src/relay/`, `src/backends/`, `src/mcp/`, and this documentation).
  Nothing is committed, staged, or pushed. Do not commit, amend, push, or tag unless asked
  in those words; uncommitted work is not to be discarded.
- Untracked `.supervisor-smoke/` is excluded by `vitest.config.ts`, not deleted.
- Working-tree and environment history is in `DEVELOPMENT-LOG.md`.

# Implementation and supported versions

**Adapter seams (added 2026-11-10).** `scripts/browser-adapter-core.mjs` holds every decision
(`parseConfig`, `validateConfig`, `fingerprint`, `settleLoop`, `createApi`, `pinRef`) and touches no
page; `perplexity-browser-adapter.mjs` is the composition root that supplies `ops` (`status`, `pin`,
`ensureAttached`, `settle`, `submit`, `teardown`) over the real CDP page;
`browser-page-probe.mjs` is the DOM read shared by the page and the jsdom tests;
`verify-adapter-disconnect.mjs` proves the safety claims against a throwaway Chrome. Flags:
`--read-only`, `--max-read-ms`, `--ro-timeout`, `--ro-stable-ms`, `--allow-host` (loopback fixture
only), `--log`. New tests: `test/browser-adapter-core.test.ts` (25), `test/browser-page-probe.test.ts` (6).

- Supported peer dependencies are exactly **1.5.0**: `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`; plus `pi-agent-core 1.5.0`,
  `typebox 1.3.27`, `@modelcontextprotocol/sdk 1.32.2`. The host is the **pi-bolt 1.5.0**
  build (deployed 2026-11-07 15:51); extension and host agree on 1.5.0. The `pi` npm
  binary (1.3.0) is a different, unused host. Migration record: `DEVELOPMENT-LOG.md` →
  2026-11-08 00:30–00:50Z.
- **Two transports, one loop.** `relayTransport` chooses between them and defaults to `proxy`;
  only the exact string `"browser"` opts in, so a typo cannot silently select the transport that
  types into a live chat. Browser route: `src/browser/` (`protocol.ts`, `client.ts`, `todos.ts`)
  + `src/backends/browser-backend.ts`. Proxy route: `src/backends/relay-backend.ts` + `src/relay/`,
  which **still implements the superseded design** (intro template, minted `pi-sup-*` ids, the
  `Local coding agent result:` header, unconditional `[[PPLX_DONE]]` parsing) and is still fully
  tested against that old contract. Separate classes rather than an `if (transport)` branch inside
  one: the proxy path is shipped behaviour carrying ~300 assertions, and interleaving them is how
  one gets quietly changed while the tests exercise the other. Both keep the persisted backend id
  `mcp`; only the label differs.
- `scripts/perplexity-browser-adapter.mjs` holds the Playwright side. **The extension imports
  nothing from it** — it speaks HTTP to loopback, so `playwright-core` never becomes the
  extension's dependency (it is installed `--no-save`, leaving `package.json` and the lockfile
  untouched). It refuses to bind off-loopback and refuses a non-perplexity.ai URL. Proven live
  2026-11-09, including the write path. Two things it does that are easy to overlook and are
  load-bearing: a submitted message is confirmed by an **in-order subsequence over word tokens**
  (a user bubble is rendered, so `**bold**`/fences/language-chips make equality and substring
  tests both fail), and `/submit` **refuses to send text that is already the newest user turn** —
  because a send can succeed while its confirmation fails, and a retry would duplicate a report
  in the operator's thread.
- `scripts/live-run-driver.mjs` hosts a run over RPC (`--mode rpc`, `--continue` for `--resume`)
  and always ends with `/supervise stop` at its wall-clock cap rather than leaving a live session
  holding a browser thread. Needed because print mode cannot host a run and there is no tmux here.
- Revised relay invariants (stable rules now in `AGENTS.md`):
  - Initial supplied prompt → worker verbatim; zero Perplexity requests before the first
    worker result; never relay the initial prompt back to Perplexity; no intro injection.
  - Attachment: operator-supplied seed; strict `previous_response_id` chaining; zero-cost
    `GET /v1/responses/<seed>` validation before dispatch; unknown/expired seed fails visibly;
    never fall back to a new conversation, never claim continuity from a locally minted id.
  - Worker final text → chat as the plain user-message string (no `{"query": …}` JSON);
    empty final output → pause, never synthesize. Chat reply → worker instruction as-is
    (only the proxy-appended quota notice is stripped — a proxy artifact, not chat text).
  - **Completion is never guessed from prose.** Until a convention is explicitly selected:
    manual `/supervise stop` + the existing ceilings (iterations, elapsed minutes, worker
    runs). Options for later explicit selection: operator stop / a terminal convention already
    agreed in the original chat / a separately configured mechanism. If markers are enabled,
    removing the terminal marker is the one documented exception to verbatim.
  - **Preserved safety** (all still required): strictly local `status`/`stop`; pauses on
    interruption, error, and empty output; cancellation and stale-response protection; the
    persisted request-attempt budget checked and spent before every send (a mid-run 404 from
    a broken chain pauses, never reseeds); worker-run and elapsed-time ceilings; the default-deny
    network guard (the new attachment GET goes through it too); permission gates.
- `src/backends/mcp-backend.ts` + `src/mcp/prompt.ts` (the JSON-decision evaluator) remain
  in the tree, tested, but **unwired** to `/supervise`. Keep-or-delete is an open decision.

# Verification (latest)

Reconciled 2026-11-08 after the product correction. These are recorded results — re-run the
gate before trusting them (`npm run typecheck && npm run lint && npm test && npm run build`).

**Live (browser transport, 2026-11-09, operator-authorized) — the relay worked; completion did not.**
Two-way relay and the fixture task **succeeded** in thread `fb3326c7-7d6a-477b-9d86-232a15f823a0`:
bootstrap instruction → worker → report into the thread → Perplexity's instruction → worker; checked
independently of the state machine (`hello.js` prints `Hello, World!\n` via `od -c`, `README.md:11`
updated, 3 user turns). The run then **ended `paused` instead of `done`**: the chat closed with
"The task is complete: … Nothing remains open." and no code block — the agreed signal for finished —
but the gate required an unopenable todo list. That gate has since been removed (see
`Reliability findings` below); full record in `DEVELOPMENT-LOG.md` → 2026-11-09.

**Offline (no live requests, no browser action) — most recent first:**
- 2026-11-11 15:12Z (latest): **the read-only capture was approved, attempted twice, and stopped before
  `/pin` both times — it is NOT performed.** `build`/`typecheck`/`lint` exit 0 · `npm test` **475 passed |
  3 skipped** (before and after the one adapter fix). One real adapter defect was found and fixed: the
  authorized focus fix used a bare `readOnly` instead of `CONFIG.readOnly`, so the startup attach threw
  `ReferenceError: readOnly is not defined` — and the adapter's own log is what revealed it
  (`will attach on first /pin: readOnly is not defined`). Both stops were caused by the *driver*, not the
  adapter; the operator then chose **document only**, so no adapter start happened after 15:03Z.
  Zero Perplexity traffic; port 8731 closed; the operator's Chrome stayed up with its one tab at the exact
  pinned URL. Full record: `DEVELOPMENT-LOG.md` → 2026-11-11, and `Reliability findings` 12–13.
- 2026-11-10 04:01Z (latest): **offline/disposable hardening of the adapter.** `build`/`typecheck`/`lint`
  exit 0 ("Checked 65 files… No fixes applied.") · `npm test` **28 passed | 1 skipped (29); 475 passed |
  3 skipped** · `node scripts/verify-adapter-disconnect.mjs` **25/25**, and **25/25 again in a fresh
  `npm ci` tree** · a 7-configuration refusal sweep all refused. `playwright-core ^1.65.0` is a declared
  runtime dependency; the browser-cache mtime (`2026-11-08 13:05`) proves nothing was downloaded. Every
  check ran against a headless Chrome 157 on a temporary profile and a loopback fixture page on ports
  9344/9345/8744 — never a signed-in profile, never CDP 9333, never perplexity.ai.
  Detail: `DEVELOPMENT-LOG.md` → 2026-11-10.
- 2026-11-09 13:52Z: **lockfile-only reproduction.** The repo was copied to
  `/tmp/clean-deps-check` excluding `node_modules`, then `npm ci` exit 0 (which is itself the
  manifest⇄lockfile check) · `test/browser-page-probe.test.ts` **6 passed, 0 skipped** · `npm test`
  **27 passed | 1 skipped (28); 450 passed | 3 skipped** · `typecheck`/`lint`/`build` exit 0.
  `jsdom ^31` and `@types/jsdom ^30` are declared devDependencies now, and the probe suite's
  missing-jsdom skip is **deleted** — those six assertions can no longer vanish silently. The only
  skipping file left is `test/live-mcp.test.ts` (3 tests, `PI_SUPERVISOR_LIVE_MCP=1`).
  **Side effect worth knowing:** that install rewrote 4858 lockfile lines. Semantically: 0 version
  changes at the same path, +30 packages (the jsdom tree), and `@earendil-works/pi-coding-agent`
  unchanged at `1.5.0` but its nested `lru-cache@11.4.0` re-resolved to a hoisted `11.5.3` — inside
  the subtree of the peer host the extension compiles against. The green clean-install run above used
  that lockfile, so it is verified; pinning the older nested version needs an `overrides` entry, which
  is the operator's decision. Detail: `DEVELOPMENT-LOG.md` → "Lockfile side effect of that install".
- 2026-11-09 10:34Z (the completion-rule fix): build/typecheck/lint exit 0 · `npm test` exit 0,
  **450 passed | 3 skipped**. At that point jsdom was an unsaved install and the probe suite skipped
  itself when it was missing — superseded an hour later by declaring the dependency and deleting the skip.
- 2026-11-09 01:15Z: build/typecheck/lint exit 0 · `npm test` exit 0,
  **26 files passed | 1 skipped; 427 passed | 3 skipped**.
  The skipped file is `test/live-mcp.test.ts`, gated on both `PI_SUPERVISOR_LIVE_MCP=1` and
  `PI_SUPERVISOR_ALLOW_LIVE_PROXY=1`.
- The browser suites are hermetic; the client suite binds a real loopback port and deliberately
  leaves it **unregistered** with the guard, proving the default-deny covers this transport
  (transport calls unchanged, port never reached).
- Adapter refusals measured, exit 1 each: `--host=0.0.0.0`, `--host=192.168.1.5`,
  `--url=https://example.com`, a non-URL, `--port=99999`, and the missing-`playwright-core` path.
- Earlier, before this route existed (2026-11-08 01:58Z): 326 passed | 3 skipped. Those tests
  encode the proxy route's OLD contract and still pass.
- `npm run typecheck`, `npm run lint` (one pre-existing warning), `npm run build`: exit 0
  against pi-coding-agent 1.5.0.
- Network guard: default-deny on all outbound `fetch`, **loopback included**; 12 isolation
  tests prove it on both real transport paths. Scope: `fetch` only — not a network sandbox.
- Host-integration smoke (2026-11-08 00:49Z, hermetic, zero inference): exit 0; 1 provider
  hit; 1 relay hit (within the 3-attempt budget, persisted as `relayAttempts: 1`);
  `[[PPLX_DONE]]` → `phase: done`; nine `supervisor-state` entries persisted.

**Live:**
- One approved attempt (2026-11-08 01:27Z): exactly one `POST /v1/responses` (200 OK);
  **zero completed worker runs**; failed at launch because host print mode cannot host a
  `/supervise` run. Root cause was a harness error, not the product. Full record:
  `DEVELOPMENT-LOG.md` → 2026-11-08 01:27Z.

# Authorization and live-request budget

- The operator approved a live test with a budget of **3 total** `/v1/responses` attempts
  (failures, timeouts, and redirects count; no replenishment).
- **1 of 3 attempts was consumed** by the 2026-11-08 01:27Z launch attempt. The remainder
  is **not bankable** — the budget is per-run.
- **Browser route, consumed 2026-11-09:** 3 Perplexity queries in thread
  `fb3326c7-7d6a-477b-9d86-232a15f823a0` (1 bootstrap + 2 worker reports) and **4 of 4**
  `browserMaxAttempts`, all spent in that one session; one of those attempts produced no query
  because the send was deduplicated. No replenishment — the counter is persisted per run.
- **2026-11-10 hardening sent nothing** and reached no browser of the operator's. Every check used a
  headless Chrome on a temporary `--user-data-dir` under `/tmp`, a loopback fixture page, and ports
  9344/9345/8744. `9333` (the operator's CDP) and `8731` were never connected to, and no Perplexity
  origin was contacted. That plan was approved and attempted on 2026-11-11 and remains **not completed**.
- **This segment (reproducibility + planning) touched nothing live either**: no `npm` request to a
  proxy, no browser action, no adapter start. `npm ci` was run **only** in the throwaway copy at
  `/tmp/clean-deps-check`, never in this working tree. The proposed plan above is **awaiting
  approval and has not been executed.**
- **This segment sent nothing.** The completion-rule fix, its tests, and the adapter changes were
  made offline; `8731` (adapter) was already down and was not restarted, and `9333` (the operator's
  Chrome) was read with a local `ss` only. No browser action, no Perplexity request, no commit.
- **2026-11-11 consumed no live request either.** Two adapter processes were started against the
  operator's CDP 9333 and stopped before serving `/pin`; the only page contact was the read-only startup
  attach plus its read (`page.evaluate` only, `bringToFront` suppressed by the fix). The audit log of the
  second attempt is one line: `{"m":"GET","e":"/health","outcome":"ok","attached":true,"tabs":1}`.
  `/pin`, `/wait`, `/submit`: never served. The operator's final instruction for this segment is
  **document only** — the capture is not to be re-attempted without a fresh approval.
- **No further live requests and no increased budget are currently authorized.** A live
  run proceeds only on a fresh operator approval that includes its own attempt budget.
  **The attachment-validation `GET /v1/responses/<id>` does not reach Perplexity** (store
  read only) but still requires a live proxy, so it belongs to any future approved run.
- The proxy store (`/data/.responses_store.json`) holds supervisor-generated responses
  from the 2026-11-07 incidents plus the 01:27Z attempt — **53 responses / 38
  conversations** as of 2026-11-08. Pruning is the operator's call; do not prune.

# Blockers and remaining work

1. **Closed — `playwright-core` is declared and a clean install can start the adapter** (operator
   decision 2026-11-09: a runtime dependency, so the adapter starts from `npm ci` alone).
   `dependencies.playwright-core: ^1.65.0`; `npm ci` exit 0; resolves 1.65.0; the adapter started,
   attached and passed 25/25 safety checks from a lockfile-only tree. No browser is fetched —
   `playwright-core` never downloads one, and the cache mtime is unchanged from 2026-11-08. The
   adapter's header was corrected: what matters is that **`src/` may not import it**, and that holds.
2. **Closed — the instruction-carrier rule.** Operator decision 2026-11-08: a code block of any
   language whose **first line** is the marker. Implemented and tested; both the `prompt`-label
   failure (11:58Z) and the "exactly one block" fallback that declined on a real two-block answer
   are moot — decoy blocks are now ordinary.
3. **Closed — what ends a browser run** (operator directive 2026-11-09). Perplexity signalled
   completion by omitting the instruction block, and the run paused anyway because a todo list the
   worker never created was read as evidence of unfinished work. It is evidence of nothing, so the
   todo requirement is out of this gate: `assessCapture` → `decideConversationCompletion`, and a
   confirmed reply with no block completes. This is why completion no longer depends on the host at
   all — the earlier claim that it did is superseded. `src/browser/todos.ts` (21 tests, reading a
   Pi-Bolt worker's list from `pi.sendUserMessage` call results) still exists and its counts are
   still reported, marked `(informational)`; plain pi 1.5.0 has no todo tool and `countOpenTodos()`
   returns `null`, which now changes nothing.
4. **Implement the corrected flow on the proxy route** (design settled by the operator 2026-11-08;
   smallest change enumerated in `DEVELOPMENT-LOG.md` → 02:09Z "smallest required change"): seed
   config + validation, verbatim initial dispatch with zero requests, exact-message turn transfer,
   completion defaulting to manual stop, opt-in marker convention, removal of intro/template use
   from this flow, replacement of the tests that encode the old contract, plus the exact-message
   tests the operator specified.
5. `src/ui/mcp-panel.ts` still offers the discovery page rather than relay settings.
6. Decide: keep or delete the unwired JSON-decision evaluator
   (`src/backends/mcp-backend.ts` + `src/mcp/prompt.ts`).
7. `test/live-mcp.test.ts` still asserts the old JSON contract; it should become a live
   relay test when a live run is authorized.
8. The widget could show `turn n/N` for relay runs; `/supervise status` does.

# Next concrete action

1. **Re-attempt the read-only capture below — only on fresh approval.** Its preconditions are finished:
   `playwright-core` is declared, read-only mode exists, the audit log and `chromeSkipped` are in place,
   disconnect is safe, stability is content-based, and the startup path no longer throws. What the two
   stopped attempts established, and what a future driver must honour:
   - Read every request and response shape out of `scripts/browser-adapter-core.mjs` rather than recalling
     it. `/wait` takes **`timeoutMs`** (`readTimeoutMs` is ignored silently), `/pin` answers
     `{ok,url,threadNodes,composerReady,detail,readOnly}`, `/health` answers
     `{ok,readOnly,counters,url,threadNodes,attached,perplexityTabs}` — `attached` is a **boolean** and
     `submits` is nested at **`counters.submits`**.
   - Drive it **record-only**: save each payload and print its keys before asserting, so a wrong key cannot
     interrupt a live capture halfway through. The only assertions safe to make fatal *before* a payload
     exists are the tab precondition and the four `/health` checks.
   - Compile target is **`dist/`** (`tsconfig outDir`), not `build/`. The chain's functions are
     `parseAdapterAnswer`/`toReplyBlocks` in `src/browser/protocol.ts` and `assessCapture`/
     `extractMarkedInstruction`/`decideConversationCompletion` in **`src/relay/instruction.ts`** — not in
     `protocol.ts`. Wrap them: `parseAdapterAnswer` **throws** on a malformed block, and a throw before
     teardown costs the evidence.
2. **Proxy route, still unproven live** and still on the superseded flow (blocker 4). Separate class;
   finish or remove it without touching the browser route.

# Read-only browser verification plan — **APPROVED 2026-11-11, ATTEMPTED, NOT COMPLETED**

**What it checks, and what it cannot.** It checks **capture of an answer that is already finished**.
It does **not** test completion detection during live generation — that needs a turn streaming while
we watch, which a completed conversation cannot provide. Everything below is the code that already
passed 25/25 against a throwaway Chrome; the only new thing is the conversation it points at.

**Setup (operator-side, one choice):** exactly one `perplexity.ai` tab open — the selected completed
conversation — with Chrome's CDP on 9333. The adapter refuses at 0 or 2+ tabs and refuses an
unmatched pin, and never picks by recency.

1. Start read-only, pinned, logging:
   `node scripts/perplexity-browser-adapter.mjs --cdp=9333 --port=8731 --read-only --url=<exact session URL> --log=/tmp/adapter-audit.jsonl --ro-timeout=20000 --ro-stable-ms=4000`
2. `GET /health` → expect `attached:true`, `perplexityTabs:1`, `readOnly:true`, `counters.submits:0`.
3. `POST /pin {"url": <same exact URL>}` → 200, `pinned by url, read-only (no bringToFront)`.
4. `POST /wait {"pin": <same exact URL>, "timeoutMs": 20000, "stableMs": 4000}` → **save the raw JSON
   to a file before reading it**, so the artefact is the payload and not a paraphrase.
5. `POST /disconnect` → the adapter exits; Chrome and its tab must survive.
6. **Offline**, feed the saved payload through the real chain — `parseAdapterAnswer` →
   `assessCapture` → `extractMarkedInstruction` → `decideConversationCompletion` — exactly as
   `test/browser-live-wait.test.ts` does, asserting `capture.state === "complete"`,
   `picked.kind === "none"`, `verdict.action === "complete"`, and the reply displayed verbatim.
   (`done`/`terminal` were the old contract's names; `CompletionVerdict.action` is
   `instruct|complete|stalled|ambiguous|empty` and `ReplyCapture.state` is
   `complete|unreadable|incomplete` — `src/relay/instruction.ts:125,143`.)
7. Read the audit log: every request one line, **no line records a `/submit` post**,
   `GET /health` still reports `counters.submits: 0`.

**Report** from that payload and nothing else: `answerText`, `answerComplete`, `generating`, `status`,
`stableReads`/`stableNeeded`, `blocks[]` (label + content), `chromeSkipped`, `fingerprint`,
`distanceFromBottom`, `detail`, `bounds`.

**How completion is judged — and how it is not.** The expected closing text
("The task is complete: hello.js prints Hello, World!… Nothing remains open.") is compared **only**
as a content-identity check, to prove we read the fixture's final turn. **It is never a completion
signal.** `answerComplete` must come from the probe's own signals and be reported as such:
`generating === false` (no stop/cancel control on screen) **and** an unchanged `fingerprint` — the
sha256 of the answer text plus every block's label and content — across `stableReads ≥ stableNeeded`.
Carry the warning the live capture taught us: a finished answer there reported `status: "Idle"`,
because the "Finished" chip had already gone, so `Idle` alone is never completion.

**Why zero submissions and zero worker dispatches are structural, not hoped-for:** read-only mode
rejects `/submit` at the router, above every page call, and increments `submitRejected` rather than
`submits`; the audit log is the evidence either way. No Pi session is ever constructed in this plan,
so there is no worker to dispatch to and no attempt budget to spend.

**Remaining limitations, stated before approval rather than after:**
- **Capture only.** Nothing here exercises the settle loop watching a real generation end.
- **Observed, not proven.** Text stability plus absent generation controls are signals; a model that
  pauses for ten seconds before continuing would look finished. `assessCapture` is what stops that
  from ending a run, and it is exercised offline, not live.
- **The pin identifies the conversation, not the turn.** The read targets the newest answer
  partition; if the newest turn in the tab is not the fixture's final answer, that is what gets read.
  The expected-text comparison is the content check that catches it — and it must stay a check, not a
  completion signal.
- **Two tabs refuse the run.** Read-only requires a single open `perplexity.ai` tab.
- **The extension itself is never started**, so the live extension→adapter path stays unproven; only
  the payload boundary is checked (`/verify-adapter-disconnect.mjs` feeds the real `/wait` body
  through `parseAdapterAnswer`).
- **Chrome's own behaviour when a DevTools socket drops** is outside any package's evidence; we
  measured it once against a disposable profile and it survived.
- **Terms of service unchanged** (`5.2`, automated access to the website): a read-only pass is still
  programmatic access to a signed-in web session. Same account, same exposure.
- **The adapter still has no request budget of its own**; read-only mode and bounded timeouts are the
  brakes, and the extension's persisted `relayAttempts` remains the only counter.

**Fail-closed:** `answerComplete` false, text absent or different, or an unexpected block appearing →
stop and report what was seen. Reading an unexpected state is a result; "fixing" it by prompting the
chat is what this plan exists to avoid.

# Reliability findings

Observed on the browser route from 2026-11-09 to 2026-11-11. Kept separate from the product decision
above: these are about the *transport*, and most are fixed — 12 is **open**, and 13 is about the harness,
not the product.

1. **Confirmation by text equality is impossible.** Perplexity normalizes typed text
   (backticks, straight→curly quotes) and pads a trailing U+200B, so an exact comparison between
   what we typed and what the thread shows can never succeed. Fixed with a whitespace-tolerant
   word-subsequence check against **all** user bubbles (`data-workflow-entry`), which also
   re-anchors confirmation after the answer arrives. Deliberately **not** a fuzzy matcher: an
   approximate check that accepted a wrong turn would silently post a duplicate.
2. **A send can succeed while its confirmation fails.** That is why `/submit` refuses to type text
   that is already the newest user turn. Proven live at attempt 2, which reused a landed report
   instead of duplicating it, at the cost of a paused run.
3. **Enter is not a submit control on this site.** Clicking the composer's send button and reading
   `form.requestSubmit()` both no-op against the Lexical editor. Pressing Enter once, then reporting
   failure rather than retrying, is the rule — a blind keypress repeated across states is how one
   keystroke becomes three messages.
4. **`playwright-core` connects to a running Chrome; the full `playwright` package does not** — it
   launches its own bundled build, which cannot see a signed-in profile. Worth knowing before
   diagnosing a browser extension's transport as a login failure.
5. **A profile created before `--remote-debugging-port` cannot serve CDP** — the flag is read at
   process start, so the fix is to relaunch Chrome with it, never to fight an existing process.
6. **The capture path is not free of side effects, and its defaults are loose** (audited 2026-11-09;
   detail in `DEVELOPMENT-LOG.md` → read-path audit): `locate()` calls `page.bringToFront()` (focus
   theft — not navigation, not content, but not nothing); `/wait` defaults to `timeoutMs: 240_000`
   with `stableMs: 8_000` polled every 500 ms, so **~16 identical reads are the floor before it will
   confirm anything** and up to 4 minutes if the signals never agree; `/wait` **omits
   `chromeSkipped`**, so the excluded-chrome count cannot reach a caller that needs to report it;
   there is **no per-request access log**, making "we never called `/submit`" a claim of discipline
   rather than evidence; and `/disconnect` calls `browser.close()` on the strength of a comment
   claiming it leaves the browser running — **unverified, and the thing at stake is the operator's
   own browser.** Tab selection itself is sound: 0 tabs and 2+ tabs both refuse, an unmatched pin
   refuses; only a *missing* pin silently adopts whatever session thread is open.
   *Resolved 2026-11-10:* `chromeSkipped` is transmitted (and omitted rather than guessed when the
   probe did not report it); there is a per-request audit log and submission counters on `/health`;
   `/disconnect` no longer calls into the browser at all; and read-only mode clamps reads to
   `--max-read-ms` instead of inheriting 240 s. Normal mode's defaults were deliberately left alone.
7. **Merely attaching changed the operator's browser.** Without `noDefaults`, `connectOverCDP` sends
   `Browser.setDownloadBehavior { behavior: "allowAndName", downloadPath: <local temp dir>,
   eventsEnabled: true }` **browser-wide** (playwright-core 1.65.0, `lib/coreBundle.js:40400-40406`;
   the default at 53319-53320) — a real setting change to someone else's browser, from a tool whose
   job is reading. Now `{ noDefaults: true }`. The general shape: a "read-only" claim must cover the
   *connection*, not only the requests.
8. **Node's `close` on a request stream is not "the client hung up."** It fires when the body is
   consumed normally, so moving the abort listener to the top of the handler aborted every `/wait`
   ~4 ms in. The old placement — after the body read — was load-bearing by accident. The fix watches
   the response and aborts only on `!res.writableEnded`. Caught by the throwaway-browser run in 4 ms;
   no unit test could have, which is the standing argument for keeping that run.
9. **A shutdown that never answers cannot answer the question that matters.** Closing connections
   synchronously in `/disconnect` produced `fetch failed` for the caller — including for
   "did the browser survive?", the one thing the operator needs the response to say. Reply first,
   leave second.
10. **A process finding about this repository:** the adapter is untracked, so an in-place restructure
    had no diff. In that restructure `/submit` lost two safety guards — refusing to post while the
    page is still generating, and the exact composer read-back that decides whether Enter is pressed
    at all. Recovery depended on a stale copy surviving under `/tmp`. Now asserted: seven guard
    strings are checked present in both copies. **Copy an untracked file before rewriting it.**
11. **Two harness-level findings from this session's tests**, recorded because they hid real bugs:
   `String.prototype.trim()` does not strip zero-width characters (an extraction of `"\u200b"` read
   as a non-empty answer, which under "no block means done" would end a live run on nothing), and a
   test fake that re-filled defaults was silently converting an unconfirmed adapter answer into a
   confirmed one. Both are now asserted against.
12. **`--url` pins the requests, not the startup attach** (found 2026-11-11). `--url` becomes `TARGET` and
    the required pin for read-only `/pin`/`/wait`, but the startup auto-attach calls `locate(null)`, which
    **adopts whichever single `perplexity.ai` tab is open** and only logs
    `no pin supplied — adopting the open thread` (`perplexity-browser-adapter.mjs:189`). Had the open tab
    been a different conversation, that one would have been read while the log named the pinned URL. Not
    fixed (out of the approved scope); closed per-run by asserting `/health.url` equals the exact pinned
    URL before `/pin`.
13. **Three driver bugs and one real defect, all found only by pointing at the real thing** (2026-11-11):
    asserting `.attached == "1"` when it is the boolean `true`; asserting `.submits` when the field is
    `.counters.submits`; and sending `{readTimeoutMs}` where the route reads `timeoutMs` — silently
    ignored, so a reported "20-second bound" would have been fiction. The defect they exposed:
    `{ raise: !readOnly }` instead of `!CONFIG.readOnly` at `perplexity-browser-adapter.mjs:503`, which
    made the startup attach throw. **`scripts/` is untracked and the adapter is not importable, so a
    `ReferenceError` on its startup path is invisible to the 475-test suite: a green suite is not evidence
    that the adapter starts.** The adapter's behaviour under that failure was right — it refused to guess
    and logged why — which is the argument for logging refusals as loudly as successes.

# Historical records

`DEVELOPMENT-LOG.md` (append-only, dated):
- Working tree and environment — 2026-11-08 00:08 incident, 00:30–00:50Z 1.5.0 migration.
- 2026-11-07 21:30Z live-run failure — four root causes and their fixes.
- Verification records — 2026-11-08 gate, 00:49Z host smoke, 01:27Z live attempt (with the
  quota-notice correction), network guard and added tests.
- MCP continuity investigation — options A/B/C.
- Quota incidents — 2026-11-07 (43 + 2 requests) and proxy-store accounting.
- Provider observation — thinking-only completion (2026-11-07 23:24Z).
- Live-test plan (2026-11-08 00:29Z preparation) — retained for a future re-authorization.
- 2026-11-08 01:58Z — offline fixes: host-mode gate, template simplification (now superseded
  for this flow), missing-state diagnosis, end-to-end trace.
- 2026-11-08 02:09Z — product correction to a literal relay of an operator-supplied existing
  conversation; proxy attachment investigation with all verified line numbers; smallest
  required change.
- 2026-11-08 09:44Z — route decision investigation (offline only): proxy upstream and
  attachment re-verification, ToS §5.2(i), browser-attachment documentation, six-option
  comparison, recommendation, and read-only feasibility experiment proposal.
- 2026-11-08 10:21Z — route A accepted with ToS §5.2(i) exposure; the accepted loop contract
  and its four sub-decisions; Chrome 136 default-profile CDP restriction; read-only probe
  staged in an isolated scratch directory (no browser action).
- 2026-11-08 11:40Z — read-only browser experiment executed against the operator's dedicated
  CDP profile: attach + tab pinning + byte-stable verbatim extraction confirmed, no wall;
  `data-workflow-*` anchors found and proxy-era selectors disproved; two design-breaking
  findings (no fences in `innerText`; `Finished` label while still streaming).
- 2026-11-08 11:58Z — controlled exchange executed in a fresh disposable thread (1 query):
  submission confirmed end-to-end; `/search/new/<uuid>` → `/session/<uuid>`; label-free
  composer selection; `figcaption`/`code` block anatomy; the `prompt` label was NOT honoured
  (came back `text`), leaving the instruction-carrier rule as the open decision.
- 2026-11-09 00:57Z — browser relay implemented offline: the operator's marker rule, the
  two-authority completion gate, the loopback adapter and the `/supervise mcp` commands; gate
  clean at 408 tests; and the explicit statement that the adapter file itself has never run.
- 2026-11-09 01:15Z — CORRECTION to the above: the todo half does work on the operator's actual
  host (the worker shares this Pi-Bolt session, dispatched by `pi.sendUserMessage`), with the three
  read sources and the recorded output strings that prove them; 419 tests.
- 2026-11-09 09:57Z — FIRST FULL LIVE BROWSER RUN: the loop end to end (0-request first
  instruction, two posted reports, two marked-block instructions, completion refused because no todo
  list existed), the two real bugs only a live run could expose (rendered-text confirmation;
  `/wait` missing `ok`), the never-send-twice dedup, and the RPC harness.
- Documentation history — the 2026-11-08 restructure and reconciliations.
