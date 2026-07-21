import * as assert from "node:assert";

import { findUrl, interpretScreen, moveKeys, replyFor, selectionKeys } from "../../src/core/agyScreen";

/*
 * These frames are the *rendered screens* produced by feeding real `agy` v1.0.4
 * PTY captures through @xterm/headless (see test/fixtures/agy-interactive-*.bin
 * and the probe in the commit history). They include the actual banner, the
 * sandbox's non-fatal "Eligibility check" tool noise, a tool call, the braille
 * spinner, and the pinned input box — i.e. everything the parser must discard.
 */

// A completed single turn: tool call + assistant prose, idle afterwards.
const IDLE_WITH_TOOL = [
  "      ▄▀▀▄        Antigravity CLI 1.0.4",
  "     ▀▀▀▀▀▀       rounak.tikadar@gmail.com",
  "    ▀▀▀▀▀▀▀▀      Gemini 3.5 Flash (Medium)",
  "   ▄▀▀    ▀▀▄     /workspace",
  "  ▄▀▀      ▀▀▄",
  "",
  "────────────────────────────────────────────────────────────",
  "> hi",
  "",
  "Eligibility Check",
  "  ⎿  Eligibility check failed: failed to get profile picture: Get",
  '"https://lh3.googleusercontent.com',
  '     /a/ACg8ocLr5llJma40QzskmqrNWSp31YivCHnLcnD5MXtRlIS0HGbO3kn4=s96-c": dial tcp',
  "142.250.67.65:443:",
  "      connect: no route to host",
  "",
  "● ListDir(/workspace) (ctrl+o to expand)",
  "",
  "  Hello! How can I help you today with your VS Code extension codebase? Let me know if you want",
  "  to explore the files, run tests, or implement a new feature.",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  "? for shortcuts                                                            Gemini 3.5 Flash (Medium)"
];

// Two completed turns, idle.
const TWO_TURNS = [
  "      ▄▀▀▄        Antigravity CLI 1.0.4",
  "     ▀▀▀▀▀▀       rounak.tikadar@gmail.com",
  "    ▀▀▀▀▀▀▀▀      Gemini 3.5 Flash (Medium)",
  "   ▄▀▀    ▀▀▄     /workspace",
  "  ▄▀▀      ▀▀▄",
  "",
  "────────────────────────────────────────────────────────────",
  "> reply with exactly: ONEONE",
  "",
  "  ONEONE",
  "",
  "Eligibility Check",
  "  ⎿  Eligibility check failed: failed to get profile picture: Get",
  '"https://lh3.googleusercontent.com',
  "142.250.67.65:443:",
  "      connect: no route to host",
  "",
  "────────────────────────────────────────────────────────────",
  "> reply with exactly: TWOTWO",
  "",
  "  TWOTWO",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  "? for shortcuts                                                            Gemini 3.5 Flash (Medium)"
];

// Mid-generation: spinner + "esc to cancel"; partial reply already on screen.
const GENERATING = [
  "      ▄▀▀▄        Antigravity CLI 1.0.4",
  "     ▀▀▀▀▀▀       rounak.tikadar@gmail.com",
  "    ▀▀▀▀▀▀▀▀      Gemini 3.5 Flash (Medium)",
  "   ▄▀▀    ▀▀▄     /workspace",
  "  ▄▀▀      ▀▀▄",
  "",
  "────────────────────────────────────────────────────────────",
  "> reply with exactly: ONEONE",
  "",
  "  ONEONE",
  "⣽ Generating...",
  "└ Tip: Use /tasks to see background tasks and their status.",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  "esc to cancel                                                              Gemini 3.5 Flash (Medium)"
];

// A long response mid-generation: the `> prompt` echo has scrolled off the top,
// leaving streaming prose interleaved with `●`/`○` tool-call bullets above the
// spinner. The prose belongs to no visible echo (an "orphan" turn).
const GENERATING_SCROLLED = [
  "  Setting up the project structure now.",
  "● Bash(npm create next-app random)",
  "  ⎿  Creating a new Next.js app in /workspace/random",
  "○ Write(random/app/todo.tsx)",
  "  Wiring up the random todo list component.",
  "⣽ Generating...",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  "esc to cancel                                                              Gemini 3.5 Flash (Medium)"
];

