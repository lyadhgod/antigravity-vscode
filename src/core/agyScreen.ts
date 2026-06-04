/**
 * Pure interpreter for the `agy` interactive TUI screen.
 *
 * Bare `agy` (interactive) renders a full-screen, cursor-addressed terminal UI:
 * a banner, the scrolling conversation, then a pinned input box + status line.
 * The owning service ([services/interactiveSession.ts]) feeds the PTY byte
 * stream through a headless terminal emulator (`@xterm/headless`) to reconstruct
 * the *rendered screen*, then hands the resulting lines here. This module turns
 * those lines into what the chat UI needs: the agent's run state and the
 * assistant's reply to a given prompt.
 *
 * Everything here is `vscode`-free and string-only, so it unit-tests on bare
 * Node against frames captured from the real CLI (test/unit/agyScreen.test.ts).
 *
 * Screen anatomy (observed on agy v1.0.4):
 *
 *       ▄▀▀▄        Antigravity CLI 1.0.4      ← banner: rocket art + header
 *      ▀▀▀▀▀▀       you@example.com                (version / account / model /
 *     ▀▀▀▀▀▀▀▀      Gemini 3.5 Flash (Medium)       working directory)
 *    ▄▀▀    ▀▀▄     /workspace
 *   ──────────────────────────────            ← rule
 *   > hi                                        ← user echo
 *     Hello! How can I help you today…          ← assistant prose (2-sp indent)
 *   ● ListDir(/workspace)                       ← tool call
 *     ⎿  …result…                               ← tool output (+ wrapped lines)
 *   ──────────────────────────────            ← input-box rule
 *   >                                           ← live input prompt
 *   ──────────────────────────────            ← input-box rule
 *   ? for shortcuts        Gemini 3.5 Flash     ← status line (idle)
 *
 * While the agent works, the status line reads "esc to cancel" and a braille
 * spinner + "Generating…" appear — that is how we detect the generating state.
 */

/**
 * Agent run state inferred from the rendered screen. `"prompt"` means the TUI is
 * blocking on an interactive **option selector** (the model picker, a sign-in
 * method choice, a tool-permission or clarifying question) — see {@link SelectPrompt}.
 */
export type AgyState = "starting" | "signin" | "generating" | "idle" | "prompt";

/** One visible exchange: the echoed user prompt and the assistant's prose. */
export interface Turn {
  user: string;
  assistant: string;
}

/** One row of a {@link SelectPrompt}. */
export interface SelectOption {
  /** Display label (caret, numbering, and `[ ]`/`[x]` checkbox glyph stripped). */
  label: string;
  /** Multi-select checkbox state — `true` for `[x]` (always false for single-select). */
  checked: boolean;
  /** A free-text "Write-in…" row: choosing it makes the CLI wait for typed text. */
  writeIn: boolean;
}

/**
 * An option selector the TUI is waiting on. `agy` renders these as a caret-marked
 * list (`> focused`, two-space others) under a heading, with a footer like
 * "↑/↓ Navigate · enter Select". We surface them so the chat UI can show the
 * options as buttons/checkboxes and drive the choice back into the CLI (instead
 * of the user having to arrow-key through the hidden TUI). Verified against agy
 * v1.0.4 (the `/model` picker, tool-permission prompts, multi-select questions,
 * and first-run onboarding).
 */
export interface SelectPrompt {
  /** Heading directly above the options, e.g. "Do you want to proceed?" ("" if none). */
  title: string;
  /**
   * Framing shown above the title that belongs to the selector, not the
   * conversation — e.g. a tool-permission prompt's "Requesting permission for:
   * <cmd>". Rendered inside the card (above the title); "" when there is none.
   */
  context: string;
  /** The rows, top-to-bottom (vertical) or left-to-right (horizontal). */
  options: SelectOption[];
  /** Index of the option the TUI caret currently sits on (the move origin). */
  selectedIndex: number;
  /** Vertical list (↑/↓) vs. a single-line button row (←/→). */
  layout: "vertical" | "horizontal";
  /** Multi-select (checkboxes): footer offers "Toggle"; rows show `[ ]`/`[x]`. */
  multi: boolean;
}

