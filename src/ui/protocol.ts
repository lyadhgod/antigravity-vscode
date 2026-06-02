/**
 * The typed message protocol spoken across the webview boundary.
 *
 * The extension host and the in-webview script run in separate JavaScript
 * realms and can only exchange JSON via `postMessage`. Declaring both
 * directions here keeps the provider (TypeScript) and `media/main.js` honest
 * about the same contract.
 */
import { AgyEvent } from "../core/types";

/** Snapshot of readiness shown in the panel header and welcome state. */
export interface ChatState {
  /** Whether prompts can currently run (CLI present + presumed signed in). */
  ready: boolean;
  /** Recommended onboarding action, if any. */
  action: "install" | "login" | "none";
  /** Human-readable status line. */
  message: string;
  /** Active model label, for display. */
  model: string;
  /** CLI version, when known. */
  version?: string;
}

/** Messages sent from the extension host → webview. */
export type HostToWebview =
  | { type: "state"; state: ChatState }
  | { type: "userMessage"; text: string }
  | { type: "event"; event: AgyEvent }
  | { type: "busy"; value: boolean }
  | { type: "done"; ok: boolean; timedOut: boolean }
  | { type: "clear" };

/** Messages sent from the webview → extension host. */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "submit"; text: string; goal: boolean }
  | { type: "cancel" }
  | { type: "newChat" }
  | { type: "command"; id: string };