// A tool call whose `●` line WRAPS to a second visual line ("expand)"), plus the
// column-0 "Command" panel label + rule agy renders below it. The wrapped
// continuation, the label, and the rules are all chrome (column 0) and must be
// dropped; the indented prose around them is kept.
const WRAPPED_TOOL = [
  "  Scaffolding the app for you.",
  '● Bash(npx -y create-next-app@latest ./ --ts --eslint --app --src-dir --import-alias "@/*" --use-np...) (ctrl+o to',
  "expand)",
  "",
  "Command",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  "",
  "  Done — the project is ready.",
  "⣽ Generating...",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  "esc to cancel                                                              Gemini 3.5 Flash (Medium)"
];

const SIGNIN = [
  "▄▀▀▄",
  "▀▀▀▀▀▀",
  " Welcome to the Antigravity CLI. You are currently not signed in.",
  " ⣾  Signing in..."
];

// The `/model` picker — a vertical pick-one selector. Caret `> ` marks the
// focused row; the footer is the tell ("enter Select"). Real agy v1.0.4 frame.
const MODEL_SELECT = [
  "      ▄▀▀▄        Antigravity CLI 1.0.4",
  "    ▀▀▀▀▀▀▀▀      Gemini 3.5 Flash (Medium)",
  "  ▄▀▀      ▀▀▄",
  "",
  "────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────",
  "Switch Model",
  "",
  "> Gemini 3.5 Flash (Medium) (current)",
  "  Gemini 3.5 Flash (High)",
  "  Gemini 3.5 Flash (Low)",
  "  Gemini 3.1 Pro (Low)",
  "  Gemini 3.1 Pro (High)",
  "  Gemini 3 Flash",
  "",
  "Keyboard: ↑/↓ Navigate  enter Select  esc Go Back",
  "esc to cancel                                              Gemini 3.5 Flash (Medium)"
];

// The settings editor (`/config`) and help viewer (`/help`) are also arrow-key
// driven but are NOT pick-one selectors — they must be left to the terminal.
const CONFIG_EDITOR = [
  "  Search:",
  "          ────────────────────",
  "",
  "> Animation Speed      medium",
  "  Artifact Review      asks for review",
  "  Verbosity            high",
  "",
  "  Speed of the running light animation",
  "",
  "  ↑/↓ Navigate · enter Edit · Esc Clear Search/Exit",
  "esc to cancel                                              Gemini 3.5 Flash (Medium)"
];
const HELP_VIEW = [
  "Antigravity CLI   general    commands    shortcuts   (←/→ or tab to cycle)",
  "Version 1.0.4",
  "",
  "Keyboard: ↑/↓ Navigate  ←/→ Switch View  esc Close",
  "esc to cancel                                              Gemini 3.5 Flash (Medium)"
];

// A tool-permission prompt (the important in-chat case). Its footer has NO
// "enter <verb>" — "↑/↓ Navigate · tab Amend · e edit command" — so detection
// must key on "Navigate", not a confirm verb. Options are numbered.
const PERMISSION = [
  "      ▄▀▀▄        Antigravity CLI 1.0.4",
  "    ▀▀▀▀▀▀▀▀      Gemini 3.5 Flash (Medium)",
  "  ▄▀▀      ▀▀▄",
  "",
  "> what is today's weather",
  "",
  "Command",
  "────────────────────────────────────────────────────────────────────────────────────────────",
  "",
  "  Requesting permission for: curl -s ipinfo.io",
  "",
  "Do you want to proceed?",
  "> 1. Yes",
  "  2. No",
  "",
  "  ↑/↓ Navigate · tab Amend · e edit command",
  "esc to cancel                                              Gemini 3.5 Flash (Medium)"
];

// A multi-select question: footer offers "Toggle", rows are `[ ]`/`[x]`, and the
// last row is a free-text "Write-in".
const MULTI_SELECT = [
  "> ask me a multi-selectable option question",
  "",
  "Question 1/1: Which Python frameworks or libraries do you work with most?",
  "",
  "> 1. [ ] (Recommended) FastAPI or Flask for web APIs",
  "  2. [ ] Django for full-stack web applications",
  "  3. [ ] NumPy, Pandas, or Scikit-Learn for data analysis and ML",
  "  4. [x] PyTorch or TensorFlow for deep learning",
  "  5. [ ] Requests or BeautifulSoup for web scraping",
  "  6. [ ] Playwright or Selenium for browser automation",
  "  7. Write-in...",
  "",
  "  ↑/↓ Navigate · x Toggle · enter Submit · esc Skip",
  "esc to cancel                                              Gemini 3.5 Flash (Medium)"
];