/** Everything the chat UI needs from one rendered frame. */
export interface ScreenView {
  state: AgyState;
  /** Visible exchanges, oldest first (older ones may have scrolled off). */
  turns: Turn[];
  /** Present when the TUI is blocking on an option selector (state `"prompt"`). */
  prompt?: SelectPrompt;
  /** Current text in the pinned `>` input box (for 2-way binding with the chat). */
  input?: string;
  /** A spinner or `/tasks` background task is active — show a (non-blocking) loader. */
  working?: boolean;
}

// Braille block — the spinner glyphs ⣾⣷⣯⣟⡿⢿⣻⣽ live here.
const BRAILLE = /[⠀-⣿]/;
// A horizontal rule: box-drawing/dash/underscore runs (the TUI uses U+2500 `─`).
const RULE = /^[─-╿\-_—–=]{8,}$/;

const isRule = (t: string): boolean => RULE.test(t);
const isStatus = (t: string): boolean => t.includes("? for shortcuts") || t.includes("esc to cancel");
// The TUI's "working" indicator: a braille spinner, a "Generating…/Thinking…"
// label (followed by dots, so plain prose containing the word isn't matched), or
// a dotted progress bar. Any of these ⇒ show the loading indicator (#1).
const isSpinner = (t: string): boolean =>
  BRAILLE.test(t) ||
  /^\s*(?:[⠀-⣿]\s*)?(?:Generating|Thinking|Working|Running|Loading|Processing)[.…]/i.test(t) ||
  /^\s*[.·•⋯…]{4,}/.test(t) ||
  t.startsWith("└ Tip");
// A `/tasks` hint near the input box means a background task is running — also a
// "working" state (#tasks). Excludes the user typing `/tasks` into the input.
const isTaskHint = (t: string): boolean => !t.startsWith(">") && /(?:^|[\s·•↓└|])\/tasks\b/.test(t);
const isBanner = (t: string): boolean => /[▄▀]/.test(t);
// Tool-call / status bullets the TUI emits while working (`● Bash(…)`, an `○`
// queued/active marker). They are not assistant prose, so never stream them.
const isToolCall = (t: string): boolean => t.startsWith("●") || t.startsWith("○");
const isToolOut = (t: string): boolean => t.startsWith("⎿");
const isNoise = (t: string): boolean => t.includes("Eligibility Check") || t.includes("Eligibility check");
const isUserEcho = (t: string): boolean => /^>\s+\S/.test(t);
const isEmptyPrompt = (t: string): boolean => t === ">" || t === "> ";

/** Strips the 2-space indent the TUI prefixes onto assistant prose. */
const deindent = (line: string): string => line.replace(/^ {1,2}/, "").replace(/\s+$/, "");

const norm = (s: string): string => s.trim().replace(/\s+/g, " ");

// --- Option-selector detection (state "prompt") -----------------------------
//
// Every pick-one selector offers arrow "Navigate" in its footer (verified vs agy
// v1.0.4):
//   "Keyboard: ↑/↓ Navigate  enter Select  esc Go Back"   (model picker)
//   "↑/↓ Navigate · enter Confirm"                         (onboarding)
//   "↑/↓ Navigate · tab Amend · e edit command"           (tool-permission Yes/No)
// So we key on "Navigate" rather than a confirm verb (the permission prompt has
// no "enter <verb>"). The only arrow-navigable screens that are NOT pick-one are
// the settings editor and the tabbed help viewer; both carry a distinctive
// footer token we exclude. The caret-row check in locateSelector() does the rest.
const SELECT_EXCLUDE = /switch view|clear search|search\/exit/i;
const isSelectFooter = (t: string): boolean => /\bnavigate\b/i.test(t) && !SELECT_EXCLUDE.test(t);
// Caret glyphs the TUI uses to mark the focused row.
const CARET_CLASS = "[>❯▶▸►◉●]";
const caretAtStart = new RegExp(`^\\s*${CARET_CLASS}\\s+\\S`);
const caretMidLine = new RegExp(`${CARET_CLASS}\\s+\\S`);
const isCaretRow = (t: string): boolean => caretAtStart.test(t);
// An unselected vertical option row: the TUI pads it with leading spaces.
const isIndentRow = (raw: string): boolean => /^ {2,}\S/.test(raw);

