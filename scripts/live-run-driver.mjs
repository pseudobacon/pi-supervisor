#!/usr/bin/env node
/**
 * live-run-driver — host a supervised relay run over RPC, and record everything.
 *
 * WHY THIS EXISTS. A supervised run cannot live in print mode: the host exits after its last
 * prompt and disposes the session, while the worker dispatch outlives that prompt (the 2026-11-08
 * 01:27Z launch failed exactly this way, and `src/index.ts` refuses print/json for start and
 * resume). There is no tmux here to drive a TUI. RPC mode is the documented long-lived mode, and
 * it executes extension commands immediately — `{"type":"prompt","message":"/supervise …"}`
 * returns `disposition: "handled"` and the loop then runs on its own (docs/rpc.md,
 * docs/rpc-commands.md).
 *
 * WHAT IT DOES NOT DO. It does not supervise, decide, or relay anything — all of that is the
 * extension's. It is a harness: start the host, hand over one command, then watch and record. The
 * ground truth of a run is not this file's log but the session JSONL (supervisor-state entries)
 * and the adapter's log, both of which outlive it.
 *
 * IT ALSO DOES NOT LEAVE A LIVE SESSION BEHIND. At the wall-clock cap it sends `/supervise stop`
 * and closes stdin for an orderly shutdown, because a half-live supervisor holding a browser
 * thread is worse than a stopped one.
 *
 *   node scripts/live-run-driver.mjs --goal "<first instruction, verbatim>" [--cap 780]
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const ARGV = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = ARGV.indexOf(`--${name}`);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith("--") ? ARGV[i + 1] : fallback;
};

const has = (name) => process.argv.includes(`--${name}`);
const WORKDIR = flag("cwd", `${process.env.HOME}/ai/pi-supervisor-live-scratch`);
const MODEL = flag("model", "localhost/qwen3.8-flash-next-unsloth-ud-iq3_xxs");
const GOAL = flag("goal", "");
const CAP_S = Number(flag("cap", "780")); // must exceed the loop's own maxDurationMs ceiling
const IDLE_AFTER_MS = Number(flag("idle", "25000")); // settle quietly for this long, then stop watching
const OUT = flag("out", "/tmp/live-run");

if (!GOAL && !has("resume")) {
  console.error('usage: node scripts/live-run-driver.mjs --goal "<first instruction>" | --resume');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const EVENTS = `${OUT}/events.jsonl`;
const RAW = `${OUT}/host-stderr.log`;
writeFileSync(EVENTS, "");
writeFileSync(RAW, "");
const log = (line) => {
  const stamped = `${new Date().toISOString().slice(11, 23)} ${line}`;
  console.log(stamped);
  appendFileSync(`${OUT}/driver.log`, `${stamped}\n`);
};

// --resume continues this directory's most recent session and asks the loop to resume it,
// rather than starting a new goal. The relay's own dedup keeps the already-posted worker
// report from being sent a second time, so resume costs nothing it does not need.
const RESUME = has("resume");
const hostArgs = ["--mode", "rpc", "--model", MODEL];
if (RESUME) hostArgs.push("--continue");
const child = spawn("pi-bolt", hostArgs, { cwd: WORKDIR, stdio: ["pipe", "pipe", "pipe"] });
child.on("error", (error) => {
  log(`host could not start: ${error.message}`);
  process.exit(1);
});
child.stderr.on("data", (chunk) => appendFileSync(RAW, chunk));

let lastActivity = Date.now(); // declared before any handler can read it
let buffer = "";
let nextId = 0;
const pending = new Map();
const send = (command) => {
  const id = `d${++nextId}`;
  child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  return id;
};
const waitFor = (id, ms = 30_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`no response to ${id} within ${ms}ms`));
    }, ms);
    pending.set(id, (response) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(response);
    });
  });

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let cut;
  while ((cut = buffer.indexOf("\n")) >= 0) {
    const record = buffer.slice(0, cut).replace(/\r$/, "");
    buffer = buffer.slice(cut + 1);
    if (!record.trim()) continue;
    appendFileSync(EVENTS, `${record}\n`);
    let parsed;
    try {
      parsed = JSON.parse(record);
    } catch {
      log(`non-JSON stdout record: ${record.slice(0, 120)}`);
      continue;
    }
    if (parsed.type === "response") {
      const handler = pending.get(parsed.id);
      if (handler) handler(parsed);
      else log(`unmatched response for ${parsed.id} (success=${parsed.success})`);
      continue;
    }
    // Events are the run's own narration. Logged, not interpreted: the loop's state lives in
    // the session file, and a harness that infers state from events will infer it wrongly.
    if (parsed.type) {
      if (parsed.type === "agent_start" || parsed.type === "agent_end" || parsed.type === "agent_settled" || parsed.type === "turn_end") {
        lastActivity = Date.now();
        log(`event ${parsed.type}`);
      } else if (parsed.type === "extension_error") {
        log(`EXTENSION ERROR ${JSON.stringify(parsed).slice(0, 300)}`);
      }
    }
  }
});

child.on("exit", (code, signal) => {
  log(`host exited code=${code} signal=${signal}`);
  finish(code ?? 0);
});

const finish = (code) => {
  try {
    child.stdin.end(); // documented orderly shutdown
  } catch {
    /* already gone */
  }
  log(`events: ${EVENTS}`);
  log(`host stderr: ${RAW}`);
  process.exit(code);
};