// First-run Terms screen — a horizontal button row; `>` marks the focused button.
const TERMS = [
  "      Terms and Privacy:",
  "      - Terms of Service: https://cloud.google.com/terms",
  "",
  "    [Previous]    >  Done",
  "",
  "  ↑/↓ Navigate · enter Confirm"
];

describe("agyScreen.interpretScreen — option selectors", () => {
  it("detects a vertical pick-one selector and extracts its options", () => {
    const view = interpretScreen(MODEL_SELECT);
    assert.strictEqual(view.state, "prompt");
    assert.ok(view.prompt);
    assert.strictEqual(view.prompt!.layout, "vertical");
    assert.strictEqual(view.prompt!.title, "Switch Model");
    assert.strictEqual(view.prompt!.multi, false);
    assert.strictEqual(view.prompt!.options.length, 6);
    assert.strictEqual(view.prompt!.options[0].label, "Gemini 3.5 Flash (Medium) (current)");
    assert.strictEqual(view.prompt!.options[5].label, "Gemini 3 Flash");
    assert.strictEqual(view.prompt!.selectedIndex, 0);
  });

  it("does not mistake the selector's caret row for a user echo", () => {
    // The `> Gemini…` caret row must not leak into the conversation turns.
    assert.deepStrictEqual(interpretScreen(MODEL_SELECT).turns, []);
  });

  it("tracks the caret as the focused row moves", () => {
    const moved = MODEL_SELECT.map((l) =>
      l.startsWith("> Gemini 3.5 Flash (Medium)")
        ? l.replace("> ", "  ")
        : l === "  Gemini 3.5 Flash (Low)"
          ? "> Gemini 3.5 Flash (Low)"
          : l
    );
    assert.strictEqual(interpretScreen(moved).prompt!.selectedIndex, 2);
  });

  it("intercepts a tool-permission prompt (footer has no 'enter <verb>')", () => {
    const view = interpretScreen(PERMISSION);
    assert.strictEqual(view.state, "prompt");
    assert.ok(view.prompt);
    assert.strictEqual(view.prompt!.title, "Do you want to proceed?");
    assert.deepStrictEqual(view.prompt!.options.map((o) => o.label), ["Yes", "No"]); // numbering stripped
    assert.strictEqual(view.prompt!.multi, false);
    assert.strictEqual(view.prompt!.selectedIndex, 0);
    // The "Requesting permission for: …" framing is part of the selector card.
    assert.strictEqual(view.prompt!.context, "Requesting permission for: curl -s ipinfo.io");
    // …and is therefore NOT duplicated as conversation prose.
    assert.ok(!view.turns.some((t) => /Requesting permission/.test(t.assistant)));
  });

  it("folds a permission prompt's multi-line context into the card, not the turn", () => {
    const lines = [
      "> create a next app",
      "",
      "  Requesting permission for: cp /home/node/.gemini/brain/abc/grocer",
      "  y_hero_1780547795407.png /home/node/test/public/grocery_hero.png",
      "",
      "Do you want to proceed?",
      "> 1. Yes",
      "  2. Yes, and always allow for commands that start with 'cp'",
      "  3. No",
      "",
      "  ↑/↓ Navigate · tab Amend · e edit command",
      "esc to cancel                                              Gemini 3.5 Flash (Medium)"
    ];
    const v = interpretScreen(lines);
    assert.strictEqual(v.prompt!.options.length, 3);
    assert.strictEqual(v.prompt!.options[1].label, "Yes, and always allow for commands that start with 'cp'");
    assert.strictEqual(v.prompt!.title, "Do you want to proceed?");
    // The wrapped command framing lands in the card's context, not the turn prose.
    assert.ok(/Requesting permission for: cp .+grocery_hero\.png/s.test(v.prompt!.context));
    assert.ok(!v.turns.some((t) => /Requesting permission/.test(t.assistant)));
  });

  it("puts the 'Requesting permission for: …' line into the card context", () => {
    const lines = [
      "> run the linter",
      "",
      "  Requesting permission for: npm run lint",
      "",
      "Do you want to proceed?",
      "> 1. Yes",
      "  2. Yes, and always allow in this conversation for commands that start with 'npm run'",
      "  3. Yes, and always allow for commands that start with 'npm run' (Persist to settings.json)",
      "  4. No",
      "",
      "  ↑/↓ Navigate · tab Amend · e edit command",
      "esc to cancel                                              Gemini 3.5 Flash (Medium)"
    ];
    const v = interpretScreen(lines);
    assert.strictEqual(v.prompt!.title, "Do you want to proceed?");
    assert.strictEqual(v.prompt!.context, "Requesting permission for: npm run lint");
    assert.strictEqual(v.prompt!.options.length, 4);
    assert.deepStrictEqual(v.prompt!.options.map((o) => o.label)[3], "No");
    assert.ok(!v.turns.some((t) => /Requesting permission|npm run lint/.test(t.assistant)));
  });

  it("leaves context empty for a plain selector (e.g. the model picker)", () => {
    assert.strictEqual(interpretScreen(MODEL_SELECT).prompt!.context, "");
  });

  it("ignores the settings editor (enter Edit) — not a pick-one selector", () => {
    const view = interpretScreen(CONFIG_EDITOR);
    assert.strictEqual(view.prompt, undefined);
    assert.notStrictEqual(view.state, "prompt");
  });

  it("ignores the help viewer (Switch View) — not a pick-one selector", () => {
    assert.strictEqual(interpretScreen(HELP_VIEW).prompt, undefined);
  });

  it("parses a horizontal button row (first-run Terms)", () => {
    const view = interpretScreen(TERMS);
    assert.strictEqual(view.state, "prompt");
    assert.strictEqual(view.prompt!.layout, "horizontal");
    assert.deepStrictEqual(view.prompt!.options.map((o) => o.label), ["Previous", "Done"]);
    assert.strictEqual(view.prompt!.selectedIndex, 1);
  });

  it("reads the pinned input box and keeps it out of the turns (#9)", () => {
    const lines = [
      "──────────────────────────────",
      "> draft message here",
      "──────────────────────────────",
      "? for shortcuts                         Gemini 3.5 Flash (Medium)"
    ];
    const v = interpretScreen(lines);
    assert.strictEqual(v.input, "draft message here");
    assert.deepStrictEqual(v.turns, []); // the input box is not a conversation turn
  });

  it("does not confuse a transcript echo with the input box", () => {
    // `> hi` (echo) is followed by a blank, not a rule, so it stays a user turn;
    // the empty pinned box below is the real input.
    const v = interpretScreen(IDLE_WITH_TOOL);
    assert.strictEqual(v.input, "");
    assert.strictEqual(v.turns[0].user, "hi");
  });

  it("parses a multi-select with checkboxes and a write-in row", () => {
    const view = interpretScreen(MULTI_SELECT);
    assert.strictEqual(view.state, "prompt");
    assert.strictEqual(view.prompt!.multi, true);
    assert.ok(view.prompt!.title.startsWith("Question 1/1:"));
    const o = view.prompt!.options;
    assert.strictEqual(o.length, 7);
    assert.strictEqual(o[0].label, "(Recommended) FastAPI or Flask for web APIs");
    assert.strictEqual(o[0].checked, false);
    assert.strictEqual(o[3].checked, true); // [x] PyTorch
    assert.ok(o.every((x, i) => (i === 6) === x.writeIn)); // only row 7 is write-in
    assert.strictEqual(o[6].label, "Write-in...");
  });
});