/** Strips the caret / indent / numbering prefix off a raw option row. */
function bareOption(raw: string): string {
  return raw
    .replace(new RegExp(`^\\s*${CARET_CLASS}\\s+`), "")
    .replace(/^\s+/, "")
    .replace(/^\d+[.)]\s+/, ""); // "1. Yes" / "2) No" -> "Yes" / "No"
}

/**
 * Parses one option row into a {@link SelectOption}. In a multi-select, rows show
 * a `[ ]`/`[x]` checkbox; a row without one (e.g. "Write-in…") is a free-text row.
 */
function parseOption(raw: string, multi: boolean): SelectOption {
  let s = bareOption(raw);
  let checked = false;
  let writeIn = false;
  const box = s.match(/^\[([ xX*])\]\s*/);
  if (box) {
    checked = /[xX*]/.test(box[1]);
    s = s.slice(box[0].length);
  } else if (multi) {
    writeIn = true; // a multi-select row with no checkbox is the write-in row
  }
  if (/^write[\s-]?in\b/i.test(s)) {
    writeIn = true;
  }
  const label = s
    .replace(/^\[(.+)\]$/, "$1")
    .replace(/\s{3,}/g, "  ")
    .trim();
  return { label, checked, writeIn };
}

interface Located {
  prompt: SelectPrompt;
  /** Row where the selector visually begins; turns are parsed only above it. */
  top: number;
}

/**
 * The selector's heading block. The line directly above the options is its
 * `title` ("Do you want to proceed?"); any further lines above that belong to
 * the prompt — a tool-permission prompt's "Requesting permission for: <cmd>"
 * framing — become its `context`. We walk upward until a structural boundary (a
 * rule, the echoed user prompt, the banner, a tool line) and report `top` (the
 * topmost line taken) so the whole framing is excluded from the conversation
 * turns and rendered inside the card instead of duplicated above it. Bounded so a
 * long preceding answer isn't swallowed into the card.
 */
function headingAbove(lines: string[], firstOptionIdx: number): { title: string; context: string; top: number } {
  const block: string[] = []; // top-to-bottom; "" marks a paragraph break
  let top = firstOptionIdx;
  let blanks = 0;
  let chars = 0;
  for (let k = firstOptionIdx - 1; k >= 0; k--) {
    const raw = lines[k];
    const t = raw.trim();
    if (t === "") {
      if (block.length === 0) {
        continue; // blank padding directly above the options
      }
      if (++blanks >= 3) {
        break; // a wide gap ⇒ anything above is not part of this prompt
      }
      block.unshift("");
      continue;
    }
    if (
      isRule(t) || isBanner(t) || isStatus(t) || isSpinner(t) || isUserEcho(t) ||
      isToolCall(t) || isToolOut(t) || isEmptyPrompt(t) || isSelectFooter(t) || isNoise(t)
    ) {
      break;
    }
    // Keep the heading short — don't pull a whole preceding answer into the card.
    if (block.filter((b) => b !== "").length >= 6 || chars + t.length > 600) {
      break;
    }
    blanks = 0;
    chars += t.length;
    block.unshift(deindent(raw));
    top = k;
  }
  while (block.length && block[0] === "") {
    block.shift();
  }
  while (block.length && block[block.length - 1] === "") {
    block.pop();
  }
  if (block.length === 0) {
    return { title: "", context: "", top: firstOptionIdx };
  }
  const title = block[block.length - 1];
  const context = block
    .slice(0, -1)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, context, top };
}

/**
 * Locates an option selector on the rendered screen and extracts it, plus the
 * row it begins on (so the turn parser can ignore the selector region — its
 * caret row `> Foo` would otherwise look like a user echo). Handles the common
 * vertical list and a best-effort single-line horizontal button row.
 */
