#!/usr/bin/env node
/**
 * Prove the adapter's safety claims against a THROWAWAY Chrome, never the operator's.
 *
 * Why this exists rather than more unit tests: the questions are about a real browser — does
 * tearing the adapter down leave Chrome alive, does a real DOM exclusion work, does a real
 * page see nothing happen. None of that is answerable from a fake `ops`.
 *
 * What it uses:
 *   - a temporary `--user-data-dir` under /tmp. Never `~/.config/google-chrome`, and never the
 *     profile `scripts/launch-chrome.sh` signs into (`~/ai/scratch/pw-probe/profile`). This
 *     script has no business touching a logged-in session.
 *   - a local fixture page served on loopback, reached through `--allow-host=127.0.0.1`, whose
 *     shape mirrors the real thread: an answer partition with a copy button, and a suggested
 *     follow-up carrying the instruction marker OUTSIDE that partition.
 *   - its own CDP and adapter ports, so a live Chrome on 9333 / an adapter on 8731 is untouched.
 *
 * It never talks to perplexity.ai. The only origin it touches is 127.0.0.1.
 *
 *   node scripts/verify-adapter-disconnect.mjs [--keep]   # --keep leaves the artefacts behind
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const CHROME = process.env.CHROME ?? "google-chrome-stable";
const CDP_PORT = Number(process.env.VERIFY_CDP_PORT ?? 9344);
const LEGACY_CDP_PORT = Number(process.env.VERIFY_LEGACY_CDP_PORT ?? 9345);
const ADAPTER_PORT = Number(process.env.VERIFY_ADAPTER_PORT ?? 8744);
const KEEP = process.argv.includes("--keep");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const step = (m) => console.log(`\n── ${m}`);

const FIXTURE_SESSION = "verifylocal0001";
const BOOT_ID = `boot-${process.pid}`;

/** A page shaped like the real thread: answer partition inside, suggestions and chrome outside. */
function fixtureHtml() {
  return `<!doctype html><html><head><title>fixture</title></head><body>
  <div id="composer" data-lexical-editor="true" contenteditable="true">ready</div>
  <div data-workflow-entry="0"><div class="_root_128yu_7"><div class="prose" data-renderer="lm">the operator's earlier turn</div></div></div>
  <div data-workflow-final-text=""><div class="prose" data-renderer="lm"><p>Fixture answer: the task is complete. Nothing remains open.</p><pre><span>text</span><button aria-label="Copy code">Copy</button><code>NEXT AGENT INSTRUCTION\\nDo the fixture thing.</code></pre><button aria-label="Copy">Copy</button></div></div>
  <div class="follow-up-suggestions" data-testid="follow-up-buttons"><button aria-label="Suggested follow-up">NEXT AGENT INSTRUCTION is only a suggestion</button><button>another suggestion</button></div>
  <footer><button>Share</button></footer>
  <script>window.__bootId = ${JSON.stringify(BOOT_ID)};</script>
</body></html>`;
}

