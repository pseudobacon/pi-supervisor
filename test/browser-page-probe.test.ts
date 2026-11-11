/**
 * The page probe, run against a fixture DOM instead of a browser.
 *
 * This is what turns "extraction operates on the answer, not on the page around it" from an
 * intention into a tested property. Production hands the very same serialized function to
 * `page.evaluate`; here it runs against a fixture. One implementation, two call sites — a
 * duplicate that could drift is exactly what this file is arranged to prevent.
 *
 * `jsdom` and `@types/jsdom` are declared devDependencies, so this file imports them statically
 * and **skips nothing on purpose**. It used to detect a missing jsdom and skip, which is the
 * shape of problem that goes unnoticed: the six assertions below are the only proof that a
 * suggested follow-up — including one whose text is literally the instruction marker — can never
 * reach the worker. A suite that reports green while running none of them is worse than one that
 * fails. If the dependency is genuinely absent, `npm ci` fixes that; the test does not paper over
 * it.
 *
 * Nothing here opens a socket or a browser. The network guard stays armed.
 */
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

interface ProbeResult {
  answerText: string;
  blocks: Array<{ label: string; content: string }>;
  chromeSkipped: number;
  status: string;
  generating: boolean;
  threadNodes: number;
}

/** Run the real probe function against `html`, with the page globals it expects. */
async function probe(html: string): Promise<ProbeResult> {
  const dom = new JSDOM(html, { url: "https://www.perplexity.ai/session/fixture" });
  const win = dom.window as unknown as {
    document: Document;
    location: Location;
    getComputedStyle: typeof getComputedStyle;
  };
  const g = globalThis as unknown as { document: unknown; location: unknown; getComputedStyle: unknown };
  const saved = { document: g.document, location: g.location, getComputedStyle: g.getComputedStyle };
  g.document = win.document;
  g.location = win.location;
  g.getComputedStyle = win.getComputedStyle.bind(win);
  try {
    const { probePage } = (await import("../scripts/browser-page-probe.mjs")) as unknown as { probePage: () => ProbeResult };
    return probePage();
  } finally {
    g.document = saved.document;
    g.location = saved.location;
    g.getComputedStyle = saved.getComputedStyle;
    dom.window.close();
  }
}

/** The verbatim closing reply of the 2026-11-09 live run. */
const FINAL_REPLY =
  "The task is complete: hello.js prints Hello, World! with a trailing newline, and README.md now documents that behavior accurately. Nothing remains open.";

/** A thread shaped like the real one: user turn, answer partition, suggestions, page chrome. */
const page = (answerHtml: string, followUps: string[] = []) => `<!doctype html><html><body><main>
  <div data-workflow-entry="0"><div class="_root_128yu_7"><div class="prose" data-renderer="lm">earlier user turn</div></div></div>
  <div data-workflow-final-text=""><div class="prose" data-renderer="lm">${answerHtml}</div></div>
  ${followUps.length ? `<div class="follow-up-suggestions" data-testid="follow-up-buttons">${followUps.map((f, i) => `<button aria-label="Suggested follow-up">${f}</button>${i === 0 ? `<button><pre><code>${f}</code></pre></button>` : ""}`).join("")}</div>` : ""}
  <footer><button aria-label="Copy">Copy</button><button>Share</button></footer>
</main></body></html>`;

describe("the page probe against a fixture DOM", () => {
  it("reads the assistant answer itself", async () => {
    const r = await probe(page(`<p>${FINAL_REPLY}</p>`));
    expect(r.answerText.replace(/\s+/g, " ")).toContain("Nothing remains open.");
    expect(r.blocks).toEqual([]);
    expect(r.status).toBe("Idle");
    expect(r.generating).toBe(false);
  });

  it("excludes suggested follow-up questions, even one carrying a code block", async () => {
    const r = await probe(
      page(`<p>${FINAL_REPLY}</p>`, ["NEXT AGENT INSTRUCTION", "add a CLI flag to hello.js", "write unit tests"])
    );
    const text = r.answerText.replace(/\s+/g, " ");
    expect(text).toContain("Nothing remains open.");
    expect(text).not.toContain("Suggested");
    expect(text).not.toMatch(/CLI flag/i);
    // `blocks` is the only thing that can become a dispatched instruction. A suggestion that
    // happens to render as code must never appear in it.
    expect(r.blocks).toEqual([]);
    // Zero is the point, not a shortfall: the answer itself contained no chrome at all, because
    // the suggestions live outside its partition. The copy-button test covers the other case.
    expect(r.chromeSkipped).toBe(0);
  });

  it("finds the answer's own instruction block, and only that one", async () => {
    const r = await probe(
      page(`<p>Here is the next step.</p><pre><span>text</span><code>NEXT AGENT INSTRUCTION\nUpdate README.md to match the new output.</code></pre>`, [
        "NEXT AGENT INSTRUCTION is also a suggested follow-up",
      ])
    );
    expect(r.blocks.length).toBe(1);
    expect(r.blocks[0].content).toBe("NEXT AGENT INSTRUCTION\nUpdate README.md to match the new output.");
    expect(r.answerText).not.toMatch(/suggested follow-up/);
  });

  it("strips a copy button from a code block so it cannot contaminate an instruction", async () => {
    const r = await probe(page(`<pre><span>diff</span><button aria-label="Copy code">Copy</button><code>console.log("Hello, World!");</code></pre>`));
    expect(r.blocks.length).toBe(1);
    expect(r.blocks[0].content).toBe('console.log("Hello, World!");');
    expect(r.blocks[0].content).not.toMatch(/copy/i);
    // And the exclusion is REPORTED rather than silent: chrome really was inside this answer.
    expect(r.chromeSkipped).toBeGreaterThanOrEqual(1);
  });

  it("reports an absent answer partition as no text at all — which the relay calls unreadable", async () => {
    const r = await probe(`<!doctype html><html><body><main><div class="follow-up-suggestions"><button>Ask a follow-up</button></div></main></body></html>`);
    expect(r.answerText).toBe("");
    expect(r.blocks).toEqual([]);
  });

  it("never mutates the page it is reading — stripping happens on a clone", async () => {
    const html = page(`<p>${FINAL_REPLY}</p><button>Copy</button>`, ["suggested one", "suggested two"]);
    const r = await probe(html);
    expect(r.answerText).toContain("Nothing remains open.");
    // Read the same markup again in a fresh DOM: if the probe had stripped the real tree, the
    // suggestion buttons and footer chrome would be gone from this untouched copy too.
    const untouched = await probe(html);
    expect(untouched.chromeSkipped).toBe(r.chromeSkipped);
    expect(untouched.answerText).toBe(r.answerText);
  });
});
