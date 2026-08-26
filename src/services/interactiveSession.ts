/**
 * Owns one **interactive `agy` process per chat session** and turns its TUI into
 * something the webview can render.
 *
 * Why interactive (not `agy --print`): print mode is one-shot and headless, and
 * there is no reliable CLI signal that ties follow-up turns to the same
 * conversation. Keeping a single long-lived interactive process per session
 * holds the conversation state in the process itself — no fragile id threading.
 *
 * How it works:
 *   - `agy` only renders on a real TTY, so we spawn it under `script` (a PTY
 *     shim — no native dependency). `script` gives a 0×0 PTY when its stdio is
 *     piped, so we `stty` the size inside the command before `exec agy`.
 *   - `agy`'s output is a full-screen, repainting TUI. We feed the raw byte
 *     stream into a headless terminal emulator (`@xterm/headless`) to
 *     reconstruct the *rendered screen*, then [core/agyScreen.ts] interprets it
 *     into run-state + conversation turns (debounced so we parse settled frames).
 *   - The same raw stream can be mirrored verbatim into a VS Code terminal on
 *     demand (the "show in terminal" action), and keystrokes routed back.
 *
 * Lifecycle coupling (see [ui/chatViewProvider.ts]): deleting a session disposes
 * its process; the process exiting tells the view to drop the session.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { Terminal } from "@xterm/headless";

import { buildSessionArgs } from "../core/argBuilder";
import { ScreenView, bannerAccountReady, interpretScreen, moveKeys, selectionKeys } from "../core/agyScreen";
import { sanitizePromptText } from "../core/inputSanitizer";
import { offersSignIn, trustPromptIndex } from "../core/onboarding";
import { missingPtyBackendMessage, planLaunch } from "../core/ptyLauncher";
import { AntigravityConfig } from "../core/types";

/** Minimal shape of the native pty backend used on Windows (#1, #2). */
interface IPtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}
interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { name?: string; cols: number; rows: number; cwd?: string; env?: NodeJS.ProcessEnv }
  ): IPtyLike;
}

/**
 * Lazily loads the native ConPTY backend used on Windows (Unix never gets here —
 * it uses the `script` shim). We ship `@lydell/node-pty-win32-<arch>`: prebuilt
 * Node-API binaries, so they load in any VS Code/Electron version without a
 * node-gyp rebuild, which is what kept plain `node-pty` unshippable in a VSIX
 * (#1, #2). A hand-installed `node-pty` is accepted as a fallback. The ids are
 * required through a variable so esbuild leaves them as runtime requires; a
 * missing backend returns `undefined` (caller shows the real reason, not "agy
 * isn't installed").
 */
function loadNodePty(): NodePtyModule | undefined {
  for (const id of [`@lydell/node-pty-win32-${process.arch}`, "node-pty"]) {
    try {
      return require(id) as NodePtyModule;
    } catch {
      /* try the next backend */
    }
  }
  return undefined;
}

/**
 * Last meaningful line the process printed, used to explain an exit-before-ready
 * with the actual cause (e.g. `script: illegal option -- c` on macOS, #3) rather
 * than the generic "check that agy is installed and you're signed in".
 */
function lastOutputLine(raw: string): string | undefined {
  const lines = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}

/** Vertical/horizontal selector orientation (see core/agyScreen.SelectPrompt). */
type Layout = "vertical" | "horizontal";

/**
 * The slice of `CliService` this service needs. Depending on this structural
 * interface (rather than `CliService`, which imports `vscode`) keeps the file
 * free of `vscode`, so the whole PTY→emulator→parser pipeline can be bundled and
 * exercised against the real `agy` on bare Node.
 */
export interface AgyEnv {
  getConfig(): AntigravityConfig;
  resolveCommand(): string;
  getWorkspaceDirs(): string[];
}

/** PTY geometry. Wide to minimise wrapping; the emulator must match exactly. */
const PTY_COLS = 120;
const PTY_ROWS = 40;
/** Coalesce bursts of repaint output before parsing a settled frame. */
const RENDER_DEBOUNCE_MS = 120;
/**
 * Hard ceiling on that coalescing. A generating CLI repaints its spinner
 * without pause, so the debounce alone never settles and nothing gets parsed
 * for the whole turn; this forces a parse at a steady cadence while output
 * flows, which is what makes the live output window actually live.
 */
