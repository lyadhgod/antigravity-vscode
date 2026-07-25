/**
 * Shared, dependency-free type definitions for the Antigravity extension core.
 *
 * Everything in `src/core` is deliberately free of any `vscode` import so it can
 * be unit-tested on bare Node (see `tsconfig.test.json`). These types describe
 * the contract between the pure core (argument building, binary resolution,
 * auth/onboarding logic, slash-command catalog) and the VS Code layer.
 *
 * NOTE on the CLI surface: verified against the real `agy` v1.0.4. Chat runs the
 * **interactive** TUI (`agy` with no `--print`) so a session keeps conversation
 * state in one long-lived process. There is no `--output-format`/`--model` flag
 * (passing them errors). Auth is an OAuth token cached on disk; there is no
 * `login` subcommand (the first interactive run starts the Google sign-in flow).
 */

/** User-facing configuration, mirrored from the `antigravity.*` settings. */
export interface AntigravityConfig {
  /** Path or bare command name for the CLI binary (default `"agy"`). */
  cliPath: string;
  /** Whether to pass `--dangerously-skip-permissions`. */
  skipPermissions: boolean;
  /** Whether to pass `--sandbox` (terminal restrictions). */
  sandbox: boolean;
  /** Whether open workspace folders are passed via repeated `--add-dir`. */
  autoAddWorkspaceFolders: boolean;
}

/** Options for launching the interactive TUI in a terminal. */
export interface SessionOptions {
  addDirs?: string[];
  conversationId?: string;
  continueConversation?: boolean;
  /** Run the session sandboxed (`--sandbox`). When set, overrides the config. */
  sandbox?: boolean;
  /** Skip tool-permission prompts (`--dangerously-skip-permissions`). Overrides config. */
  skipPermissions?: boolean;
  /** An initial prompt to seed the session (`--prompt-interactive`). */
  initialPrompt?: string;
}

/** Result of probing the environment for a usable, authenticated CLI. */
export interface DetectionResult {
  /** The resolved command/path that will be spawned. */
  command: string;
  /** True when the binary ran successfully (so it exists and is executable). */
  found: boolean;
  /** Version string from `agy --version`, when available. */
  version?: string;
  /** True when an OAuth token is present on disk (best-effort sign-in check). */
  authenticated: boolean;
}

/** A discrete action the onboarding logic can recommend to the user. */
export type OnboardingAction = "notfound" | "login" | "none";

/** Outcome of {@link decideOnboarding}: what to tell the user and how to fix it. */
export interface OnboardingDecision {
  action: OnboardingAction;
  /** Human-readable headline shown in the chat panel / sign-in screen. */
  message: string;
  /** True when the extension can run prompts (installed AND authenticated). */
  canRun: boolean;
}

/** A single message in a session transcript (the extension's own copy). */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

/**
 * A chat session the extension owns and persists. While VS Code is open the
 * live conversation lives in the session's interactive `agy` process; we keep
 * our own `messages` copy so the transcript survives across restarts (the CLI
 * stores its own transcripts in SQLite we cannot read).
 */
export interface Session {
  /** Our own stable id. */
  id: string;
  /** Title derived from the first user message. */
  title: string;
  /** Reserved: an agy conversation id, if ever captured (not used for live chat). */
  conversationId?: string;
  /** Launch the session's `agy` sandboxed (chosen via the New Session menu, #5). */
  sandbox?: boolean;
  /** Launch with tool-permission prompts skipped (New Session menu, #5). */
  skipPermissions?: boolean;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

/**
 * Where a slash command should be executed. Slash commands are a TUI concept;
 * a few map to native extension actions, the rest are forwarded to the session's
 * live interactive `agy`, where they actually function.
 */
export type SlashTarget = "session" | "native";

/** A catalog entry for the in-UI slash-command navigator (#8). */
export interface SlashCommand {
  /** Includes the leading slash, e.g. `"/goal"`. */
  name: string;
  /** One-line description shown in the navigator. */
  description: string;
  /** How the extension routes it when chosen. */
  target: SlashTarget;
  /** True when the command expects trailing argument text (e.g. `/goal <task>`). */
  takesArgs?: boolean;
  /** Alternative name agy accepts (shown as "(alias)"), e.g. `/clear` ↔ `new`. */
  alias?: string;
}