describe("agyScreen.selectionKeys / moveKeys", () => {
  it("moves down and confirms for a forward vertical jump", () => {
    assert.strictEqual(selectionKeys(0, 2, "vertical"), "\x1b[B\x1b[B\r");
  });
  it("moves up for a backward vertical jump", () => {
    assert.strictEqual(selectionKeys(4, 1, "vertical"), "\x1b[A\x1b[A\x1b[A\r");
  });
  it("uses left/right arrows for a horizontal selector", () => {
    assert.strictEqual(selectionKeys(0, 1, "horizontal"), "\x1b[C\r");
  });
  it("just confirms when the target is already focused", () => {
    assert.strictEqual(selectionKeys(2, 2, "vertical"), "\r");
  });
  it("moveKeys repositions the caret without confirming", () => {
    assert.strictEqual(moveKeys(0, 2, "vertical"), "\x1b[B\x1b[B");
    assert.strictEqual(moveKeys(3, 3, "vertical"), "");
  });
});

describe("agyScreen.interpretScreen — state", () => {
  it("detects the idle prompt", () => {
    assert.strictEqual(interpretScreen(IDLE_WITH_TOOL).state, "idle");
  });
  it("detects generating from the spinner / 'esc to cancel'", () => {
    assert.strictEqual(interpretScreen(GENERATING).state, "generating");
  });
  it("detects the signed-out state", () => {
    assert.strictEqual(interpretScreen(SIGNIN).state, "signin");
  });
  it("flags `ready` from the pinned input box even if the status wording changed (#5)", () => {
    // Reworded/absent status line — the CLI is still waiting for input (the `>`
    // box is painted). `ready` must be true (so the "session ended before it was
    // ready" guard clears), but the box alone must NOT make it look "idle".
    const readyNoStatusHint = [
      "      ▄▀▀▄        Antigravity CLI 9.9.9",
      "  ▄▀▀      ▀▀▄",
      "────────────────────────────────────────────────────────────",
      "> hello there",
      "",
      "  Hi! How can I help?",
      "────────────────────────────────────────────────────────────",
      ">",
      "────────────────────────────────────────────────────────────",
      "press ? for help                                            SomeModel"
    ];
    const view = interpretScreen(readyNoStatusHint);
    assert.strictEqual(view.ready, true);
    assert.notStrictEqual(view.state, "idle"); // not finalize-worthy without "? for shortcuts"
  });
  it("a mid-generation frame is NOT idle even though the input box is painted (#hang)", () => {
    // Verified failure mode: during a turn the pinned `>` box is present, but a
    // frame briefly lacks BOTH "esc to cancel" and "? for shortcuts". Treating the
    // box as idle here finalized the turn early (truncated reply / desynced later
    // turns). It must read as generating (a spinner is still up) — never idle.
    const midTurn = [
      "────────────────────────────────────────────────────────────",
      "> explain PTYs in four sentences",
      "  A pseudo-terminal is a software device pair…",
      "⣷ Generating…",
      "────────────────────────────────────────────────────────────",
      ">",
      "────────────────────────────────────────────────────────────",
      "                                                            Gemini 3.5 Flash"
    ];
    const view = interpretScreen(midTurn);
    assert.notStrictEqual(view.state, "idle");
    assert.strictEqual(view.state, "generating");
  });
  it("a settled frame with a painted box but no status hint is 'starting', not 'idle'", () => {
    const noHint = [
      "────────────────────────────────────────────────────────────",
      "> hi",
      "  Hello!",
      "────────────────────────────────────────────────────────────",
      ">",
      "────────────────────────────────────────────────────────────",
      "                                                            SomeModel"
    ];
    const view = interpretScreen(noHint);
    assert.strictEqual(view.state, "starting");
    assert.strictEqual(view.ready, true); // still ready for input (box painted)
  });
  it("flags working for a braille spinner and a /tasks hint (the latter non-blocking)", () => {
    const f = (x: string[]) => ["────────", "> hi", "────────"].concat(x);
    const spin = interpretScreen(f(["⣷ Working...", "? for shortcuts"]));
    assert.strictEqual(spin.state, "generating");
    assert.strictEqual(spin.working, true);
    // A background /tasks must NOT block the turn (state stays idle) but is "working".
    const bg = interpretScreen(f(["↓ /tasks (1 running)", "? for shortcuts"]));
    assert.strictEqual(bg.state, "idle");
    assert.strictEqual(bg.working, true);
    const idle = interpretScreen(f(["? for shortcuts"]));
    assert.strictEqual(idle.state, "idle");
    assert.strictEqual(idle.working, false);
  });
});

