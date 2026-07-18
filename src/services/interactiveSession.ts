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

import { Terminal } from "@xterm/headless";

import { buildSessionArgs } from "../core/argBuilder";
import { ScreenView, interpretScreen, moveKeys, selectionKeys } from "../core/agyScreen";
import { missingPtyBackendMessage, planLaunch } from "../core/ptyLauncher";
import { AntigravityConfig } from "../core/types";

/** Minimal shape of the optional native `node-pty` backend used on Windows (#1, #2). */
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
 * Lazily loads the optional native `node-pty` backend (Windows ConPTY). It is
 * NOT a hard dependency, so absence returns `undefined` rather than throwing —
 * Unix never reaches here (it uses the `script` shim). `node-pty` is marked
 * external in esbuild so this stays a runtime require, not a bundled module.
 */
function loadNodePty(): NodePtyModule | undefined {
  try {
    return require("node-pty") as NodePtyModule;
  } catch {
    return undefined;
  }
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
/** Cap the mirror replay buffer so a long session can't grow unbounded. */
const RAW_CAP = 1_500_000;
/** Grace period after Ctrl+Z (end the session, #6) before we terminate `agy`. */
const SHUTDOWN_GRACE_MS = 250;

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
  lastSerialized: string;
  /** Becomes true once the input prompt is first ready; gates queued input. */
  ready: boolean;
  /** Prompts requested before the agent was ready, flushed on first idle. */
  queue: string[];
  /** Backend-agnostic input write (`script` stdin or the node-pty ConPTY). */
  write: (data: string) => void;
  /** Backend-agnostic force-terminate (reaps `script`+`agy`, or kills the ConPTY). */
  terminate: () => void;
}

export class InteractiveSessionService {
  private readonly live = new Map<string, Live>();

  constructor(private readonly cli: AgyEnv) {}

  isRunning(id: string): boolean {
    return this.live.has(id);
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
      term, observer, raw: "", lastSerialized: "", ready: false, queue: [],
      write: () => {}, terminate: () => {} // replaced once the backend is spawned
    };

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
      const p = nodePty.spawn(plan.command, plan.args, {
        name: "xterm-256color", cols: plan.cols, rows: plan.rows, cwd: dirs[0], env
      });
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
      try {
        // The `script` wrapper blocks on a Ctrl+Z'd child and ignores SIGTERM,
        // so resume it (SIGCONT) and force-terminate (SIGKILL); this reaps both
        // `script` and `agy` with no orphans (verified against the real CLI).
        proc.kill("SIGCONT");
        proc.kill("SIGKILL");
      } catch { /* already gone */ }
    };
    this.live.set(id, entry);
    proc.stdout?.on("data", (buf: Buffer) => feed(buf.toString("utf8")));
    proc.stderr?.on("data", (buf: Buffer) => feed(buf.toString("utf8")));
    proc.on("exit", (code) => this.handleExit(id, code));
    proc.on("error", () => this.handleExit(id, null));
  }

  /** Sends a chat prompt (one logical line) to the agent, queueing if not ready. */
  send(id: string, text: string): void {
    const entry = this.live.get(id);
    if (!entry) {
      return;
    }
    const line = text.replace(/\r?\n/g, " ");
    if (!entry.ready) {
      entry.queue.push(line);
      return;
    }
    entry.write(line + "\r");
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
    entry.observer.onExit(code, error);
  }

  private scheduleRender(id: string): void {
    const entry = this.live.get(id);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.timer = setTimeout(() => this.render(id), RENDER_DEBOUNCE_MS);
  }

  private render(id: string): void {
    const entry = this.live.get(id);
    if (!entry) {
      return;
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
    // Once the prompt is first ready, release any prompts queued during boot.
    if (!entry.ready && (view.state === "idle" || view.state === "generating" || view.state === "prompt")) {
      entry.ready = true;
      const queued = entry.queue.splice(0);
      for (const line of queued) {
        entry.write(line + "\r");
      }
    }
    entry.observer.onScreen(view, lines);
  }
}