function locateSelector(lines: string[]): Located | undefined {
  let h = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isSelectFooter(lines[i])) {
      h = i;
      break;
    }
  }
  if (h < 0) {
    return undefined;
  }
  // Multi-select prompts offer a "Toggle" key (e.g. "x Toggle") and render
  // `[ ]`/`[x]` checkboxes; single-select prompts don't.
  const multi = /\btoggle\b/i.test(lines[h]);
  let i = h - 1;
  while (i >= 0 && lines[i].trim() === "") {
    i--;
  }
  if (i < 0) {
    return undefined;
  }

  // Vertical: a contiguous run of caret/indent rows ending just above the footer.
  const rows: { raw: string; selected: boolean; idx: number }[] = [];
  for (let j = i; j >= 0; j--) {
    const raw = lines[j].replace(/\s+$/, "");
    if (raw.trim() === "") {
      break;
    }
    const caret = isCaretRow(raw);
    if (caret || isIndentRow(raw)) {
      rows.unshift({ raw, selected: caret, idx: j });
    } else {
      break;
    }
  }
  if (rows.length >= 2 && rows.filter((r) => r.selected).length === 1) {
    const { title, context, top } = headingAbove(lines, rows[0].idx);
    return {
      prompt: {
        title,
        context,
        options: rows.map((r) => parseOption(r.raw, multi)),
        selectedIndex: rows.findIndex((r) => r.selected),
        layout: "vertical",
        multi
      },
      top
    };
  }

  // Horizontal: one line of buttons with a mid-line caret, e.g.
  // "[Previous]    >  Done". Normalise caret spacing so a split on 2+ spaces
  // keeps the caret attached to its button.
  const line = lines[i];
  if (!isCaretRow(line) && caretMidLine.test(line) && (/\[[^\]]+\]/.test(line) || line.trim().length < 60)) {
    const parts = line
      .trim()
      .replace(new RegExp(`(${CARET_CLASS})\\s+`, "g"), "$1 ")
      .split(/\s{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      let selectedIndex = parts.findIndex((p) => new RegExp(`^${CARET_CLASS}\\s`).test(p));
      if (selectedIndex < 0) {
        selectedIndex = 0;
      }
      return {
        prompt: {
          title: "",
          context: "",
          options: parts.map((p) => parseOption(p, false)),
          selectedIndex,
          layout: "horizontal",
          multi: false
        },
        top: i
      };
    }
  }
  return undefined;
}

/**
 * Locates the pinned `>` input box — a `>`-line flanked by horizontal rules (the
 * transcript's `> echo` lines are not). Returns its line index and current text,
 * so the chat box can 2-way bind to it and the turn parser can skip it.
 */
function findInputBox(lines: string[]): { idx: number; text: string } | undefined {
  for (let i = lines.length - 2; i >= 1; i--) {
    const m = lines[i].match(/^>\s?(.*)$/);
    if (!m) {
      continue;
    }
    if (isRule(lines[i - 1].trim()) && isRule(lines[i + 1].trim())) {
      return { idx: i, text: m[1].trim() };
    }
  }
  return undefined;
}

/**
 * The keystrokes that move a selector's caret from `from` to `target` and
 * confirm — arrow keys (↑/↓ vertical, ←/→ horizontal) repeated by the index
 * delta, then Enter. Sent as one burst; `agy` consumes them in order (verified).
 * Pure, so the navigation maths is unit-tested without a live process.
 */
export function selectionKeys(from: number, target: number, layout: "vertical" | "horizontal"): string {
  return moveKeys(from, target, layout) + "\r";
}

/**
 * Just the arrow keys to move a selector's caret from `from` to `target` (no
 * confirm) — for repositioning before a toggle/write-in, or following the user's
 * own arrow-key navigation in the chat UI. Pure (unit-tested).
 */
export function moveKeys(from: number, target: number, layout: "vertical" | "horizontal"): string {
  const delta = target - from;
  const back = layout === "horizontal" ? "\x1b[D" : "\x1b[A";
  const fwd = layout === "horizontal" ? "\x1b[C" : "\x1b[B";
  return delta === 0 ? "" : (delta > 0 ? fwd : back).repeat(Math.abs(delta));
}