describe("agyScreen.interpretScreen — turns", () => {
  it("extracts the assistant prose, discarding tool calls and eligibility noise", () => {
    const view = interpretScreen(IDLE_WITH_TOOL);
    assert.strictEqual(view.turns.length, 1);
    assert.strictEqual(view.turns[0].user, "hi");
    assert.strictEqual(
      view.turns[0].assistant,
      "Hello! How can I help you today with your VS Code extension codebase? Let me know if you want\n" +
        "to explore the files, run tests, or implement a new feature."
    );
    // No box-art, rules, tool output, or URLs leaked into the prose.
    assert.ok(!/▀|─|⎿|googleusercontent/.test(view.turns[0].assistant));
  });

  it("separates multiple turns", () => {
    const view = interpretScreen(TWO_TURNS);
    assert.strictEqual(view.turns.length, 2);
    assert.strictEqual(view.turns[0].assistant, "ONEONE");
    assert.strictEqual(view.turns[1].assistant, "TWOTWO");
  });

  it("drops a wrapped tool call's continuation + 'Command' label, keeping prose", () => {
    const view = interpretScreen(WRAPPED_TOOL);
    assert.strictEqual(view.turns.length, 1);
    assert.strictEqual(view.turns[0].user, "");
    assert.strictEqual(
      view.turns[0].assistant,
      "Scaffolding the app for you.\n\nDone — the project is ready."
    );
    // No wrapped `●` continuation ("expand)"), "Command" label, or rule lines.
    assert.ok(!/expand\)|Command|create-next-app|─/.test(view.turns[0].assistant));
  });

  it("streams orphan prose live (echo scrolled off), skipping ●/○ bullets", () => {
    const view = interpretScreen(GENERATING_SCROLLED);
    assert.strictEqual(view.state, "generating");
    // One orphan turn: no user echo, prose captured, tool bullets/output dropped.
    assert.strictEqual(view.turns.length, 1);
    assert.strictEqual(view.turns[0].user, "");
    assert.strictEqual(
      view.turns[0].assistant,
      "Setting up the project structure now.\nWiring up the random todo list component."
    );
    assert.ok(!/●|○|⎿|npm create/.test(view.turns[0].assistant));
  });
});

