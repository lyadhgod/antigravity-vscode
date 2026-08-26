// @ts-nocheck
/*
 * IME composition test for the webview front-end (#8).
 *
 * Loads the *real shipped* `media/main.js` against a minimal DOM stub — the
 * same idea as activation.test.js, which loads the real `dist/` bundle against
 * a mocked `vscode` — and replays the exact event sequences a Chinese IME
 * produces, in both orderings browsers use.
 *
 * What it protects: with an IME, Enter COMMITS the pre-edit text; it is not a
 * submit, and the arrow keys belong to the candidate window. The composer used
 * to act on those keys, which fired off half-typed pinyin as the prompt and
 * made Chinese unusable. It must take two Enters to send — commit, then send —
 * exactly as the `agy` CLI itself behaves.
 *
 * Plain JS (no compile step), so it runs from `test/integration/**`.
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** Element ids `main.js` looks up at load time; each gets a stub. */
const IDS = [
  "action", "back", "bgtask", "bgtask-icon", "expand", "gate-action", "gate-alert",
  "gate-check", "gate-code", "gate-code-row", "gate-code-submit", "gate-copy",
  "gate-message", "gate-open", "gate-url-row", "input", "list", "new-session",
  "newopts", "newopts-btn", "newopts-menu", "notfound-refresh", "opt-sandbox",
  "opt-skip", "sessions", "slash", "transcript"
];

/** The smallest element that `main.js` can be wired onto and driven through. */
function makeEl(tag = "div", id = "") {
  const listeners = new Map();
  const classes = new Set();
  const el = {
    tagName: tag.toUpperCase(), id, type: "", value: "", textContent: "", innerHTML: "",
    hidden: false, disabled: false, readOnly: false, checked: false, tabIndex: 0,
    placeholder: "", title: "", href: "", style: { setProperty() {} },
    dataset: {}, children: [], parentNode: null,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) { classes.add(c); } else { classes.delete(c); }
        return on;
      }
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) { listeners.set(type, []); }
      listeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const list = listeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) { list.splice(i, 1); }
    },
    /** Dispatch synchronously, like a real event. */
    dispatch: (type, event = {}) => {
      const e = { type, preventDefault() { e.defaultPrevented = true; }, stopPropagation() {}, target: el, currentTarget: el, ...event };
      for (const fn of (listeners.get(type) || []).slice()) { fn(e); }
      return e;
    },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
    appendChild: (c) => { el.children.push(c); c.parentNode = el; return c; },
    append: (...cs) => cs.forEach((c) => el.appendChild(c)),
    after() {}, remove() {}, focus() {}, blur() {}, scrollIntoView() {}, closest: () => null,
    querySelector: () => makeEl("span"), querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 })
  };
  return el;
}

/** Loads media/main.js into a fresh stubbed document; returns the handles a test drives. */
function loadWebview() {
  const els = new Map(IDS.map((id) => [id, makeEl("div", id)]));
  els.get("input").tagName = "TEXTAREA";
  const posted = [];
  const body = makeEl("body");
  const win = makeEl("window");

  const context = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    Date, Math, JSON, String, Number, Boolean, Array, Object, RegExp, Error,
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState() {}, setState() {} }),
    document: {
      body,
      activeElement: els.get("input"),
      getElementById: (id) => els.get(id) || makeEl("div", id),
      createElement: (tag) => makeEl(tag),
      addEventListener() {},
      querySelectorAll: () => []
    },
    window: win
  };
  context.window.document = context.document;
  vm.createContext(context);
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "media", "main.js"), "utf8");
  vm.runInContext(src, context, { filename: "media/main.js" });
  return {
    input: els.get("input"),
    posted,
    /** Host -> webview, the way ChatViewProvider posts. */
    post: (msg) => win.dispatch("message", { data: msg })
  };
}

/** One keydown, described the way a browser describes it. */
function key(el, k, extra = {}) {
  return el.dispatch("keydown", { key: k, keyCode: k === "Enter" ? 13 : 0, shiftKey: false, isComposing: false, ...extra });
}