/**
 * Interprets one reconstructed screen (array of rendered lines, top to bottom).
 * Recognises the run state and groups the conversation into turns, discarding
 * the banner, rules, status line, spinner, tool calls/output, and the live
 * input prompt.
 */
export function interpretScreen(rawLines: string[]): ScreenView {
  const lines = rawLines.map((l) => l.replace(/\s+$/, ""));
  const joined = lines.join("\n");

  // A blocking option selector wins over the spinner/idle heuristics (its status
  // line still reads "esc to cancel"). We also parse turns only from the region
  // *above* it, so its caret row `> Foo` isn't mistaken for a user echo.
  const selector = locateSelector(lines);

  let state: AgyState;
  if (/not signed in|Signing in/i.test(joined)) {
    state = "signin";
  } else if (selector) {
    state = "prompt";
  } else if (lines.some((l) => l.includes("esc to cancel") || isSpinner(l.trim()))) {
    // NB: a /tasks background hint is NOT "generating" — it must not block the
    // input / wedge the turn (a `npm run dev` task runs indefinitely). It's a
    // separate non-blocking `working` flag below.
    state = "generating";
  } else if (lines.some((l) => l.includes("? for shortcuts"))) {
    state = "idle";
  } else {
    state = "starting";
  }

  const inputBox = findInputBox(lines);
  const bodyTop = selector ? selector.top : lines.length;
  const turns: Turn[] = [];
  let cur: Turn | undefined;
  let skipping = false; // inside a tool-output block (consume wrapped lines)

  for (let bi = 0; bi < bodyTop; bi++) {
    if (inputBox && bi === inputBox.idx) {
      continue; // the pinned input box (its text isn't a conversation turn)
    }
    const raw = lines[bi];
    const t = raw.trim();
    if (t === "") {
      skipping = false;
      if (cur && cur.assistant) {
        cur.assistant += "\n";
      }
      continue;
    }
    if (isBanner(t) || isRule(t) || isStatus(t) || isSpinner(t) || isTaskHint(t) || isEmptyPrompt(t)) {
      skipping = false;
      continue;
    }
    if (isToolCall(t)) {
      skipping = false; // a new tool bullet ends the prior tool's output block
      continue; // the bullet itself is a tool invocation, not assistant prose
    }
    if (isNoise(t) || isToolOut(t)) {
      skipping = true; // this line + its wrapped continuation belong to a tool
      continue;
    }
    if (skipping) {
      continue;
    }
    if (isUserEcho(t)) {
      cur = { user: t.replace(/^>\s+/, ""), assistant: "" };
      turns.push(cur);
      continue;
    }
    // Assistant prose is always 2-space indented by the TUI. A leftover line at
    // column 0 is tool/panel chrome — a wrapped `● Bash(… (ctrl+o to` continuation
    // ("expand)"), a "Command" panel label, etc. — never prose. Drop it (the rule
    // lines around such labels are already caught by isRule above). Genuine
    // context the TUI indents (e.g. "  Requesting permission for: …") is kept.
    if (!/^\s/.test(raw)) {
      continue;
    }
    // Anything else is assistant prose for the current turn.
    if (!cur) {
      cur = { user: "", assistant: "" };
      turns.push(cur);
    }
    cur.assistant += (cur.assistant ? "\n" : "") + deindent(raw);
  }

  for (const turn of turns) {
    turn.assistant = turn.assistant.replace(/\n{3,}/g, "\n\n").trim();
  }
  const working = state === "generating" || lines.some((l) => isTaskHint(l.trim()));
  return { state, turns, prompt: selector?.prompt, input: inputBox?.text, working };
}

/**
 * The assistant's reply to a specific prompt we sent. Matching the reply to the
 * echoed input (rather than blindly taking the last turn) prevents showing a
 * *previous* turn's answer in the brief window before the new echo/answer
 * renders. Falls back to a prefix match for long inputs the TUI wrapped.
 */
export function replyFor(view: ScreenView, input: string): string {
  const ni = norm(input);
  let reply = "";
  for (const turn of view.turns) {
    const nu = norm(turn.user);
    if (nu !== "" && (nu === ni || ni.startsWith(nu))) {
      reply = turn.assistant;
    }
  }
  return reply;
}