describe("agyScreen.replyFor", () => {
  it("returns the reply matched to a specific prompt", () => {
    const view = interpretScreen(TWO_TURNS);
    assert.strictEqual(replyFor(view, "reply with exactly: ONEONE"), "ONEONE");
    assert.strictEqual(replyFor(view, "reply with exactly: TWOTWO"), "TWOTWO");
  });

  it("returns the partial reply while still generating", () => {
    const view = interpretScreen(GENERATING);
    assert.strictEqual(replyFor(view, "reply with exactly: ONEONE"), "ONEONE");
  });

  it("returns '' when the prompt has no echoed turn yet", () => {
    const view = interpretScreen(GENERATING);
    assert.strictEqual(replyFor(view, "a different prompt"), "");
  });

  // Captured from real agy v1.0.4: a long prompt is echoed as `> <row1>` then an
  // indented continuation with no `>`, which the TUI indents exactly like the
  // reply — so the wrapped tail leaks into the assistant text. replyFor knows the
  // real prompt and must strip it. (#reply-leak, found during the format streak)
  const WRAPPED_PROMPT = [
    "      ▄▀▀▄        Antigravity CLI 1.0.4",
    "  ▄▀▀      ▀▀▄",
    "────────────────────────────────────────────────────────────",
    "> Reply in text only, no tools. Give a markdown bulleted list of exactly 3 items about terminals; each item starts with",
    "  a **bold term** then a dash and a short clause.",
    "▸ Thought for 3s, 486 tokens",
    "  Defining Terminal Aspects",
    "  • Terminal Emulator - it displays text output and accepts keyboard input.",
    "  • Shell - it interprets text commands and executes programs.",
    "────────────────────────────────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────────────────────────────────",
    "? for shortcuts                                                            Gemini 3.5 Flash (Medium)"
  ];
  const WRAPPED_INPUT =
    "Reply in text only, no tools. Give a markdown bulleted list of exactly 3 items about terminals; " +
    "each item starts with a **bold term** then a dash and a short clause.";

  it("strips the wrapped tail of the prompt that leaked into the reply", () => {
    const view = interpretScreen(WRAPPED_PROMPT);
    const reply = replyFor(view, WRAPPED_INPUT);
    assert.ok(reply.startsWith("Defining Terminal Aspects"), `got: ${reply}`);
    assert.ok(!reply.includes("a **bold term** then a dash"), "prompt tail must not leak into reply");
    assert.ok(reply.includes("Terminal Emulator"));
  });

  it("leaves an unwrapped prompt's reply untouched", () => {
    const view = interpretScreen(TWO_TURNS);
    assert.strictEqual(replyFor(view, "reply with exactly: ONEONE"), "ONEONE");
  });
});