// Messages are built inside the vm realm, so copy them into this one before
// comparing — deepStrictEqual also compares prototypes.
const submits = (posted) => posted.filter((m) => m.type === "submit").map((m) => ({ type: m.type, text: m.text }));
const nextTask = () => new Promise((r) => setTimeout(r, 0));

describe("webview IME composition (#8)", () => {
  it("does not send on the Enter that commits an IME composition (Chromium order)", async () => {
    const { input, posted } = loadWebview();
    // Chromium/Electron: the committing key press arrives as keydown with
    // isComposing=true (keyCode 229), and compositionend follows it.
    input.dispatch("compositionstart", {});
    input.value = "ni hao";                        // pre-edit text in the box
    input.dispatch("input", { isComposing: true });
    input.value = "你好";                          // candidate chosen
    key(input, "Enter", { isComposing: true, keyCode: 229 });
    input.dispatch("compositionend", { data: "你好" });

    assert.deepStrictEqual(submits(posted), [], "the committing Enter must not send");

    // A second, ordinary Enter is the one that sends.
    await nextTask();
    key(input, "Enter");
    assert.deepStrictEqual(submits(posted), [{ type: "submit", text: "你好" }]);
  });

  it("does not send when compositionend arrives BEFORE the committing keydown", async () => {
    const { input, posted } = loadWebview();
    // Some engines end the composition first, so isComposing is already false on
    // the keydown that committed it. The tracked flag covers that ordering.
    input.dispatch("compositionstart", {});
    input.value = "你好";
    input.dispatch("compositionend", { data: "你好" });
    key(input, "Enter");                            // same task as the commit

    assert.deepStrictEqual(submits(posted), [], "the committing Enter must not send");

    // The user's next Enter is a separate task, and does send.
    await nextTask();
    key(input, "Enter");
    assert.deepStrictEqual(submits(posted), [{ type: "submit", text: "你好" }]);
  });

  it("leaves Enter alone for the whole composition, however long", async () => {
    const { input, posted } = loadWebview();
    input.dispatch("compositionstart", {});
    for (const part of ["w", "wo", "wo shi", "我是"]) {
      input.value = part;
      input.dispatch("input", { isComposing: true });
      key(input, "Enter", { isComposing: true, keyCode: 229 });
    }
    assert.deepStrictEqual(submits(posted), []);
  });

  it("hands the arrow keys to the candidate window, not to the slash navigator", () => {
    const { input, posted, post } = loadWebview();
    // The reported flow (#8): type `/`, then compose — Down opens the IME's
    // candidate list and must not be stolen to move the command list. The
    // navigator has to be genuinely open for that to be a real test.
    post({ type: "slashCatalog", commands: [
      { name: "/help", description: "Show help", takesArgs: false },
      { name: "/model", description: "Pick a model", takesArgs: false }
    ] });
    input.value = "/";
    input.dispatch("input", { isComposing: false });
    input.dispatch("compositionstart", {});
    const down = key(input, "ArrowDown", { isComposing: true, keyCode: 229 });
    assert.strictEqual(down.defaultPrevented, undefined, "ArrowDown must reach the IME");
    const tab = key(input, "Tab", { isComposing: true, keyCode: 229 });
    assert.strictEqual(tab.defaultPrevented, undefined, "Tab must reach the IME");
    assert.deepStrictEqual(submits(posted), []);
  });

  it("still sends on a plain Enter with no IME in play", () => {
    const { input, posted } = loadWebview();
    input.value = "hello";
    input.dispatch("input", { isComposing: false });
    key(input, "Enter");
    assert.deepStrictEqual(submits(posted), [{ type: "submit", text: "hello" }]);
  });

  it("still honours Shift+Enter as a newline", () => {
    const { input, posted } = loadWebview();
    input.value = "hello";
    key(input, "Enter", { shiftKey: true });
    assert.deepStrictEqual(submits(posted), []);
  });
});
