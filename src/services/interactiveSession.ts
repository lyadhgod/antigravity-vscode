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
import { ChildProcess, spawn } from "node:child_process";

import { Terminal } from "@xterm/headless";

import { buildSessionArgs } from "../core/argBuilder";
import { ScreenView, interpretScreen, moveKeys, selectionKeys } from "../core/agyScreen";
import { AntigravityConfig } from "../core/types";

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
  /** Fired (debounced) whenever the reconstructed screen changes. */
  onScreen(view: ScreenView): void;
  /** Fired once when the `agy` process exits (for any reason). */
  onExit(code: number | null): void;
}

interface Live {
  proc: ChildProcess;
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
        observer.onScreen(interpretScreen(existing.lastSerialized.split("\n")));
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

    // Build `stty <size>; exec agy …` and hand it to `script` as a single -c arg.
    const sh = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
    const inner =
      `stty rows ${PTY_ROWS} cols ${PTY_COLS} 2>/dev/null; exec ` +
      [agy, ...argv].map(sh).join(" ");

    const proc = spawn("script", ["-q", "-e", "-c", inner, "/dev/null"], {
      cwd: dirs[0],
      env: { ...process.env, TERM: "xterm-256color" }
    });

    const term = new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, scrollback: 5000, allowProposedApi: true });
    const entry: Live = { proc, term, observer, raw: "", lastSerialized: "", ready: false, queue: [] };
    this.live.set(id, entry);

    const onData = (buf: Buffer): void => {
      const text = buf.toString("utf8");
      entry.raw += text;
      if (entry.raw.length > RAW_CAP) {
        entry.raw = entry.raw.slice(-RAW_CAP);
      }
      entry.mirror?.(text);
      term.write(text);
      this.scheduleRender(id);
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
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
    entry.proc.stdin?.write(line + "\r");
  }

  /** Sends a control key, e.g. ESC to cancel a generating turn or dismiss a selector. */
  sendKey(id: string, key: "escape" | "interrupt"): void {
    const seq = key === "escape" ? "\x1b" : "\x03";
    this.live.get(id)?.proc.stdin?.write(seq);
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
    this.live.get(id)?.proc.stdin?.write(data);
  }

  /** Forwards raw keystrokes typed into the mirror terminal. */
  writeRaw(id: string, data: string): void {
    this.live.get(id)?.proc.stdin?.write(data);
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
    const { proc } = entry;
    try {
      proc.stdin?.write("\x1a"); // Ctrl+Z — end the session from the CLI's view
    } catch {
      /* stdin already gone */
    }
    const terminate = (): void => {
      try {
        // The `script` wrapper blocks on a Ctrl+Z'd child and ignores SIGTERM,
        // so resume it (SIGCONT) and force-terminate (SIGKILL); this reaps both
        // `script` and `agy` with no orphans (verified against the real CLI).
        proc.kill("SIGCONT");
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    if (graceful) {
      setTimeout(terminate, SHUTDOWN_GRACE_MS);
    } else {
      terminate();
    }
  }

  private handleExit(id: string, code: number | null): void {
    const entry = this.live.get(id);
    if (!entry) {
      return;
    }
    this.live.delete(id);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    entry.observer.onExit(code);
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
        entry.proc.stdin?.write(line + "\r");
      }
    }
    entry.observer.onScreen(view);
  }
}