describe("agyScreen selector separators (#resume-divider)", () => {
  // Modeled on the real agy v1.0.4 `/resume` browser: a vertical picker whose
  // list is split by a "── other workspaces ──" divider. That separator must
  // never become a selectable option (it would render as a dead button).
  const RESUME_LIKE = [
    "      ▄▀▀▄        Antigravity CLI 1.0.4",
    "  ▄▀▀      ▀▀▄",
    "────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────",
    "  Conversations",
    "> Defining Terminal Components                                     10 steps    3m ago",
    "  Reply with plain text only                                        4 steps   10m ago",
    "  [CURRENT] dbc992b0-1814                                           0 steps",
    "  ── other workspaces ────────────────────────────────────────────────────────────────",
    "  hi                                              8 steps   46m ago   workspace",
    "Keyboard: ↑/↓ Navigate  enter Select  esc Go Back",
    "esc to cancel                                                      Gemini 3.5 Flash (Medium)"
  ];

  it("does not emit the divider row as an option", () => {
    const view = interpretScreen(RESUME_LIKE);
    assert.strictEqual(view.state, "prompt");
    const labels = view.prompt!.options.map((o) => o.label);
    assert.ok(!labels.some((l) => /other workspaces/i.test(l)), `divider leaked: ${JSON.stringify(labels)}`);
    assert.ok(!labels.some((l) => /^[─—–_-]+$/.test(l)), "no all-dash option");
    // The five real rows survive (Conversations, two convs, [CURRENT], hi).
    assert.strictEqual(view.prompt!.options.length, 5);
  });

  it("keeps the caret on the right row across the divider", () => {
    const view = interpretScreen(RESUME_LIKE);
    assert.strictEqual(view.prompt!.options[view.prompt!.selectedIndex].label.split("  ")[0], "Defining Terminal Components");
  });

  it("does not treat a real option with a hyphen or two as a divider", () => {
    const view = interpretScreen([
      "> hi",
      "",
      "Choose a permission mode",
      "> request-review    (current)  Prompt for write, bash, and web tools",
      "  always-proceed    Auto-approve all tools",
      "↑/↓ Navigate  enter Select  esc Go Back",
      "esc to cancel"
    ]);
    assert.strictEqual(view.state, "prompt");
    assert.strictEqual(view.prompt!.options.length, 2);
    assert.ok(/request-review/.test(view.prompt!.options[0].label));
  });
});

describe("agyScreen.findUrl", () => {
  // Transcribed from a real agy v1.0.4 login screen: the TUI cursor-positions
  // each row itself rather than relying on terminal soft-wrap (none of these
  // rows report as xterm-wrapped), breaking mid-word with no inserted space.
  const OAUTH_SCREEN = [
    "Your browser should open automatically. If not:",
    "",
    "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.g",
    "oogleusercontent.com&code_challenge=PAd6nNw8PE-vMmsTICemEbWwbp8WORhRGL1wJl1iv0g&code_challenge_method=S256&prompt=consent&red",
    "irect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%",
    "2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.",
    "profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcclog+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fexperimentsandconfigs+openi",
    "d&state=nXqBEW1tFy04nOLFcSqJKg",
    "",
    "Copy and paste the URL or click on the link below:"
  ];

  it("reassembles a URL the TUI breaks mid-word across several unindented rows", () => {
    assert.strictEqual(
      findUrl(OAUTH_SCREEN),
      "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com&code_challenge=PAd6nNw8PE-vMmsTICemEbWwbp8WORhRGL1wJl1iv0g&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcclog+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fexperimentsandconfigs+openid&state=nXqBEW1tFy04nOLFcSqJKg"
    );
  });

  it("stops at the blank line ending the URL block", () => {
    const url = findUrl(OAUTH_SCREEN);
    assert.ok(!url?.includes("Copy and paste"));
  });

  it("keeps collecting through a continuation row that happens to look indented", () => {
    // Only the blank line ends the block — a row starting with whitespace must
    // not be mistaken for prose and cut the URL short.
    const screen = ["https://example.com/a", " b=1&c=2", "", "next paragraph"];
    assert.strictEqual(findUrl(screen), "https://example.com/ab=1&c=2");
  });

  it("stops at a horizontal rule even with no blank line first", () => {
    const screen = ["https://example.com/a", "b=1&c=2", "──────────────────────", "> authorization code..."];
    assert.strictEqual(findUrl(screen), "https://example.com/ab=1&c=2");
  });

  it("returns undefined when there is no URL", () => {
    assert.strictEqual(findUrl(["Choose your color scheme:", "> terminal"]), undefined);
  });
});
