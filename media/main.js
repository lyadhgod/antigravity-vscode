// @ts-check
/*
 * Antigravity — webview front-end.
 *
 * Talks to the host via the typed protocol (src/ui/protocol.ts). It renders a
 * two-step panel: a sessions list (step 1) and a per-session chat (step 2),
 * switched with body[data-view]. It also owns: a small HTML-safe Markdown
 * renderer, streamed assistant replies, the sign-in gate, the slash navigator,
 * the unified send/stop button, and the expand/collapse composer.
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

  // Material 3 (Expressive) loading indicator: a single primary shape that
  // morphs between a circle and a 4-lobe "cookie" (from the M3 shape library)
  // while rotating — per m3.material.io/components/loading-indicator. SMIL keeps
  // the animation self-contained (no CSP-blocked script); the two paths share an
  // identical command structure so `d` interpolates smoothly.
  const L_CIRCLE = "M24 6C28.24 6 33.73 8.27 36.73 11.27C39.73 14.27 42 19.76 42 24C42 28.24 39.73 33.73 36.73 36.73C33.73 39.73 28.24 42 24 42C19.76 42 14.27 39.73 11.27 36.73C8.27 33.73 6 28.24 6 24C6 19.76 8.27 14.27 11.27 11.27C14.27 8.27 19.76 6 24 6Z";
  const L_COOKIE = "M24 5C26.71 5 28.97 12.7 32.13 15.87C35.3 19.03 43 21.29 43 24C43 26.71 35.3 28.97 32.13 32.13C28.97 35.3 26.71 43 24 43C21.29 43 19.03 35.3 15.87 32.13C12.7 28.97 5 26.71 5 24C5 21.29 12.7 19.03 15.87 15.87C19.03 12.7 21.29 5 24 5Z";
  function loaderSvg(px) {
    return (
      '<svg class="m3-loader" width="' + px + '" height="' + px + '" viewBox="0 0 48 48" role="progressbar" aria-label="Loading">' +
        '<g>' +
          '<path fill="currentColor" d="' + L_CIRCLE + '">' +
            '<animate attributeName="d" dur="1.6s" repeatCount="indefinite" calcMode="spline" ' +
              'keyTimes="0;0.5;1" keySplines="0.2 0 0 1;0.2 0 0 1" values="' + L_CIRCLE + ';' + L_COOKIE + ';' + L_CIRCLE + '"/>' +
          '</path>' +
          '<animateTransform attributeName="transform" type="rotate" dur="2.2s" repeatCount="indefinite" from="0 24 24" to="360 24 24"/>' +
        '</g>' +
      '</svg>'
    );
  }

  const transcript = $("transcript");
  const pinned = $("pinned");
  const pinnedBody = $("pinned-body");
  const pinnedMore = /** @type {HTMLButtonElement} */ ($("pinned-more"));
  const listEl = $("list");
  const sessionsEl = $("sessions");
  const input = /** @type {HTMLTextAreaElement} */ ($("input"));
  const action = /** @type {HTMLButtonElement} */ ($("action"));
  const slashEl = $("slash");

  const state = {
    ready: false,
    busy: false,
    /** @type {{body:HTMLElement, text:string, loading:boolean}|null} */
    current: null,
    catalog: [],
    matches: [],
    /** @type {HTMLElement[]} */
    slashEls: [],
    slashIndex: 0,
    // Active option-selector card surfaced from the live TUI (the model picker,
    // a sign-in method, a clarifying/permission question), or null.
    /** @type {HTMLElement|null} */
    promptEl: null,
    /** Dedicated text box shown after a "Write-in" option is chosen (#5). */
    /** @type {HTMLElement|null} */
    writeInEl: null,
    awaitingPrompt: false,
    // New-session launch toggles (#5); seeded once from settings defaults.
    newOptions: { sandbox: false, skipPermissions: false },
    defaultsApplied: false,
    // Sign-in gate: true while a refresh re-probe is in flight; once the user
    // chooses "Continue anyway" we stop forcing the gate for this session.
    rechecking: false,
    proceeded: false,
    // 2-way input binding (#9): the last value we mirrored from the CLI, and when
    // we last submitted (to ignore our own echo settling).
    reflected: "",
    lastSubmit: 0,
    // A spinner / background /tasks is active (non-blocking loader).
    working: false
  };

  function setView(v) {
    // Leaving the sign-in gate: reset its card to the initial "not signed in"
    // view, so a later return starts clean (Sign in button showing, no leftover
    // OAuth URL/code controls, loader, or disabled state).
    if (document.body.dataset.view === "gate" && v !== "gate") resetGateCard();
    document.body.dataset.view = v;
  }

  // ===========================================================================
  //  Markdown (escape-first)
  // ===========================================================================
  function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function inline(t) {
    return t.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  }
  function renderMarkdown(src) {
    const blocks = [];
    // Stash code blocks behind a NUL sentinel (a plain " 12 " in prose must not
    // be mistaken for a placeholder — that produced "undefined" in the output).
    src = src.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) => { blocks.push("<pre><code>" + escapeHtml(code.replace(/\n+$/, "")) + "</code></pre>"); return "\u0000" + (blocks.length - 1) + "\u0000"; });
    const out = []; let para = []; let listType = null;
    const flushPara = () => { if (para.length) { out.push("<p>" + inline(escapeHtml(para.join(" "))) + "</p>"); para = []; } };
    const closeList = () => { if (listType) { out.push("</" + listType + ">"); listType = null; } };
    for (const line of src.split(/\r?\n/)) {
      const t = line.trim(); let m;
      if (/^\u0000\d+\u0000$/.test(t)) { flushPara(); closeList(); out.push(t); }
      else if (t === "") { flushPara(); closeList(); }
      else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flushPara(); closeList(); const l = m[1].length; out.push("<h" + l + ">" + inline(escapeHtml(m[2])) + "</h" + l + ">"); }
      else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { flushPara(); if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; } out.push("<li>" + inline(escapeHtml(m[1])) + "</li>"); }
      else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { flushPara(); if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; } out.push("<li>" + inline(escapeHtml(m[1])) + "</li>"); }
      else para.push(line);
    }
    flushPara(); closeList();
    return out.join("\n").replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  }

  // The agent prefixes a "▸ Thought for Xs, Y tokens" reasoning summary before
  // its answer. That's meta, not output — render those lines dimmed, and keep the
  // real answer as normal markdown.
  function renderAssistant(text) {
    const out = []; let chunk = []; let meta = []; let inMeta = false;
    const flushChunk = () => { if (chunk.length) { out.push(renderMarkdown(chunk.join("\n"))); chunk = []; } };
    const flushMeta = () => { if (meta.length) { out.push('<div class="msg__meta">' + meta.map((l) => "<div>" + inline(escapeHtml(l)) + "</div>").join("") + "</div>"); meta = []; } };
    for (const raw of text.split(/\r?\n/)) {
      // After a selector, agy summarises with "? <question>" then the answer —
      // show the question without the leading "?" (#3).
      const line = raw.replace(/^(\s*)\?\s+/, "$1");
      if (/^\s*▸/.test(line)) { flushChunk(); inMeta = true; meta.push(line.trim()); continue; }
      if (inMeta) {
        if (line.trim() === "") { flushMeta(); inMeta = false; } else { meta.push(line.trim()); }
        continue;
      }
      chunk.push(line);
    }
    flushMeta(); flushChunk();
    return out.join("\n");
  }

  // ===========================================================================
  //  Sessions list (step 1)
  // ===========================================================================
  function relTime(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const h = Math.floor(mins / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function renderList(sessions) {
    sessionsEl.innerHTML = "";
    listEl.dataset.empty = String(sessions.length === 0);
    for (const s of sessions) {
      const item = el("div", "session"); item.setAttribute("role", "listitem"); item.dataset.id = s.id;
      const main = el("div", "session__main");
      const title = el("span", "session__title"); title.textContent = s.title || "New Session";
      const time = el("span", "session__time"); time.textContent = relTime(s.updatedAt);
      main.append(title, time);
      main.addEventListener("click", () => vscode.postMessage({ type: "openSession", id: s.id }));
      item.appendChild(main);
      // Running indicator (left of delete) for in-flight sessions (#5).
      if (s.running) { const r = el("div", "session__running"); r.innerHTML = loaderSvg(16); item.appendChild(r); }
      const del = el("button", "session__delete"); del.title = "Delete chat"; del.setAttribute("aria-label", "Delete chat");
      del.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9z"/></svg>';
      del.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "deleteSession", id: s.id }); });
      item.appendChild(del);
      sessionsEl.appendChild(item);
    }
  }

  // ===========================================================================
  //  Transcript (step 2)
  // ===========================================================================
  function scrollToBottom() { transcript.scrollTop = transcript.scrollHeight; updatePinned(); }

  function addMessage(kind, html) {
    const m = el("div", "msg msg--" + kind); m.innerHTML = html; transcript.appendChild(m);
    if (kind === "user") clampMessage(m); // long inputs get a "Show more" (#2)
    scrollToBottom(); return m;
  }

  function renderHistory(messages) {
    transcript.innerHTML = ""; state.current = null; clearPrompt(); clearWriteIn();
    for (const msg of messages) {
      const kind = msg.role === "user" ? "user" : msg.role === "system" ? "system" : "assistant";
      addMessage(kind, kind === "assistant" ? renderAssistant(msg.text) : renderMarkdown(msg.text));
    }
    updatePinned();
  }

  // --- Pinned latest input + "Show more" clamp (#2) -------------------------
  // The clamp height (px) above which an input bubble / the pin is collapsed
  // behind a "Show more" toggle. Must match the CSS max-heights.
  const PIN_MAX = 96;
  const MSG_MAX = 180;
  let pinnedSrc = null; // the user-message element currently mirrored in the pin
  let pinRaf = 0;

  // Show the "Show more" toggle on a clamp body only when it actually overflows.
  function fitClamp(bodyEl, moreBtn, maxPx, clampClass) {
    bodyEl.classList.remove("is-open");
    const overflow = bodyEl.scrollHeight > maxPx + 2;
    bodyEl.classList.toggle(clampClass, overflow);
    moreBtn.hidden = !overflow;
    moreBtn.textContent = "Show more";
  }

  // A long user-input bubble: clamp it and add a "Show more" toggle beneath it.
  function clampMessage(m) {
    if (m.scrollHeight <= MSG_MAX + 2) return;
    m.classList.add("msg--clamp");
    const btn = el("button", "showmore showmore--user");
    btn.type = "button"; btn.textContent = "Show more";
    btn.addEventListener("click", () => {
      const open = m.classList.toggle("is-open");
      btn.textContent = open ? "Show less" : "Show more";
      updatePinned();
    });
    m.after(btn);
  }

  // Pin the most recent user input that has scrolled above the transcript's top
  // edge; it changes as the user scrolls up (#2). Hidden when none is above.
  function updatePinned() {
    if (document.body.dataset.view !== "chat") { pinned.hidden = true; pinnedSrc = null; return; }
    const topEdge = transcript.getBoundingClientRect().top;
    let pick = null;
    transcript.querySelectorAll(".msg--user").forEach((u) => {
      if (u.getBoundingClientRect().top < topEdge + 2) pick = u;
    });
    if (!pick) { pinned.hidden = true; pinnedSrc = null; return; }
    pinned.hidden = false;
    if (pick !== pinnedSrc) {
      pinnedSrc = pick;
      pinnedBody.innerHTML = pick.innerHTML;
      fitClamp(pinnedBody, pinnedMore, PIN_MAX, "is-clamp");
    }
  }
  pinnedMore.addEventListener("click", () => {
    const open = pinnedBody.classList.toggle("is-open");
    pinnedMore.textContent = open ? "Show less" : "Show more";
  });
  transcript.addEventListener("scroll", () => {
    if (pinRaf) return;
    pinRaf = requestAnimationFrame(() => { pinRaf = 0; updatePinned(); });
  });
  window.addEventListener("resize", () => updatePinned());

  function beginAssistant() {
    const wrap = el("div", "msg msg--assistant");
    const body = el("div");
    body.innerHTML = loaderSvg(30); // M3 Expressive loading indicator
    wrap.appendChild(body); transcript.appendChild(wrap);
    state.current = { wrap, body, text: "", loading: true };
    dropStrayLoaders(); scrollToBottom();
  }

  // Strictly reconcile the transcript's loading indicators with the live state:
  // a loader may ONLY exist while a turn is in flight (busy/working) and ONLY on
  // the current bubble. Once nothing is in flight, every loader is removed — so a
  // finished turn can never leave a spinner (or an empty "loading" bubble)
  // behind. (Session-list + #bgtask loaders live outside the transcript.)
  function dropStrayLoaders() {
    const keep = (state.busy || state.working) && state.current ? state.current.wrap : null;
    // Trailing "working" spinners baked into bubbles by paintAssistant.
    transcript.querySelectorAll(".msg__working").forEach((s) => {
      if (!keep || !keep.contains(s)) s.remove();
    });
    // Orphaned "loading" bubbles (just a big loader, no text yet).
    transcript.querySelectorAll(".msg--assistant").forEach((wrap) => {
      if (wrap === keep) return;
      if (wrap.querySelector(".m3-loader") && wrap.textContent.trim() === "") wrap.remove();
    });
  }

  // ===========================================================================
  //  Option selector intercepted from the live TUI
  // ===========================================================================
  // A still-empty assistant bubble (just the spinner) is dropped so the option
  // card reads cleanly; any already-streamed text stays put.
  function dropEmptyLoader() {
    if (state.current && state.current.loading && state.current.wrap) {
      state.current.wrap.remove(); state.current = null;
    }
  }
  function clearPrompt() {
    if (state.promptEl) { state.promptEl.remove(); state.promptEl = null; }
    state.awaitingPrompt = false; document.body.classList.remove("awaiting-prompt"); refreshLock();
  }
  function clearWriteIn() { if (state.writeInEl) { state.writeInEl.remove(); state.writeInEl = null; } }
  // A "Write-in" option was chosen (#5): pop up a dedicated text box (the main
  // composer is locked while the agent works) that sends the typed answer to the
  // CLI's now-active text input.
  function showWriteIn(label) {
    clearWriteIn();
    const box = el("div", "writein");
    const inp = /** @type {HTMLInputElement} */ (el("input", "writein__input"));
    inp.type = "text";
    inp.placeholder = "Type your " + (label && !/^write[\s-]?in/i.test(label) ? label.replace(/\s*…?$/, "") : "answer") + "…";
    const sendBtn = el("button", "writein__send"); sendBtn.type = "button"; sendBtn.textContent = "Send";
    const go = () => { const t = inp.value.trim(); if (!t) return; vscode.postMessage({ type: "sendText", text: t }); clearWriteIn(); };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    sendBtn.addEventListener("click", go);
    box.append(inp, sendBtn);
    transcript.appendChild(box); state.writeInEl = box; scrollToBottom(); inp.focus();
  }
  function answerCard(card, optsEl, picked) {
    if (card.dataset.done) return;          // ignore double-clicks
    card.dataset.done = "1"; card.classList.add("prompt--answered");
    if (optsEl) [...optsEl.children].forEach((c, i) => c.classList.toggle("prompt__option--picked", i === picked));
  }
  // A signature of the selector's structure (labels/layout/multi) — when only the
  // caret position or checkbox states change we update in place (keeping focus +
  // any half-typed write-in) instead of rebuilding.
  function promptSig(p) {
    return p.layout + "|" + (p.multi ? "m" : "s") + "|" + (p.context || "") + "|" +
      p.options.map((o) => (o.writeIn ? "w:" : "o:") + o.label).join("\u0001");
  }
  function cancelPrompt(card) { answerCard(card, null, -1); vscode.postMessage({ type: "promptCancel" }); }

  // Renders one option's label. The live TUI packs a secondary description and a
  // "(current)" marker onto the same row, separated by 2+ spaces, e.g.
  // "request-review  (current)  Prompt for write, bash, and web tools" (seen on
  // /model, /permissions, /hooks). Split that into a bold name, a "current" pill,
  // and a muted description instead of showing one long run-on label.
  function fillOptionLabel(host, labelText) {
    const parts = String(labelText).split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    let isCurrent = false;
    const rest = [];
    for (const part of parts) {
      if (/^\(?current\)?$/i.test(part)) { isCurrent = true; continue; }
      rest.push(part);
    }
    const name = el("span", "prompt__name"); name.textContent = rest.shift() || String(labelText);
    host.appendChild(name);
    if (isCurrent) { const badge = el("span", "prompt__badge"); badge.textContent = "current"; host.appendChild(badge); }
    if (rest.length) { const desc = el("span", "prompt__desc"); desc.textContent = rest.join(" — "); host.appendChild(desc); }
  }

  function buildRow(card, p, o, i) {
    const current = i === p.selectedIndex ? " prompt__option--current" : "";
    if (o.writeIn) {
      // A "Write-in" option is just a choice (#8): selecting it makes the CLI wait
      // for free text, which the user then types into the (now 2-way bound) chat
      // box — no inline "Add" field.
      const b = el("button", "prompt__option prompt__option--writein" + current);
      b.type = "button"; b.tabIndex = -1; b.dataset.i = String(i);
      b.textContent = (o.label || "Write in") + " …";
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        answerCard(card, card.querySelector(".prompt__options"), i);
        vscode.postMessage({ type: "selectOption", index: i });
        showWriteIn(o.label); // the CLI now awaits text — pop up a box for it (#5)
      });
      return b;
    }
    if (p.multi) {
      const row = el("button", "prompt__option prompt__option--check" + current); row.type = "button"; row.tabIndex = -1;
      row.dataset.i = String(i); row.setAttribute("role", "checkbox"); row.setAttribute("aria-checked", String(!!o.checked));
      const box = el("span", "prompt__check" + (o.checked ? " is-checked" : ""));
      const lab = el("span", "prompt__label prompt__text"); fillOptionLabel(lab, o.label);
      row.append(box, lab);
      row.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus on the card
      row.addEventListener("click", () => toggleRow(card, i));
      return row;
    }
    const b = el("button", "prompt__option" + current); b.type = "button"; b.tabIndex = -1;
    b.dataset.i = String(i);
    const text = el("span", "prompt__text"); fillOptionLabel(text, o.label); b.appendChild(text);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => { answerCard(card, card.querySelector(".prompt__options"), i); vscode.postMessage({ type: "selectOption", index: i }); });
    return b;
  }

  function toggleRow(card, i) {
    const row = card.querySelector('.prompt__option[data-i="' + i + '"]');
    if (row) { const box = row.querySelector(".prompt__check"); const now = box && !box.classList.contains("is-checked"); if (box) box.classList.toggle("is-checked", !!now); row.setAttribute("aria-checked", String(!!now)); }
    vscode.postMessage({ type: "promptToggle", index: i });
  }
  function onPromptKey(e, card) {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t && t.classList && t.classList.contains("prompt__writein")) {
      if (e.key === "Escape") { e.preventDefault(); cancelPrompt(card); }
      return; // let typing / cursor arrows work inside the write-in field
    }
    if (t !== card) return; // a focused button keeps its own Enter/click behavior
    const p = state.promptData; if (!p) return;
    const next = p.layout === "horizontal" ? "ArrowRight" : "ArrowDown";
    const prev = p.layout === "horizontal" ? "ArrowLeft" : "ArrowUp";
    if (e.key === next) { e.preventDefault(); vscode.postMessage({ type: "promptMove", dir: "next" }); }
    else if (e.key === prev) { e.preventDefault(); vscode.postMessage({ type: "promptMove", dir: "prev" }); }
    else if ((e.key === "x" || e.key === " ") && p.multi) { e.preventDefault(); toggleRow(card, p.selectedIndex); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (p.multi) { answerCard(card, null, -1); vscode.postMessage({ type: "promptSubmit" }); }
      else { answerCard(card, card.querySelector(".prompt__options"), p.selectedIndex); vscode.postMessage({ type: "selectOption", index: p.selectedIndex }); }
    } else if (e.key === "Escape") { e.preventDefault(); cancelPrompt(card); }
  }

  // Update an already-rendered card to match a new frame (caret + checkboxes).
  function syncPrompt(p) {
    state.promptData = p;
    const card = state.promptEl; if (!card) return;
    card.querySelectorAll(".prompt__option").forEach((row) => {
      const i = Number(row.dataset.i); const o = p.options[i];
      row.classList.toggle("prompt__option--current", i === p.selectedIndex);
      if (o && p.multi) {
        const box = row.querySelector(".prompt__check");
        if (box) box.classList.toggle("is-checked", !!o.checked);
        row.setAttribute("aria-checked", String(!!o.checked));
      }
    });
  }

  function renderPrompt(p) {
    // In-place update (caret move / checkbox toggle) only while the SAME card is
    // still unanswered. Once it's been answered, a new prompt — even one with the
    // same options (e.g. back-to-back "Yes/No" permission prompts) — is a fresh
    // selector and must be rebuilt clickable, not reuse the disabled card.
    if (state.promptEl && state.promptSig === promptSig(p) && !state.promptEl.dataset.done) { syncPrompt(p); return; }
    clearPrompt(); dropEmptyLoader();
    const card = el("div", "prompt prompt--" + (p.layout === "horizontal" ? "horizontal" : "vertical") + (p.multi ? " prompt--multi" : ""));
    card.tabIndex = 0; card.setAttribute("role", p.multi ? "group" : "listbox");
    card.setAttribute("aria-label", p.title || "Choose an option");
    // Prompt framing that belongs to the selector (e.g. "Requesting permission
    // for: npm run lint") shown inside the card, above the question.
    if (p.context) { const cx = el("div", "prompt__context"); cx.textContent = p.context; card.appendChild(cx); }
    if (p.title) { const h = el("div", "prompt__title"); h.textContent = p.title; card.appendChild(h); }
    const opts = el("div", "prompt__options");
    p.options.forEach((o, i) => opts.appendChild(buildRow(card, p, o, i)));
    card.appendChild(opts);
    const actions = el("div", "prompt__actions");
    if (p.multi) {
      const submit = el("button", "prompt__submit"); submit.type = "button"; submit.textContent = "Submit";
      submit.addEventListener("click", () => { answerCard(card, null, -1); vscode.postMessage({ type: "promptSubmit" }); });
      actions.appendChild(submit);
    }
    const cancel = el("button", "prompt__cancel"); cancel.type = "button"; cancel.textContent = p.multi ? "Skip" : "Cancel";
    cancel.addEventListener("click", () => cancelPrompt(card));
    actions.appendChild(cancel);
    card.appendChild(actions);
    card.addEventListener("keydown", (e) => onPromptKey(e, card));
    transcript.appendChild(card);
    state.promptEl = card; state.promptData = p; state.promptSig = promptSig(p);
    state.awaitingPrompt = true; document.body.classList.add("awaiting-prompt"); refreshLock();
    card.focus(); scrollToBottom();
  }
  // The reply is re-scraped from the live agy TUI on each repaint, so the host
  // sends the FULL current text; we replace the bubble. Empty text ⇒ still
  // waiting, so keep the loader showing.
  // Paints the bubble's text plus, while the agent is still working (busy), a
  // small trailing loader — so "⣷ Working…" shows a spinner even after some text.
  function paintAssistant(c) {
    c.body.innerHTML = renderAssistant(c.text) + (state.busy || state.working ? ' <span class="msg__working" aria-label="Working">' + loaderSvg(16) + "</span>" : "");
    dropStrayLoaders(); // never leave an older bubble's loader showing too
  }
  function setAssistant(text) {
    if (!state.current) beginAssistant();
    const c = state.current; if (!text) return;
    c.loading = false; c.text = text; paintAssistant(c); scrollToBottom();
  }
  function endAssistant(ok, timedOut) {
    const c = state.current;
    if (c) { if (c.loading) c.body.innerHTML = timedOut ? "<em>(request timed out)</em>" : "<em>(no output)</em>"; state.current = null; }
    dropStrayLoaders(); // a finished turn must not keep a trailing spinner
    if (!ok && !timedOut) addMessage("error", "The agent exited with an error.");
    updatePinned();
  }

  // ===========================================================================
  //  Sign-in / install gate (#7)
  // ===========================================================================
  function applyState(s) {
    state.ready = s.ready;
    // Seed the New Session toggles from the settings defaults, once (#5).
    if (s.defaults && !state.defaultsApplied) {
      optSandbox.checked = !!s.defaults.sandbox;
      optSkip.checked = !!s.defaults.skipPermissions;
      state.defaultsApplied = true;
      syncNewopts();
    }
    state.rechecking = false;
    resetRecheck();
    if (!s.ready) {
      if (s.action === "notfound") {
        setView("notfound");
      } else if (state.proceeded) {
        // The user chose to continue past an unconfirmed sign-in; don't bounce
        // them back to the gate on later re-probes (e.g. tab focus changes).
        if (document.body.dataset.view !== "chat") setView("list");
      } else {
        setView("gate");
        // The sign-in check is a best-effort disk probe (newer CLIs keep the
        // token in the OS keychain; a terminal login leaves no file we can see),
        // so a valid session can read as "signed out" (#3, #5). The single
        // "Already signed in?" button re-probes AND proceeds, so those users are
        // never trapped — no separate "continue anyway" needed.
        $("gate-message").textContent = s.message || "Sign in with your Google account to start using Antigravity.";
      }
    } else if (document.body.dataset.view !== "chat") {
      setView("list");
    }
  }

  // ===========================================================================
  //  Composer + send/stop (#2)
  // ===========================================================================
  const expandBtn = $("expand");
  // Height is CSS-driven now: one line when collapsed (#1), full height when
  // expanded (#2) — no JS autosize. While the agent is busy OR a selector is up,
  // lock the input + expander but keep the stop button live (#6).
  function locked() { return state.busy || state.awaitingPrompt; }
  function refreshLock() {
    const l = locked();
    document.body.classList.toggle("locked", l);
    action.dataset.busy = String(l);
    action.title = l ? "Stop" : "Send (Enter)"; action.setAttribute("aria-label", l ? "Stop" : "Send");
    input.readOnly = l; expandBtn.disabled = l;
  }
  function setBusy(busy) {
    state.busy = busy; refreshLock();
    const c = state.current; // add/remove the trailing "still working" spinner
    if (c && !c.loading && c.text) paintAssistant(c);
    dropStrayLoaders(); // when no longer busy, strip any lingering loader
  }
  // A spinner or /tasks background task is (in)active — a non-blocking loader:
  // a trailing spinner on the current bubble, or a chip above the composer when
  // there's no active turn (e.g. a dev server left running).
  const bgtask = $("bgtask");
  function setWorking(w) {
    state.working = w;
    const c = state.current;
    if (c && !c.loading && c.text) paintAssistant(c);
    // The chip is the loader ONLY when there's no active turn bubble to host the
    // trailing spinner (e.g. a dev server left running after the turn finished) —
    // otherwise we'd show two loaders at once.
    if (w && !state.busy && !state.current) {
      if (!$("bgtask-icon").innerHTML) $("bgtask-icon").innerHTML = loaderSvg(16);
      bgtask.hidden = false;
    } else {
      bgtask.hidden = true;
    }
    dropStrayLoaders(); // keep the in-bubble loader in sync with working state
  }
  function submit() {
    const text = input.value.trim(); if (!text || locked()) return;
    hideSlash(); vscode.postMessage({ type: "submit", text });
    input.value = ""; state.reflected = ""; state.lastSubmit = Date.now();
  }
  // 2-way (#9): mirror the CLI's input box into the chat box — but never clobber
  // what the user is actively typing, and ignore our own just-sent echo.
  function reflectInput(text) {
    if (document.activeElement === input || locked()) return;
    if (Date.now() - state.lastSubmit < 700) return;
    if (input.value === "" || input.value === state.reflected) {
      if (input.value !== text) input.value = text;
      state.reflected = text;
    }
  }
  // Stop always fully interrupts (#6/#7): discard the in-progress message UI — an
  // empty loader bubble and any selector card — keep text that already streamed,
  // then tell the host to cancel the CLI act.
  function interrupt() {
    clearPrompt(); clearWriteIn();
    const c = state.current;
    if (c) { if (c.loading && c.wrap) c.wrap.remove(); state.current = null; }
    state.busy = false; refreshLock();
    vscode.postMessage({ type: "cancel" });
  }
  action.addEventListener("click", () => (locked() ? interrupt() : submit()));

  // Toggle expanded/collapsed with a FLIP slide so the expand button visibly
  // moves down onto the send button (and back) instead of snapping (#3).
  function toggleExpand() {
    const btns = [action, expandBtn];
    const first = btns.map((b) => b.getBoundingClientRect());
    document.body.classList.toggle("expanded");
    const expanded = document.body.classList.contains("expanded");
    expandBtn.title = expanded ? "Collapse editor" : "Expand editor";
    expandBtn.setAttribute("aria-label", expanded ? "Collapse editor" : "Expand editor");
    btns.forEach((b, i) => {
      const last = b.getBoundingClientRect();
      const dx = first[i].left - last.left, dy = first[i].top - last.top;
      if (!dx && !dy) return;
      b.style.transition = "none";
      b.style.transform = "translate(" + dx + "px," + dy + "px)";
      requestAnimationFrame(() => {
        // #1: a clean glide, no springy overshoot.
        b.style.transition = "transform 240ms var(--ag-ease-emphasized)";
        b.style.transform = "";
        b.addEventListener("transitionend", function done() { b.style.transition = ""; b.removeEventListener("transitionend", done); });
      });
    });
    input.focus();
  }
  expandBtn.addEventListener("click", toggleExpand);

  // ===========================================================================
  //  New-session options dropdown (#5)
  // ===========================================================================
  const newopts = $("newopts");
  const newoptsBtn = $("newopts-btn");
  const newoptsMenu = $("newopts-menu");
  const optSandbox = /** @type {HTMLInputElement} */ ($("opt-sandbox"));
  const optSkip = /** @type {HTMLInputElement} */ ($("opt-skip"));

  function syncNewopts() {
    state.newOptions = { sandbox: optSandbox.checked, skipPermissions: optSkip.checked };
    newoptsBtn.classList.toggle("active", optSandbox.checked || optSkip.checked);
  }
  function toggleNewopts(show) {
    const open = show === undefined ? newoptsMenu.hidden : show;
    newoptsMenu.hidden = !open;
    newoptsBtn.setAttribute("aria-expanded", String(open));
  }
  newoptsBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleNewopts(); });
  optSandbox.addEventListener("change", syncNewopts);
  optSkip.addEventListener("change", syncNewopts);
  document.addEventListener("click", (e) => {
    if (!newoptsMenu.hidden && !newopts.contains(/** @type {Node} */ (e.target))) toggleNewopts(false);
  });

  // Navigation buttons.
  $("back").addEventListener("click", () => { setView("list"); vscode.postMessage({ type: "back" }); });
  $("new-session").addEventListener("click", () => {
    toggleNewopts(false);
    vscode.postMessage({ type: "newSession", options: state.newOptions });
  });
  // Refresh re-probes the CLI (sign-in / install state). Give it visible feedback
  // so it never looks dead — disable + "Checking…"; applyState() restores it when
  // the host replies (it always does, even on error).
  function recheck(btn) {
    state.rechecking = true;
    if (btn) { if (!btn.dataset.label) btn.dataset.label = btn.textContent; btn.disabled = true; btn.textContent = "Checking…"; }
    vscode.postMessage({ type: "ready" });
  }
  function resetRecheck() {
    for (const id of ["gate-check", "notfound-refresh"]) {
      const b = $(id); if (b) { b.disabled = false; if (b.dataset.label) b.textContent = b.dataset.label; }
    }
    $("gate-action").disabled = false;
  }

  // --- Sign-in flow (#7): OAuth URL + code controls in the gate card --------
  const gateUrlRow = $("gate-url-row");
  const gateCodeRow = $("gate-code-row");
  const gateCode = /** @type {HTMLInputElement} */ ($("gate-code"));
  const gateCodeSubmit = $("gate-code-submit");
  const gateCodeIcon = gateCodeSubmit.innerHTML; // the checkmark, restored after a submit
  // The "Sign in with Google" button and the URL/code controls are mutually
  // exclusive: once the CLI has reached the OAuth screen, "Sign in" no longer
  // does anything useful (a session is already running), so it's hidden
  // entirely rather than merely disabled-but-visible.
  function setLoginUrlControlsVisible(visible) {
    gateUrlRow.hidden = !visible;
    gateCodeRow.hidden = !visible;
    $("gate-action").hidden = visible;
  }
  // While the submitted code is being verified: keep the code visible in the box
  // (don't clear it), lock the whole row, and swap the checkmark for the same
  // M3 loading indicator used for the in-session busy state (#4).
  function setLoginSubmitting(on) {
    gateCodeSubmit.disabled = on;
    gateCode.readOnly = on;
    gateCodeRow.classList.toggle("is-submitting", on);
    gateCodeSubmit.classList.toggle("is-submitting", on);
    gateCodeSubmit.innerHTML = on ? loaderSvg(20) : gateCodeIcon;
  }
  function hideLoginControls() {
    setLoginUrlControlsVisible(false);
    setLoginSubmitting(false);
    gateCode.value = ""; gateCodeSubmit.classList.remove("is-active");
  }
  // Full reset to the initial gate view (also re-enables the Sign in button,
  // which hideLoginControls leaves as the login-in-progress disabled state).
  function resetGateCard() {
    hideLoginControls();
    $("gate-action").disabled = false;
  }
  function submitLoginCode() {
    if (gateCodeSubmit.disabled) return;
    const code = gateCode.value.trim(); if (!code) return;
    vscode.postMessage({ type: "loginSubmitCode", code });
    // Keep the code in the box and show the loading state until sign-in advances.
    setLoginSubmitting(true);
  }
  $("gate-action").addEventListener("click", () => {
    $("gate-action").disabled = true; hideLoginControls();
    vscode.postMessage({ type: "login" });
  });
  $("gate-copy").addEventListener("click", () => vscode.postMessage({ type: "loginCopyUrl" }));
  $("gate-open").addEventListener("click", () => vscode.postMessage({ type: "loginOpenUrl" }));
  $("gate-code-submit").addEventListener("click", submitLoginCode);
  gateCode.addEventListener("input", () => gateCodeSubmit.classList.toggle("is-active", gateCode.value.trim() !== ""));
  gateCode.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitLoginCode(); } });

  $("notfound-refresh").addEventListener("click", (e) => recheck(e.currentTarget));
  // "Already signed in?" checks BOTH possibilities in one click: re-probe auth
  // (catches a token that's now on disk) AND proceed regardless (covers a login
  // the disk check can't see — keychain / terminal). Either way you land in the
  // app; agy's own in-chat sign-in is the final safety net if truly signed out.
  $("gate-check").addEventListener("click", (e) => {
    state.proceeded = true;                       // a negative re-check won't bounce back to the gate
    vscode.postMessage({ type: "openAnyway" });   // populate sessions + proceed
    recheck(e.currentTarget);                     // re-probe auth; shows "Checking…"
  });

  // ===========================================================================
  //  Slash-command navigator (#8)
  // ===========================================================================
  function filterSlash(query) {
    const q = query.toLowerCase(); if (q === "" || q === "/") return state.catalog;
    const starts = state.catalog.filter((c) => c.name.toLowerCase().startsWith(q));
    const bare = q.replace(/^\//, "");
    return starts.concat(state.catalog.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(bare)));
  }
  function maybeShowSlash() {
    const token = input.value;
    if (token.startsWith("/") && !/\s/.test(token)) { state.matches = filterSlash(token); state.slashIndex = 0; renderSlash(); }
    else hideSlash();
  }
  function renderSlash() {
    document.body.classList.add("slash-open"); slashEl.hidden = false;
    if (state.matches.length === 0) { slashEl.innerHTML = '<div class="slash__empty">No matching commands — press Enter to send as-is.</div>'; state.slashEls = []; return; }
    slashEl.innerHTML = "";
    state.slashEls = state.matches.map((c, i) => {
      const item = el("div", "slash__item" + (i === state.slashIndex ? " selected" : "")); item.setAttribute("role", "option");
      item.innerHTML = '<span class="slash__name"></span><span class="slash__desc"></span>';
      item.querySelector(".slash__name").textContent = c.name;
      item.querySelector(".slash__desc").textContent = c.description;
      item.addEventListener("mousedown", (e) => { e.preventDefault(); chooseSlash(c); });
      slashEl.appendChild(item); return item;
    });
  }
  function updateSlashSelection() {
    state.slashEls.forEach((e, i) => e.classList.toggle("selected", i === state.slashIndex));
    const sel = state.slashEls[state.slashIndex]; if (sel) sel.scrollIntoView({ block: "nearest" }); // #3
  }
  function hideSlash() { slashEl.hidden = true; state.matches = []; state.slashEls = []; document.body.classList.remove("slash-open"); }
  function moveSlash(d) { if (!state.matches.length) return; state.slashIndex = (state.slashIndex + d + state.matches.length) % state.matches.length; updateSlashSelection(); }
  function chooseSlash(c) { input.value = c.name + (c.takesArgs ? " " : ""); hideSlash(); input.focus(); }

  input.addEventListener("input", () => { maybeShowSlash(); });
  input.addEventListener("blur", () => setTimeout(hideSlash, 120));
  input.addEventListener("keydown", (e) => {
    const open = !slashEl.hidden && state.matches.length > 0;
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); moveSlash(e.key === "ArrowDown" ? 1 : -1); }
    else if (open && (e.key === "Enter" || e.key === "Tab")) { e.preventDefault(); chooseSlash(state.matches[state.slashIndex]); }
    else if (e.key === "Escape" && !slashEl.hidden) { e.preventDefault(); hideSlash(); }
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  // ===========================================================================
  //  Host → webview
  // ===========================================================================
  window.addEventListener("message", (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "state": applyState(msg.state); break;
      case "slashCatalog": state.catalog = msg.commands; break;
      case "sessions":
        renderList(msg.sessions);
        if (state.ready && document.body.dataset.view !== "chat") setView("list");
        break;
      case "openSession": renderHistory(msg.messages); setView("chat"); input.focus(); updatePinned(); break;
      case "userMessage": addMessage("user", renderMarkdown(msg.text)); break;
      case "streamStart": if (!state.current) beginAssistant(); break;
      case "assistantText": setAssistant(msg.text); break;
      case "streamEnd": endAssistant(msg.ok, msg.timedOut); break;
      case "busy": setBusy(msg.value); break;
      case "prompt": renderPrompt(msg.prompt); break;
      case "promptEnd": clearPrompt(); break;
      case "cliInput": reflectInput(msg.text); break;
      case "working": setWorking(msg.value); break;
      case "loginUrl": setLoginUrlControlsVisible(true); break;
      case "loginError": hideLoginControls(); $("gate-action").disabled = false; $("gate-message").textContent = msg.message; break;
      case "system":
        if (msg.text === "__open_slash__") { input.value = "/"; input.focus(); maybeShowSlash(); }
        else addMessage("system", renderMarkdown(msg.text));
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
