/**
 * Hosts the Material 3 Expressive panel as a `WebviewViewProvider`.
 *
 * The panel is two-step (#5):
 *   1. a **sessions list** — persisted chats, each openable or deletable, with a
 *      loader on any session whose prompt is still running;
 *   2. a **per-session chat** — streamed replies, a back chevron to the list.
 *
 * Each chat session is backed by its own **interactive `agy` process** (see
 * [services/interactiveSession.ts]). We drive that process and re-scrape its TUI
 * — there is no fragile conversation-id threading; the conversation lives in the
 * long-running process. Lifecycle is coupled both ways:
 *   - deleting a session disposes its process (and closes its mirror terminal);
 *   - the process exiting drops the session from the list automatically.
 *
 * The process runs hidden; the title-bar terminal button reveals a VS Code
 * terminal that *mirrors* it (and routes keystrokes back).
 *
 * Other responsibilities: the sign-in gate (#7) and slash routing (#8) — native
 * commands handled in-extension, the rest sent straight to the live session.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";

import { AgyState, ScreenView, findUrl, hasEchoFor, replyFor } from "../core/agyScreen";
import { decideOnboarding, offersSignIn, trustPromptIndex } from "../core/onboarding";
import { SessionPersistence, SessionStore } from "../core/sessionStore";
import { SLASH_COMMANDS, findSlashCommand, parseSlash } from "../core/slashCommands";
import { ChatMessage, Session } from "../core/types";
import { CliService } from "../services/cliService";
import { InteractiveSessionService } from "../services/interactiveSession";
import { HostToWebview, NewSessionOptions, WebviewToHost } from "./protocol";

/** workspaceState key under which sessions are persisted. */
const STORE_KEY = "antigravity.sessions.v1";

/** Id of the hidden interactive session driving the in-GUI sign-in flow (never added to the session store/list). */
const LOGIN_SESSION_ID = "__login__";

/** How long an unrecognized screen must sit unchanged before we reveal the CLI. */
const STUCK_REVEAL_MS = 5000;

/**
 * How long the screen must sit **completely unchanged**, still idle and still
 * without a reply, before we give up on the in-flight turn (see
 * {@link ChatViewProvider.armErrorCheck}). Measured against the real CLI, which
 * can go several seconds between accepting a prompt and painting its first
 * frame — so this needs clear air above that, while the only cost of erring
 * long is a slightly slower unlock on a turn that was never going to finish.
 */
const ERRORED_SETTLE_MS = 10000;

/**
 * How long a *never-echoed* prompt waits on a still screen before we simply
 * send it again. Much shorter than {@link ERRORED_SETTLE_MS}: an echo is the
 * CLI's immediate acknowledgement, so its absence on a screen that has stopped
 * moving already means the keystrokes were dropped — there's nothing to wait for.
 */
const NOT_ACCEPTED_RETRY_MS = 2500;

/**
 * How many times a dropped prompt is re-sent before giving up.
 *
 * agy paints its input box, and reports itself ready, before its auth and
 * eligibility caches have finished warming; anything typed inside that window
 * is silently discarded ("please try again shortly"). Its own log shows the
 * race on every single launch — "You are not logged into Antigravity" at
 * t+7ms, "Auth succeeded" at t+17ms, `Cache(userInfo)` refreshes still failing
 * after that — and the account tier only joins the header once it settles.
 *
 * This is not specific to how we launch it. Measured with a bare `script`-
 * wrapped CLI and no extension code at all: a prompt sent 2s after launch is
 * swallowed, the identical prompt sent at 25s answers normally. Typing by hand
 * simply takes longer than the window, which is why it only bites automation.
 * So the budget spans that measured window rather than a guess — re-sending is
 * exactly what a user does, and the turn then completes on its own.
 */
const MAX_PROMPT_RESENDS = 6;

/** Stored in place of the reply when the CLI took the turn but produced nothing. */
const ERRORED_NO_OUTPUT = "_(agy ended the turn without any output — it may have errored.)_";

/** Stored when the CLI kept discarding the prompt, even after we re-sent it. */
const ERRORED_NOT_ACCEPTED =
  "_(agy never accepted this prompt. See the output above, then try sending it again.)_";

/** Per-session live state held while its interactive process runs. */
interface SessionRuntime {
  /** The prompt awaiting a reply, or undefined when no turn is in flight. */
  pending?: string;
  /** Most recent run state seen, to detect the generating→idle completion. */
  lastState: AgyState;
  /** The latest interpreted screen, replayed when the chat is reopened. */
  lastView?: ScreenView;
  /** True once the agent reached its input prompt at least once. */
  readyOnce: boolean;
  /** True while the TUI is blocking on an option selector we've surfaced. */
  promptActive: boolean;
  /**
   * The `liveLog` text already handed to a now-frozen live-output window
   * (right before the most recent selector), so the window that resumes after
   * it is answered gets only what's new — see {@link onScreen}. `undefined`
   * before the first freeze of the current turn.
   */
  liveLogFlushed?: string;
  /**
   * Pending "did agy just error?" check, armed while the screen sits idle,
   * carrying our echo, with `liveLog` totally empty — nothing rendered since
   * the echo at all. Any frame with a reply, any liveLog content, a spinner or
   * a selector disarms it. See {@link ChatViewProvider.armErrorCheck}.
   */
  errorTimer?: ReturnType<typeof setTimeout>;
  /** How many times {@link ChatViewProvider.armErrorCheck} has re-sent `pending`. */
  resends?: number;
  /** Last "held, still initialising" flag pushed to the webview. */
  lastInitializing?: boolean;
  /** Last `>` input-box text seen, to push only changes to the webview (#9). */
  lastInput?: string;
  /** Last working/background-task flag pushed to the webview. */
  lastWorking?: boolean;
  /** The on-demand mirror terminal, if the user opened one. */
  mirror?: vscode.Terminal;
  /** True once the user closed the mirror — debug mode won't reopen it. */
  mirrorDismissed?: boolean;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "antigravity.chatView";

