/**
 * The typed message protocol spoken across the webview boundary.
 *
 * The panel is two-step: a **sessions list** (step 1) and a **per-session chat**
 * (step 2). The host drives which step is shown via `sessions` / `openSession`.
 *
 * An assistant turn is driven from the live `agy` TUI, which we re-scrape on
 * every repaint, so we stream it as `streamStart → assistantText* → streamEnd`,
 * where each `assistantText` carries the **full current reply** (a replace, not
 * an append) — the screen is the source of truth, not a delta log.
 */
import { SelectPrompt } from "../core/agyScreen";
import { ChatMessage, SlashCommand } from "../core/types";

/** Per-session launch toggles chosen in the New Session menu (#5). */
export interface NewSessionOptions {
  sandbox: boolean;
  skipPermissions: boolean;
}

/**
 * An option selector the live `agy` TUI is blocking on, surfaced for the webview
 * to render as clickable choices/checkboxes (the model picker, sign-in method, a
 * clarifying or tool-permission question, a multi-select). It's the parser's
 * {@link SelectPrompt} sent verbatim.
 */
export type PromptPayload = SelectPrompt;

/** Snapshot of readiness shown by the panel (chat vs. sign-in vs. install). */
export interface ChatState {
  ready: boolean;
  action: "notfound" | "login" | "none";
  message: string;
  version?: string;
  /** Default New Session toggles, seeded from the `antigravity.*` settings (#5). */
  defaults?: NewSessionOptions;
}

/** A row in the sessions list (step 1). */
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** True while a prompt is in-flight for this session (shows a loader). */
  running: boolean;
}

/** Messages sent from the extension host → webview. */
export type HostToWebview =
  | { type: "state"; state: ChatState }
  | { type: "slashCatalog"; commands: SlashCommand[] }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "openSession"; id: string; title: string; messages: ChatMessage[] }
  | { type: "userMessage"; text: string }
  | { type: "streamStart" }
  /** Replaces the in-progress assistant bubble with the full current reply. */
  | { type: "assistantText"; text: string }
  | { type: "streamEnd"; ok: boolean; timedOut: boolean }
  | { type: "system"; text: string }
  | { type: "busy"; value: boolean }
  /** The live TUI is asking the user to pick an option — render it as buttons. */
  | { type: "prompt"; prompt: PromptPayload }
  /** The selector was answered/dismissed — remove the option card. */
  | { type: "promptEnd" }
  /** The CLI's `>` input box changed — mirror it into the chat box (2-way, #9). */
  | { type: "cliInput"; text: string }
  /** A spinner / `/tasks` background task is (in)active — show a non-blocking loader. */
  | { type: "working"; value: boolean }
  /** The sign-in flow reached the OAuth URL/code screen — show the gate's URL + code controls. */
  | { type: "loginUrl"; url: string }
  /** The sign-in flow was interrupted (the CLI process exited before reaching idle). */
  | { type: "loginError"; message: string };

/** Messages sent from the webview → extension host. */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "newSession"; options?: NewSessionOptions }
  | { type: "openSession"; id: string }
  | { type: "deleteSession"; id: string }
  | { type: "back" }
  | { type: "submit"; text: string }
  | { type: "cancel" }
  | { type: "login" }
  /** Enter the app despite an unconfirmed sign-in (the gate's "Continue anyway"). */
  | { type: "openAnyway" }
  | { type: "command"; id: string }
  /** The user chose option `index` from a single-select (jump to it + confirm). */
  | { type: "selectOption"; index: number }
  /** Move the live selector's caret one step (the user arrow-keyed in the UI). */
  | { type: "promptMove"; dir: "prev" | "next" }
  /** Toggle the checkbox of option `index` in a multi-select. */
  | { type: "promptToggle"; index: number }
  /** Submit a multi-select (Enter). */
  | { type: "promptSubmit" }
  /** Send free text to the CLI's current input (e.g. a "Write-in" answer, #5). */
  | { type: "sendText"; text: string }
  /** The user dismissed the selector (ESC / Cancel / Skip). */
  | { type: "promptCancel" }
  /** The gate's sign-in code box was submitted — send it to the CLI + Enter. */
  | { type: "loginSubmitCode"; code: string }
  /** The gate's "Open Browser" button for the sign-in URL. */
  | { type: "loginOpenUrl" }
  /** The gate's clipboard-copy button for the sign-in URL. */
  | { type: "loginCopyUrl" };