const RENDER_MAX_WAIT_MS = 250;
/** Cap the mirror replay buffer so a long session can't grow unbounded. */
const RAW_CAP = 1_500_000;
/** Grace period after Ctrl+Z (end the session, #6) before we terminate `agy`. */
const SHUTDOWN_GRACE_MS = 250;
/** Id of the throwaway session used to ask the CLI itself whether login is needed. */
const PROBE_SESSION_ID = "__authprobe__";
/** Give the probe this long to reach a decisive screen before assuming "no login needed". */
const PROBE_TIMEOUT_MS = 20000;
/**
 * How long to wait for the banner's account line to complete before sending a
 * held prompt anyway. Measured at ~11s from spawn on a warm machine; this has
 * clear air above that, and only ever applies if the CLI never gives the signal.
 */
const INIT_MAX_WAIT_MS = 25000;
/**
 * How long the "not signed in" banner must stay on screen before it is believed.
 * An authenticated CLI shows it for ~4s of every launch while it loads
 * credentials, so this needs clear air above that; a genuinely signed-out CLI
 * that offers auth methods is recognised at once and never waits.
 */
const SIGNIN_CONFIRM_MS = 8000;

/** Per-session launch toggles chosen in the New Session menu (#5). */
export interface SessionLaunchOptions {
  sandbox?: boolean;
  skipPermissions?: boolean;
}

/** Callbacks the chat view supplies to observe one interactive session. */
export interface InteractiveObserver {
  /**
   * Fired (debounced) whenever the reconstructed screen changes. `lines` is the
   * raw rendered screen `view` was built from — needed to read a value the TUI
   * breaks across several rows itself (e.g. the sign-in flow's OAuth URL; see
   * `core/agyScreen.findUrl`), which `view`'s parsed turns/prompt don't carry.
   */
  onScreen(view: ScreenView, lines: string[]): void;
  /**
   * Fired once when the `agy` process exits (for any reason). `error`, when
   * present, is a specific human-facing reason the session could not run at all
   * — e.g. native Windows without a ConPTY backend (#1, #2) — so the caller can
   * show it instead of the generic "ended before ready" message.
   */
  onExit(code: number | null, error?: string): void;
}

interface Live {
  term: Terminal;
  observer: InteractiveObserver;
  /** Raw output kept verbatim so a freshly attached terminal can replay it. */
  raw: string;
  mirror?: (data: string) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** When the current coalescing burst must be parsed regardless of new output. */
  renderDeadline?: number;
  lastSerialized: string;
  /** Becomes true once the CLI can actually accept input; gates queued input. */
  ready: boolean;
  /**
   * Latched once the banner's account line gains its plan/quota suffix — the
   * CLI's own signal that it has finished initialising (see
   * {@link bannerAccountReady}). Latched because that banner scrolls away.
   */
  accountReady: boolean;
  /** Bounded fallback so an account whose banner never completes still runs. */
  initTimer?: ReturnType<typeof setTimeout>;
  /**
   * True once the CLI's prompt UI was ever painted. Distinct from `ready`, which
   * now additionally waits for initialisation: this one answers "did it get far
   * enough to blame something other than startup?" for the exit diagnostic.
   */
  sawPrompt: boolean;
  /** Prompts requested before the agent was ready, flushed once it is. */
  queue: string[];
  /** Backend-agnostic input write (`script` stdin or the node-pty ConPTY). */
  write: (data: string) => void;
  /** Backend-agnostic force-terminate (reaps `script`+`agy`, or kills the ConPTY). */
  terminate: () => void;
}

export class InteractiveSessionService {
  private readonly live = new Map<string, Live>();

  constructor(private readonly cli: AgyEnv) {}

  /** In-flight auth probe, so concurrent refreshes share one spawned CLI. */
  private probe?: Promise<boolean>;

  isRunning(id: string): boolean {
    return this.live.has(id);
  }

  /** Whether the CLI has finished initialising and will honour a submitted prompt. */
  isReady(id: string): boolean {
    return this.live.get(id)?.ready ?? false;
  }