// The host needs a moment before it will answer; poll get_state rather than assuming a ready event.
async function untilReady(limitMs = 60_000) {
  const deadline = Date.now() + limitMs;
  for (;;) {
    try {
      const response = await waitFor(send({ type: "get_state" }), 15_000);
      log(`ready (get_state success=${response.success})`);
      return response;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      log(`waiting for the host… ${error.message}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

const started = Date.now();
const capMs = started + CAP_S * 1000;

log(`workdir=${WORKDIR}`);
log(`model=${MODEL}`);
log(`goal: ${GOAL.slice(0, 120)}${GOAL.length > 120 ? "…" : ""}`);

const state = await untilReady();
log(`host state: ${JSON.stringify(state.data ?? {}).slice(0, 220)}`);

const command = RESUME ? "/supervise resume" : `/supervise ${GOAL}`;
if (RESUME && !GOAL) log("resume: continuing the most recent session for this directory");
const promptId = send({ type: "prompt", message: command });
const accepted = await waitFor(promptId, 60_000);
log(`${command.split(" ").slice(0, 2).join(" ")} → success=${accepted.success} disposition=${accepted.data?.disposition ?? "?"}`);
if (!accepted.success) {
  log("the host REJECTED the start command — nothing was dispatched. Ending.");
  finish(1);
}

// Watch, and stop watching on our own terms. The run's real end is recorded in the session file;
// this loop's job is to not abandon a live process.
for (;;) {
  await new Promise((r) => setTimeout(r, 5_000));
  const idleFor = Date.now() - lastActivity;
  if (Date.now() > capMs) {
    log(`wall-clock cap ${CAP_S}s reached — asking the loop to stop before the session is left live`);
    send({ type: "prompt", message: "/supervise stop" });
    await new Promise((r) => setTimeout(r, 5_000));
    finish(0);
  }
  if (idleFor > IDLE_AFTER_MS) {
    const response = await waitFor(send({ type: "get_state" }), 20_000).catch(() => null);
    const busy = response?.data?.isStreaming ?? response?.data?.busy;
    log(`idle ${Math.round(idleFor / 1000)}s, host busy=${busy ?? "?"}`);
    if (!busy) {
      log("settled with nothing in flight — closing the harness (the loop's own end state is in the session file)");
      finish(0);
    }
    lastActivity = Date.now();
  }
}
