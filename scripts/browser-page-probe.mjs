/**
 * The page probe, as a function that needs NOTHING from its enclosing scope.
 *
 * It is a separate module rather than a closure inside the adapter for one reason: the rules
 * below decide what the relay believes the assistant said, and a rule that only ever runs inside
 * `page.evaluate` cannot be tested. Playwright serializes this function and runs it in the page;
 * a test runs the SAME function against a fixture DOM. There is no second implementation to
 * drift.
 *
 * Do not add imports, module-scope constants, or template values here — the serialization is
 * what makes the two call sites agree.
 *
 * Returns the page's state as the adapter's contract sees it. Never mutates the DOM: the answer
 * is read from a CLONE with the page chrome stripped out of it.
 */
export function probePage() {

  const q = (s, root = document) => [...root.querySelectorAll(s)];
  const norm = (x) => (x ?? "").replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
  // innerText where the engine has it (a real browser), textContent where it does not (jsdom in
  // the offline suite, some embedded webviews). This helper is declared INSIDE the function on
  // purpose: the whole function is serialized into the page by page.evaluate, so anything it
  // closes over that lives outside it would be `undefined` in there.
  const text = (el) => {
    if (!el) return "";
    const viaInnerText = el.innerText;
    return typeof viaInnerText === "string" ? viaInnerText : (el.textContent ?? "");
  };
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
  // The answer lives in the LAST workflow partition; the user's turns are entries.
  const parts = q("[data-workflow-final-text]");
  const last = parts[parts.length - 1] ?? null;
  const prose = last ? (last.querySelector('div.prose[data-renderer="lm"]') ?? last) : null;
  // Extraction reads the ANSWER, not the page around it. Stripping happens on a clone, so this
  // endpoint never mutates the operator's DOM. Follow-up suggestions and other chrome are not
  // answer text: they arrive as buttons/links, and a thread's suggested next questions are the
  // content most likely to be mistaken for an instruction — they must never be dispatched, and
  // must never appear in the closing reply the operator is shown when a run completes.
  const answer = prose ? prose.cloneNode(true) : null;
  if (answer) {
    for (const sel of [
      "button", "[role=\"button\"]", "[role=\"link\"]", "a[href]", "nav", "aside", "footer", "header",
      "svg", "img", "input", "textarea", "select", "video", "audio", "iframe", "noscript",
      "[data-testid*=\"copy\" i]", "[data-testid*=\"follow\" i]", "[class*=\"follow-up\" i]",
      "[class*=\"followup\" i]", "[class*=\"suggested\" i]", "[aria-label*=\"suggest\" i]",
      "[aria-label*=\"copy\" i]", "[title*=\"copy\" i]",
    ])
      for (const node of answer.querySelectorAll(sel)) node.remove();
  }
  const composer = [...q('div[data-lexical-editor="true"][contenteditable="true"]')].filter(vis)[0] ?? null;
  // While Perplexity is working, its stop button is on screen. That is the authoritative
  // generating signal — better than watching text grow, which stalls on long pauses.
  const stopLabels = [...new Set(q('button,[role="button"]').map((b) => (b.getAttribute("aria-label") ?? "").trim()))]
    .filter((s) => s && s.length <= 24 && /^\s*(stop|cancel|pause)\b/i.test(s));
  const finishedChip = q("button,[role=button]").map((b) => (b.getAttribute("title") ?? "").trim()).filter((t) => /^finished$/i.test(t))[0] ?? null;
  // Scroll distance, for the "am I still watching it stream?" signal.
  let distance = 0;
  if (last) {
    const scroller = [...q("div"), ...q("main")].filter((e) => e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))[0] ?? document.scrollingElement;
    if (scroller) distance = Math.max(0, Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop));
  }
  // Newest user bubble: the assistant partition's own wrapper carries a hashed CSS-module
  // class (`_root_<hash>`), which is unstable across deploys. The presence of ANY bubble
  // holding the expected text is what we actually confirm, so no hashed name is used.
  const bubbleTexts = q("[data-workflow-entry],[data-message-bubble]").map((e) => norm(text(e)));
  return {
    url: location.href,
    answerText: text(answer),
    // `code.innerText`, never `pre.innerText`: the latter includes the language chip and
    // the copy-button label, which would land inside the instruction.
    blocks: answer
      ? [...answer.querySelectorAll("pre")].map((pre) => {
          const code = pre.querySelector("code");
          const chips = [...pre.querySelectorAll("span")].map((s) => (s.textContent ?? "").trim()).filter((t) => t && t.length <= 12);
          return { label: chips[0] ?? "text", content: code ? text(code) : text(pre) };
        })
      : [],
    // Reported alongside the answer so a caller can see what was excluded rather than trusting
    // that nothing was. Never part of the answer itself.
    chromeSkipped: prose ? (prose.querySelectorAll("button,[role=\"button\"],a[href]").length ?? 0) : 0,
    // The page states its own status in the header when it can; otherwise the stop
    // button's presence is the answer. Reporting "Finished" because a byte-streak
    // elapsed is exactly the mistake this endpoint must not make.
    status: stopLabels.length ? "Generating" : finishedChip ? "Finished" : "Idle",
    generating: stopLabels.length > 0,
    stopLabels,
    distanceFromBottom: distance,
    threadNodes: q("[data-workflow-entry],[data-workflow-final-text]").length,
    composerEmpty: composer ? norm(text(composer)) === "" : false,
    composerChars: composer ? text(composer).replace(/\u200b/g, "").length : -1,
    bubbleTexts,
    entryTexts: q("[data-workflow-entry]").map((e) => norm(text(e))),
  };
}