  /** Marks the session able to accept input and flushes anything held back. */
  private markReady(id: string): void {
    const entry = this.live.get(id);
    if (!entry || entry.ready) {
      return;
    }
    entry.ready = true;
    clearTimeout(entry.initTimer);
    entry.initTimer = undefined;
    for (const line of entry.queue.splice(0)) {
      entry.write(line + "\r");
    }
  }

  /**
   * Asks the CLI itself whether the user must sign in: launch a throwaway `agy`
   * and watch what it paints. An auth-method selector means login is required;
   * reaching the input prompt means it is not.
   *
   * The "You are currently not signed in" banner is deliberately **not** taken
   * at face value. A real, authenticated CLI shows it for the first few seconds
   * of every launch while it loads credentials, so acting on it reported a
   * signed-in user as signed out — and since signing in then lands back here,
   * the gate looped forever. It only counts once it has survived
   * {@link SIGNIN_CONFIRM_MS}; any other screen in the meantime cancels it.
   *
   * Anything else — process exits early, no PTY backend, the probe times out —
   * resolves `true`. We only demand a login when the CLI actually asked for one;
   * an undecidable probe must never wedge the user behind a sign-in gate.
   */
  probeAuth(): Promise<boolean> {
    return (this.probe ??= new Promise<boolean>((resolve) => {
      let settled = false;
      let signinTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (authenticated: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearTimeout(signinTimer);
        this.probe = undefined;
        this.dispose(PROBE_SESSION_ID);
        resolve(authenticated);
      };
      const timer = setTimeout(() => finish(true), PROBE_TIMEOUT_MS);
      this.start(PROBE_SESSION_ID, {
        onScreen: (view) => {
          if (offersSignIn(view)) {
            finish(false); // conclusive: it is asking which method to use
          } else if (view.state === "signin") {
            // Only the transient startup banner so far — let it prove itself.
            if (signinTimer === undefined) {
              signinTimer = setTimeout(() => finish(false), SIGNIN_CONFIRM_MS);
            }
          } else if (view.ready || trustPromptIndex(view) >= 0) {
            // A workspace-trust prompt settles this as surely as the input box:
            // the CLI only asks about the folder once it's past authentication.
            // Without it the probe matched nothing and burned its whole timeout
            // on a first run in an untrusted folder. Deliberately *recognised,
            // not answered* — a throwaway probe must not grant trust on the
            // user's behalf; the sign-in flow does that where it's visible.
            finish(true);
          }
        },
        onExit: () => finish(true)
      });
    }));
  }