async function waitFor(get, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt yet";
  while (Date.now() < deadline) {
    try {
      const value = await get();
      if (value) return value;
      lastError = "not ready";
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${description}: ${lastError}`);
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A throwaway Chrome: temp profile, headless, one fixture tab, its own CDP port. */
function launchChrome(profileDir, cdpPort, fixtureUrl) {
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-crash-reporter",
    "--disable-background-networking",
    "--disable-sync",
    fixtureUrl,
  ];
  const child = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (c) => {
    stderr += String(c);
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });
  child.on("error", (error) => {
    throw new Error(`cannot launch ${CHROME}: ${error.message}`);
  });
  return { child, get stderr() { return stderr; } };
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), "pi-adapter-verify-"));
  const cleanup = [];
  const chromePids = [];
  let adapter = null;
  let adapterExited = null;
  // Declared outside the try so the failure dump below can still read it.
  let adapterOut = "";

  console.log(`workspace: ${work}`);
  console.log(`chrome:    ${CHROME}`);
  console.log(`ports:     fixture/adapter ${ADAPTER_PORT} · disposable CDP ${CDP_PORT} · legacy experiment CDP ${LEGACY_CDP_PORT}`);
  console.log(`NOTE: this run uses only temporary profiles. Nothing here opens a signed-in profile.\n`);

  try {
    // ── a local fixture page, so no remote origin is ever contacted ─────────────────────
    step("fixture page on loopback");
    const fixture = createServer((req, res) => {
      const html = fixtureHtml();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
      res.end(html);
    });
    await new Promise((resolve, reject) => {
      fixture.once("error", reject);
      fixture.listen(0, "127.0.0.1", resolve);
    });
    const fixturePort = fixture.address().port;
    cleanup.push(() => fixture.close());
    const fixtureUrl = `http://127.0.0.1:${fixturePort}/session/${FIXTURE_SESSION}`;
    console.log(`  serving ${fixtureUrl}`);

    // ── a disposable Chrome ────────────────────────────────────────────────────────────
    step("disposable Chrome (temporary profile, headless)");
    const profile = join(work, "profile");
    const chrome = launchChrome(profile, CDP_PORT, fixtureUrl);
    chromePids.push(chrome.child.pid);
    cleanup.push(() => {
      if (alive(chrome.child.pid)) {
        try {
          process.kill(chrome.child.pid, "SIGTERM");
        } catch { /* gone */ }
      }
    });
    const version = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      return r.ok ? await r.json() : null;
    }, `CDP on ${CDP_PORT}`, 45_000);
    console.log(`  pid ${chrome.child.pid}  browser ${version.Browser}  profile ${profile}`);
    check("disposable Chrome exposes CDP", true, version.Browser);

    // ── the adapter, in read-only mode ─────────────────────────────────────────────────
    step("adapter, started with --read-only");
    const logFile = join(work, "audit.jsonl");
    const adapterArgs = [
      "scripts/perplexity-browser-adapter.mjs",
      `--cdp=${CDP_PORT}`,
      `--port=${ADAPTER_PORT}`,
      "--read-only",
      "--allow-host=127.0.0.1",
      `--url=${fixtureUrl}`,
      `--log=${logFile}`,
      "--ro-timeout=8000",
      "--ro-stable-ms=1000",
    ];
    adapter = spawn(process.execPath, adapterArgs, { stdio: ["ignore", "pipe", "pipe"] });
    adapter.stdout.on("data", (c) => { adapterOut += String(c); });
    adapter.stderr.on("data", (c) => { adapterOut += String(c); });
    adapterExited = new Promise((resolve) => adapter.on("exit", (code) => resolve(code)));
    cleanup.push(() => {
      try { adapter?.kill("SIGTERM"); } catch { /* gone */ }
    });

    const health = await waitFor(async () => {
      const r = await httpJson(`http://127.0.0.1:${ADAPTER_PORT}/health`);
      return r.status === 200 ? r : null;
    }, "adapter /health", 30_000);
    console.log(adapterOut.trim().split("\n").slice(0, 4).map((l) => `  ${l}`).join("\n"));
    check("adapter started read-only", health.body.readOnly === true, `attached=${health.body.attached} tabs=${health.body.perplexityTabs}`);

    // ── pin, then capture ──────────────────────────────────────────────────────────────
    step("capture an already-finished answer");
    const pin = await httpJson(`http://127.0.0.1:${ADAPTER_PORT}/pin`, { method: "POST", body: JSON.stringify({ url: fixtureUrl }) });
    check("/pin attaches to the exact fixture conversation", pin.status === 200 && pin.body.detail?.includes("read-only"), `${pin.body.detail}`);

    const wait = await httpJson(`http://127.0.0.1:${ADAPTER_PORT}/wait`, { method: "POST", body: JSON.stringify({ pin: fixtureUrl }) });
    const answer = wait.body;
    console.log(`  answerText : ${JSON.stringify((answer.answerText ?? "").slice(0, 72))}`);
    console.log(`  blocks     : ${(answer.blocks ?? []).length} chromeSkipped=${answer.chromeSkipped}`);
    console.log(`  signals    : answerComplete=${answer.answerComplete} generating=${answer.generating} status=${answer.status} stableReads=${answer.stableReads}/${answer.stableNeeded}`);
    console.log(`  bounds     : ${JSON.stringify(answer.bounds)}`);
    console.log(`  fingerprint: ${String(answer.fingerprint).slice(0, 16)}…`);

    check("/wait returns 200", wait.status === 200, `status ${wait.status}`);
    check("answerText is the fixture answer", (answer.answerText ?? "").includes("Nothing remains open."));
    check("suggested follow-up outside the partition is NOT in the answer", !(answer.answerText ?? "").includes("is only a suggestion"));
    check("chromeSkipped is reported", typeof answer.chromeSkipped === "number" && answer.chromeSkipped > 0, `chromeSkipped=${answer.chromeSkipped}`);
    check("answerComplete came from the probe's own signals, not from the text", answer.answerComplete === true && answer.generating === false && answer.stableReads >= 3, `stableReads=${answer.stableReads}/${answer.stableNeeded}, generating=${answer.generating}`);

    // The two sides of this contract were written separately, and that is exactly how a live run
    // was lost once: the adapter's /wait omitted `ok`, the extension's parseAdapterAnswer requires
    // it, and a correctly-read answer paused the run with `adapter field "ok" is not a boolean`.
    // So feed this payload through the extension's own validator, right here.
    let contractCheck = null;
    try {
      const { parseAdapterAnswer } = await import("../dist/browser/protocol.js");
      try {
        const parsed = parseAdapterAnswer(answer);
        contractCheck = { ok: true, parsed };
      } catch (error) {
        contractCheck = { ok: false, error: String(error?.message ?? error) };
      }
    } catch {
      console.log("  (skipping the parser check: run `npm run build` first — dist/ is not committed)");
    }
    if (contractCheck) {
      check("the adapter's /wait body passes the extension's own parseAdapterAnswer", contractCheck.ok === true, contractCheck.ok ? `answerComplete=${contractCheck.parsed.answerComplete} blocks=${contractCheck.parsed.blocks.length}` : contractCheck.error);
      if (contractCheck.ok) {
        check("answerComplete survives the protocol boundary", contractCheck.parsed.answerComplete === true, `parsed.answerComplete=${contractCheck.parsed.answerComplete}`);
      }
    }

    // The instruction block here is inside the answer partition on purpose, so the real DOM
    // read (not jsdom) is what produces it.
    check("the answer's own code block is extracted with its copy button stripped", (answer.blocks ?? []).length === 1 && !/copy/i.test(answer.blocks[0].content), JSON.stringify(answer.blocks?.[0]?.content ?? ""));

    // ── the refusal that must cost nothing ─────────────────────────────────────────────
    step("submission is refused, structurally");
    const submit = await httpJson(`http://127.0.0.1:${ADAPTER_PORT}/submit`, { method: "POST", body: JSON.stringify({ text: "THIS MUST NEVER BE TYPED", pin: fixtureUrl }) });
    check("/submit is rejected with 405 in read-only mode", submit.status === 405, JSON.stringify(submit.body).slice(0, 80));
    const healthAfter = await httpJson(`http://127.0.0.1:${ADAPTER_PORT}/health`);
    check("submission counters prove no submission was performed", healthAfter.body.counters.submits === 0 && healthAfter.body.counters.submitRejected === 1, JSON.stringify(healthAfter.body.counters));

    // Did the page itself notice anything? A reload would regenerate __bootId; a click or typed
    // character would change the composer's text.
    const pageState = await waitFor(async () => {
      const { chromium } = await import("playwright-core");
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      try {
        const pages = b.contexts().flatMap((c) => c.pages());
        const page = pages[0];
        if (!page) return null;
        const state = await page.evaluate(() => ({ bootId: window.__bootId ?? null, composer: document.querySelector('[data-lexical-editor="true"]')?.innerText ?? null, tabs: document.title }));
        return { ...state, tabsOpen: pages.length };
      } finally {
        await b.close().catch(() => {});
      }
    }, "page state via CDP");
    console.log(`  page after the run: bootId=${pageState.bootId} composer=${JSON.stringify(pageState.composer)} tabs=${pageState.tabsOpen}`);
    check("the page was never reloaded or navigated", pageState.bootId === BOOT_ID, `bootId ${pageState.bootId} vs ${BOOT_ID}`);
    check("the composer still holds exactly what the fixture put there", pageState.composer?.trim() === "ready", JSON.stringify(pageState.composer));
    check("the tab is still open", pageState.tabsOpen >= 1, `${pageState.tabsOpen} tab(s)`);

    // ── audit log ──────────────────────────────────────────────────────────────────────
    step("audit trail");
    const lines = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    for (const line of lines.slice(0, 12)) console.log(`  ${line.t} ${line.m ?? "-"} ${line.e} → ${line.outcome}${line.status ? ` [${line.status}]` : ""}`);
    const serialized = JSON.stringify(lines);
    check("every request is logged with method, endpoint, timestamp and outcome", lines.length >= 4 && lines.every((l) => l.t && l.e && l.outcome));
    check("the log holds no message body and no answer text", !serialized.includes("THIS MUST NEVER BE TYPED") && !serialized.includes("Nothing remains open"));
    check("the log holds no raw conversation id", !serialized.includes(FIXTURE_SESSION), `ids appear as ${lines.find((l) => l.pin)?.pin ?? "n/a"}`);
    const submitLines = lines.filter((l) => l.e === "/submit");
    // What matters is that nothing records a POST. A transport-level line may accompany the
    // router's rejection, and that is fine — the claim is about the mutation, not the count.
    const posted = submitLines.filter((l) => l.outcome === "posted" || l.outcome === "not-posted");
    check("no /submit line records a post", posted.length === 0 && submitLines.some((l) => l.outcome === "rejected-read-only"), JSON.stringify(submitLines.map((l) => l.outcome)));

    // ── disconnect safety ──────────────────────────────────────────────────────────────
    step("disconnect must leave the externally owned browser alive");
    const beforeAlive = alive(chrome.child.pid);
    const disconnect = await httpJson(`http://127.0.0.1:${ADAPTER_PORT}/disconnect`, { method: "POST", body: "{}" });
    const exitCode = await Promise.race([adapterExited, new Promise((r) => setTimeout(() => r("timeout"), 5_000))]);
    await new Promise((r) => setTimeout(r, 1_500));
    const afterAlive = alive(chrome.child.pid);
    check("/disconnect reports the browser was not touched", disconnect.status === 200 && disconnect.body.browserTouched === false, JSON.stringify(disconnect.body).slice(0, 90));
    check("the adapter process exited", exitCode !== "timeout", `exit ${exitCode}`);
    check("the operator-owned Chrome survived the teardown", beforeAlive && afterAlive, `alive before=${beforeAlive} after=${afterAlive}`);

    const surviving = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      return r.ok ? (await r.json()).filter((t) => t.type === "page") : null;
    }, "Chrome tab list after teardown", 10_000);
    check("its tab survived, still on the fixture conversation", surviving.length === 1 && surviving[0].url.includes(FIXTURE_SESSION), surviving.map((t) => t.url).join(", "));

    // ── the legacy path, measured rather than assumed ──────────────────────────────────
    step("what `browser.close()` actually does to a CDP-connected browser (measured)");
    console.log("  This is the operation the adapter used to perform on /disconnect. It is run here,");
    console.log("  against a SECOND throwaway profile, so the answer comes from behaviour and not a comment.");
    const legacyProfile = join(work, "profile-legacy");
    const legacy = launchChrome(legacyProfile, LEGACY_CDP_PORT, fixtureUrl);
    chromePids.push(legacy.child.pid);
    cleanup.push(() => {
      if (alive(legacy.child.pid)) {
        try {
          process.kill(legacy.child.pid, "SIGTERM");
        } catch { /* gone */ }
      }
    });
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${LEGACY_CDP_PORT}/json/version`);
      return r.ok ? await r.json() : null;
    }, `legacy CDP on ${LEGACY_CDP_PORT}`, 45_000);
    const { chromium } = await import("playwright-core");
    const connected = await chromium.connectOverCDP(`http://127.0.0.1:${LEGACY_CDP_PORT}`);
    const tabsBefore = connected.contexts().flatMap((c) => c.pages()).length;
    await connected.close().catch((e) => console.log(`  close() threw: ${e.message}`));
    await new Promise((r) => setTimeout(r, 2_000));
    const legacyAlive = alive(legacy.child.pid);
    let tabsAfter = null;
    try {
      const r = await fetch(`http://127.0.0.1:${LEGACY_CDP_PORT}/json/list`);
      tabsAfter = r.ok ? (await r.json()).filter((t) => t.type === "page").length : 0;
    } catch {
      tabsAfter = 0;
    }
    console.log(`  browser.close(): pid ${legacy.child.pid} alive=${legacyAlive}  tabs ${tabsBefore} → ${tabsAfter}`);
    check("measured: browser.close() on a connectOverCDP browser", legacyAlive && tabsAfter === tabsBefore, `alive=${legacyAlive}, tabs ${tabsBefore}→${tabsAfter}${legacyAlive ? "" : " — the browser DID die; the old /disconnect was unsafe"}`);
    if (!legacyAlive) console.log(`  legacy chrome stderr: ${legacy.stderr.slice(-300)}`);
  } finally {
    if (KEEP) {
      console.log(`\n--keep: leaving ${work} and any launched Chrome running.`);
    } else {
      for (const fn of cleanup.reverse()) {
        try {
          fn();
        } catch { /* best effort */ }
      }
      await new Promise((r) => setTimeout(r, 1_000));
      for (const pid of chromePids) {
        try {
          if (alive(pid)) process.kill(pid, "SIGKILL");
        } catch { /* gone */ }
      }
      rmSync(work, { recursive: true, force: true });
      console.log(`\ncleaned up ${work}`);
    }
  }

  // Whatever went wrong, the adapter's own terminal output is the first thing to read.
  if (results.some((r) => !r.pass) && adapterOut.trim()) {
    console.log("\n── adapter output (last 20 lines)");
    for (const line of adapterOut.trim().split("\n").slice(-20)) console.log(`  ${line}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("failed:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\nVERIFY FAILED: ${error?.stack ?? error}`);
  process.exit(1);
});