  private view?: vscode.WebviewView;
  private readonly store: SessionStore;
  /** The session currently shown in the chat step (undefined ⇒ list step). */
  private activeSessionId?: string;
  /** Live state keyed by session id; present iff a process is (being) run. */
  private readonly runtimes = new Map<string, SessionRuntime>();
  /** Sign-in flow state (the hidden `LOGIN_SESSION_ID` session). */
  private loginUrl?: string;
  /** True once an OAuth URL has been committed to the gate, so later frames don't re-arm the timer. */
  private loginUrlSurfaced = false;
  /** Most recent screen that looked like the OAuth URL block, kept fresh while `loginUrlTimer` is pending. */
  private loginUrlLines?: string[];
  private loginUrlTimer?: ReturnType<typeof setTimeout>;
  /** Signature of the sign-in selector already answered, so it is answered once. */
  private loginPromptSig?: string;
  private loginMirror?: vscode.Terminal;
  private loginMirrorDismissed = false;
  /** Pending "screen is stuck on something we don't recognize" timers, by session id. */
  private readonly stuckTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly cli: CliService,
    private readonly interactive: InteractiveSessionService,
    context: vscode.ExtensionContext
  ) {
    const persistence: SessionPersistence = {
      load: () => context.workspaceState.get<Session[]>(STORE_KEY, []),
      save: (sessions) => void context.workspaceState.update(STORE_KEY, sessions)
    };
    this.store = new SessionStore(persistence, () => crypto.randomUUID(), () => Date.now());

    // Closing a mirror terminal just detaches the view — the session and its
    // background process live on (the mirror is a peek, not the session itself).
    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((closed) => {
        for (const [id, rt] of this.runtimes) {
          if (rt.mirror === closed) {
            this.interactive.detachMirror(id);
            rt.mirror = undefined;
            rt.mirrorDismissed = true;
          }
        }
        if (this.loginMirror === closed) {
          this.interactive.detachMirror(LOGIN_SESSION_ID);
          this.loginMirror = undefined;
          this.loginMirrorDismissed = true;
        }
      })
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg));
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refreshState();
      }
    });
  }

  // --- Public API used by commands -----------------------------------------

  focus(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      void vscode.commands.executeCommand("antigravity.chatView.focus");
    }
  }

  /**
   * Creates a new session and opens it (the "+" / New Session action). The
   * optional `options` are the sandbox / skip-permissions toggles from the New
   * Session menu (#5); they are stored so the session relaunches with them.
   */
  newSession(options?: NewSessionOptions): void {
    const session = this.store.create(options ?? {});
    this.openSession(session.id);
    this.sendSessions();
  }

  /** Sends a prompt; ensures a session exists first (e.g. from Ask… commands). */
  ask(text: string): void {
    this.focus();
    if (!this.activeSessionId) {
      this.newSession();
    }
    this.submit(text);
  }

  /** Opens the slash navigator in the active chat (creating a session if needed). */
  openSlashNavigator(): void {
    this.focus();
    if (!this.activeSessionId) {
      this.newSession();
    }
    this.post({ type: "system", text: "__open_slash__" });
  }

  /**
   * Hard-interrupts the active session's current act — the Stop button (#6). ESC
   * cancels generation; if a selector is up, the first ESC only dismisses it, so
   * we send a second to also cancel the underlying turn. We persist any text that
   * already streamed, then drop the pending turn so later frames are ignored.
   */
  stop(): void {
    const id = this.activeSessionId;
    if (!id || !this.interactive.isRunning(id)) {
      return;
    }
    const rt = this.runtimes.get(id);
    this.interactive.sendKey(id, "escape");
    if (rt?.promptActive) {
      this.interactive.sendKey(id, "escape");
    }
    if (rt) {
      if (rt.pending !== undefined) {
        const reply = rt.lastView ? replyFor(rt.lastView, rt.pending) : "";
        if (reply) {
          this.store.addMessage(id, { role: "assistant", text: reply });
        }
      }
      rt.pending = undefined;
      rt.promptActive = false;
      rt.liveLogFlushed = undefined;
      this.disarmErrorCheck(rt); // an explicit Stop must not leave a re-send armed
    }
    this.post({ type: "promptEnd" });
    this.post({ type: "busy", value: false });
    this.sendSessions();
  }

  /** Dismisses the on-screen selector (a single ESC) without killing the turn. */
  private skipSelector(): void {
    const id = this.activeSessionId;
    if (id && this.interactive.isRunning(id)) {
      this.interactive.sendKey(id, "escape");
    }
  }

  /**
   * Answers the active session's on-screen selector by choosing option `index`
   * (the user clicked it). We move the TUI caret from where it currently sits to
   * `index` and confirm; the next rendered frame reflects the result.
   */
  private chooseOption(index: number): void {
    this.withPrompt((id, prompt) => {
      if (index >= 0 && index < prompt.options.length) {
        // Confirm the choice; the next (non-prompt) frame clears the card.
        this.interactive.selectOption(id, prompt.selectedIndex, index, prompt.layout);
      }
    });
  }

  /**
   * The reply text to stream for the in-flight turn. Normally {@link replyFor}
   * (matched to the echoed prompt, so a *previous* turn's answer is never shown).
   * But once a long response scrolls the `> prompt` echo line off the 40-row
   * screen, no visible turn matches `pending`, and the streaming prose becomes an
   * "orphan" turn (assistant text with no user echo). While the agent is still
   * generating (or has paused on a selector), fall back to that orphan so the
   * chat updates **live** — otherwise the text only surfaces when a selector pops
   * or the turn ends. A trailing turn that still carries a non-matching echo is a
   * stale previous answer, so it is deliberately not used.
   */
  private liveReply(view: ScreenView, pending: string): string {
    const reply = replyFor(view, pending);
    if (reply) {
      return reply;
    }
    if (view.state === "generating" || view.state === "prompt") {
      const last = view.turns[view.turns.length - 1];
      if (last && last.user === "" && last.assistant) {
        return last.assistant;
      }
    }
    return "";
  }

  /**
   * The portion of a turn's raw `liveLog` not yet shown in a frozen live
   * window — i.e. everything since the point we last handed off to an option
   * selector. `flushed` is exactly the text sent right before that freeze, so
   * stripping it as a prefix recovers just the new window's content; old
   * scrollback rows don't get rewritten, so `full` should always start with
   * it, but if that assumption ever breaks we fall back to the whole log
   * rather than showing nothing.
   */
  private sinceFlush(full: string, flushed: string | undefined): string {
    if (!flushed) {
      return full;
    }
    return full.startsWith(flushed) ? full.slice(flushed.length).replace(/^\n+/, "") : full;
  }

  /** Runs `fn` with the active session and its current on-screen selector, if any. */
  private withPrompt(fn: (id: string, prompt: NonNullable<ScreenView["prompt"]>) => void): void {
    const id = this.activeSessionId;
    const prompt = id ? this.runtimes.get(id)?.lastView?.prompt : undefined;
    if (id && prompt) {
      fn(id, prompt);
    }
  }

  /**
   * Toggles a VS Code terminal mirroring the active session's live process (#4).
   * If the mirror is already open it is closed (the background process keeps
   * running); otherwise it is created — starting the process first if needed —
   * showing the *same* ongoing conversation and forwarding keystrokes back to it.
   */
  toggleActiveSessionTerminal(): void {
    const id = this.activeSessionId;
    if (!id) {
      void vscode.window.showInformationMessage("Open a chat session first, then reveal its terminal.");
      return;
    }
    // Already showing → close it (clicking the terminal icon again, #4).
    if (this.runtimes.get(id)?.mirror) {
      this.disposeMirror(id);
      this.runtimes.get(id)!.mirrorDismissed = true;
      return;
    }
    const rt = this.ensureProcess(id);
    rt.mirrorDismissed = false;
    this.showMirror(id, rt);
  }

  /** True when `antigravity.debug` asks for every CLI process to be visible. */
  private get debug(): boolean {
    return vscode.workspace.getConfiguration("antigravity").get<boolean>("debug", false);
  }

  /** Opens (and reveals) the session's mirror terminal, unless one is already up. */
  private showMirror(id: string, rt: SessionRuntime): void {
    if (rt.mirror) {
      rt.mirror.show();
      return;
    }
    const title = this.store.get(id)?.title || "Antigravity";
    rt.mirror = this.createMirror(id, `Antigravity: ${title}`);
    rt.mirror.show();
  }

  /**
   * Fallback for a screen we don't know how to drive (either flow): when a frame
   * matches none of the patterns we automate and then sits unchanged for
   * {@link STUCK_REVEAL_MS}, reveal the mirror terminal so the user can act on it
   * themselves — regardless of `antigravity.debug`, and even if they had closed a
   * mirror earlier. Frames only arrive when the rendered screen actually changed
   * (see interactiveSession.render), so "no further frame" *is* "unchanged"; a
   * recognized frame just disarms the timer.
   */
  private watchStuck(id: string, recognized: boolean): void {
    clearTimeout(this.stuckTimers.get(id));
    this.stuckTimers.delete(id);
    if (recognized) {
      return;
    }
    this.stuckTimers.set(
      id,
      setTimeout(() => {
        this.stuckTimers.delete(id);
        this.revealCli(id);
      }, STUCK_REVEAL_MS)
    );
  }

  /**
   * Closes out the in-flight turn: records the reply, unlocks the composer, and
   * refreshes the session list. `errored` marks the case where the CLI ended the
   * turn without producing anything (see {@link armErrorCheck}) — the webview
   * shows it as a failed turn rather than a silent one.
   */
  private finishTurn(sessionId: string, reply: string, erroredText?: string): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) {
      return;
    }
    this.store.addMessage(sessionId, { role: "assistant", text: reply || erroredText || "_(no reply)_" });
    if (this.activeSessionId === sessionId) {
      if (reply) {
        this.post({ type: "assistantText", text: reply });
      }
      this.post({ type: "streamEnd", ok: !erroredText, timedOut: false });
      this.post({ type: "busy", value: false });
    }
    rt.pending = undefined;
    rt.liveLogFlushed = undefined;
    this.sendSessions();
  }

  /**
   * Arms (or **restarts**) the "this turn is going nowhere" check, called on
   * every frame that reads idle-with-no-reply. Restarting is the whole
   * mechanism: `onScreen` only fires when the rendered screen actually changed,
   * so the timer can only reach zero once the screen has been *completely
   * static* for {@link ERRORED_SETTLE_MS} while still idle and replyless.
   *
   * That is the signal that separates a dead turn from a slow one without
   * guessing: an agent that is genuinely working repaints (its spinner
   * animates, output streams), which restarts this; one that has printed its
   * piece and returned to the input line does not. Verified against the real
   * CLI, which rejects a prompt sent before its account-eligibility check
   * finishes — it prints a warning, never echoes the prompt, and then goes
   * perfectly still, which used to leave the composer locked forever.
   *
   * What happens when it fires depends on whether the prompt was ever echoed.
   * No echo means the CLI dropped the keystrokes, and it accepts the same text
   * moments later — so we just send it again (up to {@link MAX_PROMPT_RESENDS})
   * rather than reporting a failure the user would only have to retry by hand.
   */
  private armErrorCheck(sessionId: string, rt: SessionRuntime, view: ScreenView): void {
    clearTimeout(rt.errorTimer);
    // An echo is the CLI's acknowledgement: without one there is nothing left to
    // wait for, so a dropped prompt is re-sent promptly instead of after the
    // full give-up window.
    const echoed = rt.pending !== undefined && hasEchoFor(view, rt.pending);
    rt.errorTimer = setTimeout(() => {
      rt.errorTimer = undefined;
      // Bail if the session went away or the turn resolved while we waited.
      if (this.runtimes.get(sessionId) !== rt || rt.pending === undefined) {
        return;
      }
      const latest = rt.lastView;
      if (!latest || latest.state !== "idle" || this.liveReply(latest, rt.pending) !== "") {
        return;
      }
      if (!hasEchoFor(latest, rt.pending) && (rt.resends ?? 0) < MAX_PROMPT_RESENDS) {
        rt.resends = (rt.resends ?? 0) + 1;
        // What the CLI discards is the *submission*, not the typing: the text
        // reaches the `>` box fine, and Enter then clears the box without
        // running anything. So retype only when the box is actually empty —
        // typing into a box that still holds the prompt would concatenate it
        // into a corrupted one. When the text is already sitting there, the
        // only thing missing is the Enter.
        if ((latest.input ?? "").trim() === "") {
          this.interactive.send(sessionId, rt.pending);
        } else {
          this.interactive.writeRaw(sessionId, "\r");
        }
        // The re-send repaints the screen, which re-arms this through onScreen;
        // arm here too so a send the CLI *also* swallows silently still retries.
        this.armErrorCheck(sessionId, rt, latest);
        return;
      }
      this.finishTurn(sessionId, "", hasEchoFor(latest, rt.pending) ? ERRORED_NO_OUTPUT : ERRORED_NOT_ACCEPTED);
    }, echoed ? ERRORED_SETTLE_MS : NOT_ACCEPTED_RETRY_MS);
  }

  private disarmErrorCheck(rt: SessionRuntime): void {
    clearTimeout(rt.errorTimer);
    rt.errorTimer = undefined;
  }

  /** Force-shows a session's mirror terminal (clearing a previous dismissal). */
  private revealCli(id: string): void {
    if (!this.interactive.isRunning(id)) {
      return; // the process died while we waited — nothing left to mirror
    }
    if (id === LOGIN_SESSION_ID) {
      this.loginMirrorDismissed = false;
      this.showLoginMirror();
      return;
    }
    const rt = this.runtimes.get(id);
    if (rt) {
      rt.mirrorDismissed = false;
      this.showMirror(id, rt);
    }
  }

  /** Wires a Pseudoterminal mirroring the given interactive session's raw PTY output. */
  private createMirror(id: string, name: string): vscode.Terminal {
    const writer = new vscode.EventEmitter<string>();
    const pty: vscode.Pseudoterminal = {
      onDidWrite: writer.event,
      open: () => writer.fire(this.interactive.attachMirror(id, (data) => writer.fire(data))),
      close: () => this.interactive.detachMirror(id),
      handleInput: (data) => this.interactive.writeRaw(id, data)
    };
    return vscode.window.createTerminal({ name, pty });
  }

  // --- Sign-in flow (#7) ------------------------------------------------------
  //
  // Drives a hidden interactive `agy` (the same PTY→screen pipeline chat
  // sessions use, under a dedicated id never added to the session store) so the
  // gate can run the CLI's first-run login without a visible terminal: pick
  // "Google OAuth", surface the OAuth URL + code box in the gate, accept the
  // default color scheme, and only reveal a terminal for a screen it doesn't
  // recognize (the browser-consent confirmation) — closing it and refreshing
  // once the CLI reaches its normal ready prompt.

  /** Starts (once) the sign-in flow — the gate's "Sign in with Google" button. */
  startLogin(): void {
    if (this.interactive.isRunning(LOGIN_SESSION_ID)) {
      // Clicked again while a flow is already running — the browser round-trip
      // takes a while and the button disables itself on click, so this happens
      // whenever the CLI looks idle for a moment. Never start a second `agy`
      // (that is the race in refreshState above), but never swallow the click
      // either: re-surface what the running flow is waiting on, so the webview
      // ends up in a state its own messages can leave again (#8).
      this.showLoginMirror();
      if (this.loginUrl) {
        this.post({ type: "loginUrl", url: this.loginUrl });
      }
      return;
    }
    this.resetLoginUrlState();
    this.loginUrlSurfaced = false;
    // A previous flow's terminal (kept around by debug mode) is attached to a
    // dead process — drop it so this flow gets a fresh, live one.
    this.loginMirror?.dispose();
    this.loginMirror = undefined;
    this.loginMirrorDismissed = false;
    this.interactive.start(LOGIN_SESSION_ID, {
      onScreen: (view, lines) => this.onLoginScreen(view, lines),
      onExit: (_code, error) => this.onLoginExit(error)
    });
    // Visible for the whole flow (not just the unrecognized-screen fallback)
    // so the automation is inspectable while it runs.
    this.showLoginMirror();
  }

  /** Handles one settled screen frame from the sign-in session. */
  private onLoginScreen(view: ScreenView, lines: string[]): void {
    this.watchStuck(LOGIN_SESSION_ID, this.driveLogin(view, lines));
  }

  /**
   * Acts on one sign-in frame; returns whether it matched a screen we know how to
   * drive (an unrecognized one that then stalls surfaces the CLI, see watchStuck).
   */
  private driveLogin(view: ScreenView, lines: string[]): boolean {
    const prompt = view.prompt;
    if (prompt) {
      // Answer each selector once. Frames arrive far faster than a selector
      // changes, so without this the same choice is re-sent every frame — and
      // the extra Enters land on whatever screen comes next.
      const sig = prompt.title + "|" + prompt.options.map((o) => o.label).join("|");
      if (sig === this.loginPromptSig) {
        return true;
      }
      this.loginPromptSig = sig;
      const oauthIndex = prompt.options.findIndex((o) => /oauth/i.test(o.label));
      const trustIndex = trustPromptIndex(view);
      if (oauthIndex >= 0) {
        this.interactive.selectOption(LOGIN_SESSION_ID, prompt.selectedIndex, oauthIndex, prompt.layout);
      } else if (trustIndex >= 0) {
        // "Do you trust the contents of this project?" — the CLI asks this on a
        // first run in a folder, whether the user just signed in or was already
        // signed in. Nothing drove it before, so the flow parked here until the
        // stuck-watchdog gave up and dropped the user into a raw terminal. Say
        // yes for the workspace they already opened in the editor, and the very
        // next frame is the ready prompt that completes sign-in.
        this.interactive.selectOption(LOGIN_SESSION_ID, prompt.selectedIndex, trustIndex, prompt.layout);
      } else if (/color scheme/i.test(prompt.title)) {
        // Accept the default (already-selected) scheme — just confirm it.
        this.interactive.selectOption(LOGIN_SESSION_ID, prompt.selectedIndex, prompt.selectedIndex, prompt.layout);
      } else {
        // An unrecognized selector (e.g. the undocumented consent confirmation)
        // — nothing to automate; the user drives it in the revealed terminal.
        return false;
      }
      return true;
    }
    if (view.state === "idle") {
      this.finishLogin();
      return true;
    }
    if (findUrl(lines)) {
      // The URL block paints over more than one settled frame (each on its own
      // is already debounced, but the CLI keeps adding rows across several of
      // them) — keep the latest frame on hand, and give it a full second of
      // quiet before trusting it, rather than acting on whatever is on screen
      // the moment "http" first appears.
      this.loginUrlLines = lines;
      if (!this.loginUrlTimer && !this.loginUrlSurfaced) {
        this.loginUrlTimer = setTimeout(() => this.commitLoginUrl(), 1000);
      }
      return true;
    }
    return false; // an unrecognized screen — nothing to automate
  }

  /** Reads whatever the sign-in screen settled on ~1s after the URL first appeared. */
  private commitLoginUrl(): void {
    this.loginUrlTimer = undefined;
    const url = this.loginUrlLines && findUrl(this.loginUrlLines);
    if (!url || url === this.loginUrl) {
      return;
    }
    this.loginUrl = url;
    this.loginUrlSurfaced = true;
    // Deliberately NOT opened here: `agy` runs `open <url>` itself the moment it
    // paints this screen, so a second launch from us only added a redundant "open
    // the external website?" prompt for a page the CLI had already opened. The
    // gate's Open button still routes through vscode.env.openExternal for anyone
    // whose CLI auto-open didn't work.
    this.post({ type: "loginUrl", url });
  }

  /** The sign-in session reached the CLI's normal ready prompt — done. */
  private finishLogin(): void {
    this.interactive.dispose(LOGIN_SESSION_ID);
    this.hideLoginMirror();
    this.resetLoginUrlState();
    void this.refreshState();
  }

  /** The sign-in session's process exited before reaching idle. */
  private onLoginExit(error?: string): void {
    this.hideLoginMirror();
    this.resetLoginUrlState();
    // `error` is set for a hard "can't run at all" cause (e.g. no Windows ConPTY
    // backend, #1/#2); otherwise the flow was merely interrupted.
    this.post({ type: "loginError", message: error ?? "Sign-in was interrupted. Try again." });
  }

  private resetLoginUrlState(): void {
    this.loginUrl = undefined;
    this.loginPromptSig = undefined;
    this.loginUrlLines = undefined;
    clearTimeout(this.loginUrlTimer);
    this.loginUrlTimer = undefined;
  }

  private showLoginMirror(): void {
    if (this.loginMirror || this.loginMirrorDismissed) {
      return;
    }
    this.loginMirror = this.createMirror(LOGIN_SESSION_ID, "Antigravity Sign-in");
    this.loginMirror.show();
  }

  private hideLoginMirror(): void {
    // In debug mode the sign-in terminal stays up until the user closes it.
    if (this.loginMirror && !this.debug) {
      this.interactive.detachMirror(LOGIN_SESSION_ID);
      this.loginMirror.dispose();
      this.loginMirror = undefined;
    }
  }

  /** Re-probes the CLI and pushes readiness; when ready, also sends the list. */
  async refreshState(): Promise<void> {
    // A sign-in flow owns the CLI right now, so don't re-probe (#8). The probe
    // launches a SECOND `agy` (see interactiveSession.probeAuth) which races the
    // live one for the same credential store and hangs the sign-in — and this is
    // not a rare race: the OAuth step opens the external browser, so coming back
    // to the editor fires onDidChangeVisibility → refreshState on EVERY attempt.
    // Skipping the whole method also keeps the gate card intact: the "checking"
    // skeleton it posts would swap the card out and back, and the return trip
    // clears the OAuth URL row and whatever code was typed into it.
    // finishLogin()/onLoginExit() refresh the state when the flow ends, so
    // nothing is lost by dropping this one.
    if (this.interactive.isRunning(LOGIN_SESSION_ID)) {
      return;
    }
    const config = this.cli.getConfig();
    const defaults = { sandbox: config.sandbox, skipPermissions: config.skipPermissions };
    // The auth check launches the CLI and waits to see whether it asks for a
    // login, so this is not instant — tell the webview to show its skeleton.
    this.post({ type: "checking" });
    try {
      const detection = await this.cli.detect();
      const decision = decideOnboarding(detection);
      this.post({
        type: "state",
        state: {
          ready: decision.canRun,
          action: decision.action,
          message: decision.message,
          version: detection.version,
          defaults
        }
      });
      if (decision.canRun) {
        this.sendSessions();
      }
    } catch {
      this.post({
        type: "state",
        state: {
          ready: false,
          action: "notfound",
          message: "Couldn't check the Antigravity CLI. Make sure it's installed and you're signed in, then retry.",
          defaults
        }
      });
    }
  }

  // --- Message handling -----------------------------------------------------

  private onMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case "ready":
        this.post({ type: "slashCatalog", commands: SLASH_COMMANDS });
        void this.refreshState();
        break;
      case "newSession":
        this.newSession(msg.options);
        break;
      case "openSession":
        this.openSession(msg.id);
        break;
      case "deleteSession":
        this.deleteSession(msg.id);
        break;
      case "back":
        this.activeSessionId = undefined;
        this.sendSessions();
        break;
      case "submit":
        this.submit(msg.text);
        break;
      case "cancel":
        this.stop();
        break;
      case "selectOption":
        this.chooseOption(msg.index);
        break;
      case "promptMove":
        this.withPrompt((id, p) => this.interactive.moveSelection(id, msg.dir, p.layout));
        break;
      case "promptToggle":
        this.withPrompt((id, p) => {
          if (msg.index >= 0 && msg.index < p.options.length) {
            this.interactive.toggleOption(id, p.selectedIndex, msg.index, p.layout);
          }
        });
        break;
      case "promptSubmit":
        this.withPrompt((id) => this.interactive.submitSelection(id));
        break;
      case "sendText":
        // Free text for the CLI's current input (a Write-in answer, #5).
        if (this.activeSessionId && this.interactive.isRunning(this.activeSessionId)) {
          this.interactive.send(this.activeSessionId, msg.text);
        }
        break;
      case "promptCancel":
        this.skipSelector(); // the card's own Skip/Cancel: dismiss, keep the turn
        break;
      case "login":
        void vscode.commands.executeCommand("antigravity.login");
        break;
      case "loginSubmitCode":
        // The OAuth code screen has no pinned `>` box and is a paste widget, so
        // this must bypass the readiness queue and press Enter separately (#7).
        this.interactive.submitInput(LOGIN_SESSION_ID, msg.code);
        break;
      case "loginOpenUrl":
        if (this.loginUrl) {
          void vscode.env.openExternal(vscode.Uri.parse(this.loginUrl));
        }
        break;
      case "loginCopyUrl":
        if (this.loginUrl) {
          void vscode.env.clipboard.writeText(this.loginUrl);
          void vscode.window.showInformationMessage("Google OAuth sign-in link copied");
        }
        break;
      case "openAnyway":
        // The disk sign-in check can be a false negative; let the user proceed.
        // Populate the list — a session that truly isn't signed in will surface
        // agy's own sign-in flow in-chat.
        this.sendSessions();
        break;
      case "command":
        void vscode.commands.executeCommand(msg.id);
        break;
    }
  }

  private openSession(id: string): void {
    const session = this.store.get(id);
    if (!session) {
      return;
    }
    this.activeSessionId = id;
    this.post({ type: "openSession", id: session.id, title: session.title, messages: session.messages });

    // Restore the live state when reopening. The transcript was just rebuilt
    // from scratch, so — unlike the live onScreen path — everything posted
    // here is a FULL value, never a delta off `liveLogFlushed`.
    // If the session is blocking on a selector, replay the raw output frozen
    // just before it (if any), then the clickable options.
    const rt = this.runtimes.get(id);
    if (rt?.promptActive && rt.lastView?.prompt) {
      this.post({ type: "busy", value: false });
      if (rt.liveLogFlushed) {
        this.post({ type: "cliOutput", text: rt.liveLogFlushed });
      }
      this.post({ type: "prompt", prompt: rt.lastView.prompt });
      return;
    }
    // Otherwise, if a turn is still in flight, resume the live output window
    // with everything captured so far — and re-baseline the flush point to
    // match, so the next onScreen tick's delta lines up with what's now shown.
    const live = rt?.pending !== undefined;
    this.post({ type: "busy", value: live });
    if (live && rt) {
      const log = rt.lastView?.liveLog ?? "";
      rt.liveLogFlushed = log;
      this.post({ type: "cliOutput", text: log });
    }
  }

  private deleteSession(id: string): void {
    this.disposeMirror(id);
    this.interactive.dispose(id);
    this.runtimes.delete(id);
    this.store.delete(id);
    if (this.activeSessionId === id) {
      this.activeSessionId = undefined;
    }
    this.sendSessions();
  }

  /** Routes input for the active session: native slash commands vs. prompts. */
  private submit(text: string): void {
    const trimmed = text.trim();
    const id = this.activeSessionId;
    if (!trimmed || !id || this.runtimes.get(id)?.pending !== undefined) {
      return;
    }
    const slash = parseSlash(trimmed);
    if (slash && findSlashCommand(slash.command)?.target === "native") {
      this.handleNativeSlash(slash.command, trimmed);
      return;
    }
    // Plain prompts *and* session slash commands go straight to the live agent.
    this.runPrompt(id, trimmed);
  }

  private handleNativeSlash(command: string, raw: string): void {
    const id = this.activeSessionId!;
    this.record(id, { role: "user", text: raw });
    // Resolve aliases (e.g. `/new` → `/clear`) to the canonical command name.
    const canonical = findSlashCommand(command)?.name ?? command;
    switch (canonical) {
      case "/clear":
        this.newSession();
        return;
      case "/help":
        this.system(id, this.slashReference());
        return;
      case "/logout":
        void vscode.commands.executeCommand("antigravity.logout");
        break;
      case "/changelog":
        void vscode.commands.executeCommand("antigravity.showChangelog");
        break;
    }
    this.system(id, `Ran \`${canonical}\`.`);
  }

  /** Sends a prompt to the session's live process and begins streaming a reply. */
  private runPrompt(sessionId: string, prompt: string): void {
    this.store.addMessage(sessionId, { role: "user", text: prompt });
    const rt = this.ensureProcess(sessionId);
    rt.pending = prompt;
    rt.liveLogFlushed = undefined;
    rt.resends = 0;
    // Decided up front: the CLI may not repaint again for seconds while it
    // initialises, so waiting for the next frame would leave the window blank.
    rt.lastInitializing = !this.interactive.isReady(sessionId);

    if (this.activeSessionId === sessionId) {
      this.post({ type: "initializing", value: rt.lastInitializing });
      this.post({ type: "userMessage", text: prompt });
      this.post({ type: "busy", value: true });
      this.post({ type: "streamStart" });
    }
    this.interactive.send(sessionId, prompt);
    this.sendSessions(); // title + running indicator
  }

  /** Starts (once) the interactive process for a session and tracks its runtime. */
  private ensureProcess(sessionId: string): SessionRuntime {
    let rt = this.runtimes.get(sessionId);
    if (!rt) {
      rt = { lastState: "starting", readyOnce: false, promptActive: false };
      this.runtimes.set(sessionId, rt);
    }
    if (!this.interactive.isRunning(sessionId)) {
      const session = this.store.get(sessionId);
      this.interactive.start(
        sessionId,
        {
          onScreen: (view) => this.onScreen(sessionId, view),
          onExit: (code, error) => this.onExit(sessionId, code, error)
        },
        { sandbox: session?.sandbox, skipPermissions: session?.skipPermissions }
      );
    }
    if (this.debug && !rt.mirrorDismissed) {
      this.showMirror(sessionId, rt);
    }
    return rt;
  }

  /** Handles one settled screen frame from a session's process. */
  private onScreen(sessionId: string, view: ScreenView): void {
    const rt = this.runtimes.get(sessionId);
    if (!rt) {
      return;
    }
    // `view.ready` (input box painted) marks readiness independent of the status
    // wording, so a valid session never trips the "ended before ready" guard (#5).
    if (view.ready || view.state === "idle" || view.state === "generating" || view.state === "prompt") {
      rt.readyOnce = true;
    }
    // Anything that isn't one of the run states we render (i.e. still "starting"
    // with no input box painted) is a screen we can't drive — if it then sits
    // there, reveal the CLI so the user can (see watchStuck).
    this.watchStuck(sessionId, view.ready || view.state !== "starting");
    // The CLI is asking to sign in mid-session — the credential expired or was
    // revoked. Sessions all share the one account, so none of them can continue.
    //
    // "Mid-session" is the operative word: every launch prints "not signed in"
    // for a few seconds while it loads credentials, so that banner only counts
    // once this session has already reached its prompt. Acting on it during
    // startup tore down every session and bounced the user to the gate. An
    // auth-method selector is conclusive whenever it appears.
    if (offersSignIn(view) || (view.state === "signin" && rt.readyOnce)) {
      this.handleLoggedOut();
      return;
    }
    const active = this.activeSessionId === sessionId;

    // The TUI is blocking on an option selector: surface it as clickable
    // choices. The in-flight turn's raw output (tool calls, output, prose —
    // see `liveLog`) up to here is final, since the selector's own framing
    // starts right where it left off — flush it to the live window, freeze
    // that window by remembering how much of the log it now covers, then hand
    // off to the card. The window that resumes once it's answered starts
    // fresh underneath it (#raw-cli).
    if (view.state === "prompt" && view.prompt) {
      if (active && rt.pending !== undefined) {
        this.post({ type: "cliOutput", text: this.sinceFlush(view.liveLog, rt.liveLogFlushed) });
      }
      rt.liveLogFlushed = view.liveLog;
      if (active) {
        this.post({ type: "prompt", prompt: view.prompt });
      }
      rt.promptActive = true;
      rt.lastState = view.state;
      rt.lastView = view;
      return;
    }
    // The selector was just answered/dismissed — clear the card. If a turn is
    // still in flight, a fresh live-output window resumes underneath it (#4).
    if (rt.promptActive) {
      rt.promptActive = false;
      if (active) {
        this.post({ type: "promptEnd" });
        if (rt.pending !== undefined && view.state !== "idle") {
          this.post({ type: "cliOutput", text: this.sinceFlush(view.liveLog, rt.liveLogFlushed) });
        }
      }
    }

    if (rt.pending !== undefined) {
      if (view.state !== "idle") {
        // Still working: stream the raw log into the live window instead of a
        // bare spinner, so waiting on a reply shows what the CLI is doing.
        this.disarmErrorCheck(rt);
        if (active) {
          this.post({ type: "cliOutput", text: this.sinceFlush(view.liveLog, rt.liveLogFlushed) });
        }
      } else {
        const reply = this.liveReply(view, rt.pending);
        // A turn completes when the agent returns to idle after generating (or
        // after we answered a selector it had popped, e.g. `/model`).
        const finished = reply !== "" || rt.lastState === "generating" || rt.lastState === "prompt";
        if (finished) {
          this.disarmErrorCheck(rt);
          this.finishTurn(sessionId, reply);
        } else {
          // Idle, no reply yet, and we've never seen this turn look like it was
          // generating. `liveLog` is parsed straight from the raw screen (it
          // doesn't depend on the state guess above), so keep streaming it
          // regardless — a frame our coarser heuristic misreads as idle can
          // still carry real tool-call/prose output, and the live window must
          // show that instead of sitting on its placeholder until state agrees.
          if (active) {
            this.post({ type: "cliOutput", text: this.sinceFlush(view.liveLog, rt.liveLogFlushed) });
          }
          if (!this.interactive.isReady(sessionId)) {
            // The prompt is still held back until the CLI finishes initialising
            // — it has not been delivered yet, so there is nothing to time out
            // and nothing to re-send. Arming here would fire every couple of
            // seconds and queue another copy of the prompt behind the first,
            // and the flush on ready would then submit all of them at once.
            this.disarmErrorCheck(rt);
          } else {
            // Might be a dead turn, might be a dropped prompt, might just be
            // slow to start. Restart the settle timer on every such frame so it
            // can only fire once the screen has gone completely *static* in
            // this state — see armErrorCheck.
            this.armErrorCheck(sessionId, rt, view);
          }
        }
      }
    }

    // A prompt held back until the CLI finishes initialising — the one case the
    // live window explains itself, rather than sitting there looking stalled.
    const initializing = rt.pending !== undefined && !this.interactive.isReady(sessionId);
    if (active && initializing !== rt.lastInitializing) {
      this.post({ type: "initializing", value: initializing });
    }
    rt.lastInitializing = initializing;

    // 2-way input binding (#9): push the CLI's input-box text to the chat box
    // when it changes (the webview only adopts it when the user isn't typing).
    if (active && view.input !== undefined && view.input !== rt.lastInput) {
      this.post({ type: "cliInput", text: view.input });
    }
    rt.lastInput = view.input;

    // Non-blocking working/background-task loader (braille spinner or /tasks).
    const working = !!view.working;
    if (active && working !== rt.lastWorking) {
      this.post({ type: "working", value: working });
    }
    rt.lastWorking = working;
    rt.lastState = view.state;
    rt.lastView = view;
  }

  /**
   * Signed out mid-flight: end **every** session (their processes are all sitting
   * on the same sign-in wall) and send the user back to the gate with a marker
   * saying why. `loggedOut` is its own message rather than a `state` push because
   * it must also clear the webview's "continue anyway" latch — otherwise a user
   * who once clicked "Already signed in?" would be bounced past the gate.
   */
  private handleLoggedOut(): void {
    for (const id of [...this.runtimes.keys()]) {
      this.disposeMirror(id);
      this.interactive.dispose(id);
      this.runtimes.delete(id);
      this.store.delete(id);
    }
    this.activeSessionId = undefined;
    this.sendSessions();
    this.post({ type: "loggedOut", message: "You got logged out. Your sessions were ended. Sign in to continue." });
  }

  /** Handles a session's process exiting — drops the session (lifecycle #). */
  private onExit(sessionId: string, _code: number | null, error?: string): void {
    const rt = this.runtimes.get(sessionId);
    this.runtimes.delete(sessionId);
    this.disposeMirror(sessionId);

    if (rt?.readyOnce) {
      // The session's terminal ended ⇒ remove the session automatically.
      this.store.delete(sessionId);
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = undefined;
      }
      this.sendSessions();
    } else if (this.activeSessionId === sessionId) {
      // Never reached the prompt. Prefer a specific cause when we have one (e.g.
      // native Windows without a ConPTY backend, #1/#2); otherwise fall back to
      // the generic hint and re-check onboarding (maybe a sign-in issue).
      this.post({ type: "busy", value: false });
      this.system(
        sessionId,
        error ?? "The Antigravity session ended before it was ready. Check that `agy` is installed and you're signed in."
      );
      void this.refreshState();
    }
  }

  // --- Helpers --------------------------------------------------------------

  private disposeMirror(sessionId: string): void {
    const rt = this.runtimes.get(sessionId);
    if (rt?.mirror) {
      this.interactive.detachMirror(sessionId);
      rt.mirror.dispose();
      rt.mirror = undefined;
    }
  }

  /** Stores a user/assistant message and echoes it to the active view. */
  private record(sessionId: string, message: ChatMessage): void {
    this.store.addMessage(sessionId, message);
    if (this.activeSessionId === sessionId && message.role === "user") {
      this.post({ type: "userMessage", text: message.text });
    }
    this.sendSessions();
  }

  /** Stores and shows a system note in a session. */
  private system(sessionId: string, text: string): void {
    this.store.addMessage(sessionId, { role: "system", text });
    if (this.activeSessionId === sessionId) {
      this.post({ type: "system", text });
    }
  }

  private slashReference(): string {
    return "**Slash commands**\n" + SLASH_COMMANDS.map((c) => `- \`${c.name}\` — ${c.description}`).join("\n");
  }

  /** Pushes the current session list (with running flags) to the webview. */
  private sendSessions(): void {
    this.post({
      type: "sessions",
      sessions: this.store.list().map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        running: this.runtimes.get(s.id)?.pending !== undefined
      }))
    });
  }

  private post(message: HostToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  /** Loads the HTML shell and injects nonce, CSP, and asset URIs. */
  private renderHtml(webview: vscode.Webview): string {
    const mediaUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", file)).toString();
    const templatePath = vscode.Uri.joinPath(this.extensionUri, "media", "index.html").fsPath;
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data:`
    ].join("; ");
    return fs
      .readFileSync(templatePath, "utf8")
      .replace(/{{csp}}/g, csp)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{styleUri}}/g, mediaUri("main.css"))
      .replace(/{{scriptUri}}/g, mediaUri("main.js"))
      .replace(/{{logoUri}}/g, mediaUri("logo.svg"));
  }
}