  /**
   * Spawns an interactive `agy` for `id`. If one already runs, just re-points it
   * at the latest observer (e.g. after the webview reloads) and replays state.
   * `options` carries the per-session sandbox / skip-permissions toggles (#5).
   */
  start(id: string, observer: InteractiveObserver, options: SessionLaunchOptions = {}): void {
    const existing = this.live.get(id);
    if (existing) {
      existing.observer = observer;
      if (existing.lastSerialized) {
        const lines = existing.lastSerialized.split("\n");
        observer.onScreen(interpretScreen(lines), lines);
      }
      return;
    }

    const config = this.cli.getConfig();
    const agy = this.cli.resolveCommand();
    const dirs = this.cli.getWorkspaceDirs();
    const addDirs = config.autoAddWorkspaceFolders ? dirs.slice(1) : [];
    const argv = buildSessionArgs(
      { addDirs, sandbox: options.sandbox, skipPermissions: options.skipPermissions },
      config
    );
    // The launch plan is platform-specific: `script` (macOS/Linux) vs. a
    // node-pty ConPTY (Windows). The pure decision + argv live in core/ptyLauncher.
    const plan = planLaunch(process.platform, agy, argv, { cols: PTY_COLS, rows: PTY_ROWS });
    const env = { ...process.env, TERM: "xterm-256color" };

    const term = new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, scrollback: 5000, allowProposedApi: true });
    const entry: Live = {
      term, observer, raw: "", lastSerialized: "", ready: false, accountReady: false, sawPrompt: false, queue: [],
      write: () => {}, terminate: () => {} // replaced once the backend is spawned
    };
    // Never wait on the banner forever: if that account line somehow never gains
    // its suffix, go ahead anyway rather than sitting on the user's prompt. The
    // chat's re-send guard is still there to catch a submission dropped after.
    entry.initTimer = setTimeout(() => this.markReady(id), INIT_MAX_WAIT_MS);

    // Shared by both backends: fold raw output into the mirror + emulator +
    // debounced parse. Bytes arrive as a Buffer (`script`) or string (node-pty).
    const feed = (text: string): void => {
      entry.raw += text;
      if (entry.raw.length > RAW_CAP) {
        entry.raw = entry.raw.slice(-RAW_CAP);
      }
      entry.mirror?.(text);
      term.write(text);
      this.scheduleRender(id);
    };

    if (plan.kind === "conpty") {
      const nodePty = loadNodePty();
      if (!nodePty) {
        // Native Windows with no ConPTY backend: do NOT spawn `script` (it would
        // ENOENT and masquerade as "agy isn't installed"). Report the real cause
        // and the WSL fallback (#1, #2). Deferred so start() returns first.
        setTimeout(() => observer.onExit(null, missingPtyBackendMessage()), 0);
        return;
      }
      let p: IPtyLike;
      try {
        p = nodePty.spawn(plan.command, plan.args, {
          name: "xterm-256color", cols: plan.cols, rows: plan.rows, cwd: dirs[0], env
        });
      } catch (err) {
        // ConPTY refuses to start (typically the binary isn't where we resolved
        // it). Report that, not the generic "not signed in" (#1, #2).
        const reason = err instanceof Error ? err.message : String(err);
        setTimeout(() => observer.onExit(null, `Could not start \`${plan.command}\`: ${reason}`), 0);
        return;
      }
      entry.write = (data) => {
        try { p.write(data); } catch { /* pty gone */ }
      };
      entry.terminate = () => {
        try { p.kill(); } catch { /* already gone */ }
      };
      this.live.set(id, entry);
      p.onData((data) => feed(data));
      p.onExit(({ exitCode }) => this.handleExit(id, exitCode));
      return;
    }

    const proc = spawn(plan.command, plan.args, { cwd: dirs[0], env });
    entry.write = (data) => {
      try { proc.stdin?.write(data); } catch { /* stdin gone */ }
    };
    entry.terminate = () => {
      // Closing stdin is what actually reaps `agy`: the shim gives it its own
      // session and it ignores SIGHUP, so signalling the shim alone would orphan
      // it. EOF ends the shim's forwarding loop, which kills the child by pid
      // (see core/ptyLauncher.expectScript). The signals are the fallback for a
      // shim that doesn't act on EOF: SIGCONT first, because the wrapper blocks
      // on a Ctrl+Z'd child and ignores SIGTERM.
      try { proc.stdin?.end(); } catch { /* stdin gone */ }
      setTimeout(() => {
        try {
          proc.kill("SIGCONT");
          proc.kill("SIGKILL");
        } catch { /* already gone */ }
      }, SHUTDOWN_GRACE_MS);
    };
    this.live.set(id, entry);
    // Decode through a StringDecoder, never `buf.toString("utf8")` per
    // chunk: a PTY read splits wherever the kernel buffer ends, which lands
    // mid-codepoint often enough to matter as soon as the screen is not pure
    // ASCII. Decoding each chunk on its own turns the straddling character into
    // U+FFFD — measured with Chinese input (#8), that corrupted both the echoed
    // prompt and the CLI's own box-drawing rules, and a mangled rule makes
    // `agyScreen` misread the whole frame (the session never came back to
    // `idle`). StringDecoder holds the partial bytes until the rest arrives.
    // The node-pty backend above needs none of this: it hands us strings. One
    // decoder per stream, since they are independent byte streams.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    proc.stdout?.on("data", (buf: Buffer) => feed(outDecoder.write(buf)));
    proc.stderr?.on("data", (buf: Buffer) => feed(errDecoder.write(buf)));
    proc.on("exit", (code) => this.handleExit(id, code));
    proc.on("error", (err) =>
      this.handleExit(id, null, `Could not start \`${plan.command}\`: ${err.message}`)
    );
  }

  /** Sends a chat prompt (one logical line) to the agent, queueing if not ready. */
  send(id: string, text: string): void {
    const entry = this.live.get(id);
    if (!entry) {
      return;
    }
    // Last line of defence before the text becomes keystrokes on a real PTY:
    // control bytes in a prompt are keys the TUI acts on, not characters it
    // types (see core/inputSanitizer). The view sanitizes on the way in too;
    // this is idempotent, so the two never disagree.
    const line = sanitizePromptText(text);
    if (!entry.ready) {
      // Coalesce a repeat of the line already waiting: anything retrying a
      // send while we hold the queue would otherwise stack up copies, and the
      // flush on ready would submit every one of them. Only an identical
      // *consecutive* line is dropped, so genuinely distinct queued prompts
      // still all go through.
      if (entry.queue[entry.queue.length - 1] !== line) {
        entry.queue.push(line);
      }
      return;
    }
    entry.write(line + "\r");
  }

  /**
   * Types free text into whatever the CLI is currently waiting on, then presses
   * Enter as a SEPARATE write. Used for the sign-in flow's OAuth authorization
   * code (#7), which the normal {@link send} can't handle: that screen has no
   * pinned `>` box, so our readiness heuristic never flips and `send` would just
   * *queue* the code forever (it looked like "nothing happens" on submit); and it
   * is a paste widget that swallows a `\r` arriving in the same write as the
   * text, leaving the code entered but not submitted. So we skip the `ready`
   * gate (the user only submits once the code screen is up) and split the Enter.
   */
  submitInput(id: string, text: string): void {
    const entry = this.live.get(id);
    if (!entry) {
      return;
    }
    entry.write(sanitizePromptText(text));
    setTimeout(() => this.live.get(id)?.write("\r"), 120);
  }

  /** Sends a control key, e.g. ESC to cancel a generating turn or dismiss a selector. */
  sendKey(id: string, key: "escape" | "interrupt"): void {
    const seq = key === "escape" ? "\x1b" : "\x03";
    this.live.get(id)?.write(seq);
  }

  /**
   * Drives a single-select (state `"prompt"`): moves the caret from its current
   * row (`fromIndex`, parsed off the screen) to `targetIndex` and confirms — the
   * UI's equivalent of the user arrow-keying and pressing Enter.
   */
  selectOption(id: string, fromIndex: number, targetIndex: number, layout: Layout): void {
    this.write(id, selectionKeys(fromIndex, targetIndex, layout));
  }

  /** Moves a selector's caret one step (mirrors the user arrow-keying in the UI). */
  moveSelection(id: string, dir: "prev" | "next", layout: Layout): void {
    const back = layout === "horizontal" ? "\x1b[D" : "\x1b[A";
    const fwd = layout === "horizontal" ? "\x1b[C" : "\x1b[B";
    this.write(id, dir === "next" ? fwd : back);
  }

  /** Toggles a multi-select checkbox: move the caret to `targetIndex`, press "x". */
  toggleOption(id: string, fromIndex: number, targetIndex: number, layout: Layout): void {
    this.write(id, moveKeys(fromIndex, targetIndex, layout) + "x");
  }

  /** Submits a multi-select (Enter). */
  submitSelection(id: string): void {
    this.write(id, "\r");
  }

  private write(id: string, data: string): void {
    this.live.get(id)?.write(data);
  }

  /** Forwards raw keystrokes typed into the mirror terminal. */
  writeRaw(id: string, data: string): void {
    this.live.get(id)?.write(data);
  }

  /** Attaches a mirror sink (the visible terminal); returns the replay buffer. */
  attachMirror(id: string, sink: (data: string) => void): string {
    const entry = this.live.get(id);
    if (!entry) {
      return "";
    }
    entry.mirror = sink;
    return entry.raw;
  }

  detachMirror(id: string): void {
    const entry = this.live.get(id);
    if (entry) {
      entry.mirror = undefined;
    }
  }

  /**
   * Ends a session's process (used when the user deletes the session). Per the
   * desired flow (#6) we first send Ctrl+Z so `agy` ends the session from its
   * own perspective, then — after a short grace period — terminate the process.
   */
  dispose(id: string): void {
    this.end(id, true);
  }

  disposeAll(): void {
    // On shutdown we can't wait for async timers, so terminate immediately
    // (still sending Ctrl+Z first) rather than risk leaking processes.
    for (const id of [...this.live.keys()]) {
      this.end(id, false);
    }
  }

  /**
   * Sends Ctrl+Z (end the session) and then terminates `agy`. When `graceful`,
   * the terminate is deferred so the CLI can act on Ctrl+Z first; SIGCONT is
   * sent in case Ctrl+Z left the process stopped, so the terminate is delivered.
   */
  private end(id: string, graceful: boolean): void {
    const entry = this.live.get(id);
    if (!entry) {
      return;
    }
    this.live.delete(id);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    clearTimeout(entry.initTimer);
    try {
      entry.write("\x1a"); // Ctrl+Z — end the session from the CLI's view
    } catch {
      /* input already gone */
    }
    // The force-terminate is backend-specific (SIGCONT+SIGKILL for the `script`
    // wrapper; a plain kill for the ConPTY) — see the closures set in start().
    if (graceful) {
      setTimeout(entry.terminate, SHUTDOWN_GRACE_MS);
    } else {
      entry.terminate();
    }
  }

  private handleExit(id: string, code: number | null, error?: string): void {
    const entry = this.live.get(id);
    if (!entry) {
      return;
    }
    this.live.delete(id);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    clearTimeout(entry.initTimer);
    // Died before the prompt ever appeared: whatever it printed last is the real
    // reason (a `script` usage error, a CLI crash), so pass it up instead of
    // letting the view blame the sign-in state (#3).
    const tail = entry.sawPrompt ? undefined : lastOutputLine(entry.raw);
    entry.observer.onExit(code, error ?? (tail && `The Antigravity session ended before it was ready: ${tail}`));
  }

  /**
   * Debounce a burst of repaint bytes into one parse — but never past
   * {@link RENDER_MAX_WAIT_MS}.
   *
   * The cap is the whole point. A plain trailing debounce resets on every
   * chunk, and a generating `agy` animates its spinner continuously, so the
   * output stream never goes quiet for a full debounce interval: the timer was
   * pushed back forever and *no frame was parsed at all* until the turn ended.
   * Measured before this cap: five frames in forty-five seconds, with a whole
   * multi-second turn arriving as one already-finished screen — which is why
   * the live output window only ever showed a final snapshot, and showed
   * nothing at all on turns whose single frame came back complete.
   */
  private scheduleRender(id: string): void {
    const entry = this.live.get(id);
    if (!entry) {
      return;
    }
    // The cap clock starts on the first chunk after a parse, and is NOT reset
    // by later chunks — that is what stops a continuous stream from starving it.
    if (entry.renderDeadline === undefined) {
      entry.renderDeadline = Date.now() + RENDER_MAX_WAIT_MS;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    const wait = Math.max(0, Math.min(RENDER_DEBOUNCE_MS, entry.renderDeadline - Date.now()));
    entry.timer = setTimeout(() => this.render(id), wait);
  }

  private render(id: string): void {
    const entry = this.live.get(id);
    if (!entry) {
      return;
    }
    entry.timer = undefined;
    const hitCap = entry.renderDeadline !== undefined && Date.now() >= entry.renderDeadline;
    entry.renderDeadline = undefined;
    // A capped parse can read the emulator a beat before it has applied the
    // newest bytes, so leave a trailing settled parse behind it to pick up the
    // remainder. Any further output reschedules this, and a parse that finds
    // the screen unchanged simply returns below.
    if (hitCap) {
      entry.timer = setTimeout(() => this.render(id), RENDER_DEBOUNCE_MS);
    }
    const buffer = entry.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    const serialized = lines.join("\n");
    if (serialized === entry.lastSerialized) {
      return;
    }
    entry.lastSerialized = serialized;

    const view = interpretScreen(lines);
    // The banner's account line completing is the CLI's own "initialised" tell;
    // latch it, because the banner scrolls away as the conversation grows.
    if (!entry.accountReady && bannerAccountReady(lines) === true) {
      entry.accountReady = true;
    }
    // Release prompts queued during boot only once the CLI can *accept* one.
    // The painted input box (`view.ready`) is not enough on its own: the CLI
    // draws it, and reports itself idle, several seconds before it will honour a
    // submission, and silently discards anything sent in between.
    const atPrompt = view.ready || view.state === "idle" || view.state === "generating" || view.state === "prompt";
    if (atPrompt) {
      entry.sawPrompt = true;
    }
    if (!entry.ready && entry.accountReady && atPrompt) {
      this.markReady(id);
    }
    entry.observer.onScreen(view, lines);
  }
}
