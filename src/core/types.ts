/**
 * Shared, dependency-free type definitions for the Antigravity extension core.
 *
 * Everything in `src/core` is deliberately free of any `vscode` import so it can
 * be unit-tested on bare Node (see `tsconfig.test.json`). These types describe
 * the contract between the pure core (argument building, binary resolution,
 * output parsing, onboarding logic) and the thin VS Code integration layer.
 */

/** User-facing configuration, mirrored from the `antigravity.*` settings. */
export interface AntigravityConfig {
  /** Path or bare command name for the CLI binary (default `"agy"`). */
  cliPath: string;
  /** Default `--model` value; empty string means "use the CLI default". */
  model: string;
  /** Extra arguments appended verbatim to every invocation. */
  extraArgs: string[];
  /** Whether to pass `--dangerously-skip-permissions`. */
  skipPermissions: boolean;
  /** Headless prompt timeout in milliseconds. */
  printTimeoutMs: number;
  /** Whether open workspace folders are passed via repeated `--add-dir`. */
  autoAddWorkspaceFolders: boolean;
  /** Requested headless output format. */
  outputFormat: "json" | "text";
  /** Shell command used by the "Install CLI" action. */
  installCommand: string;
}

/** Options for a single headless (`--print`) prompt. */
export interface PrintOptions {
  /** The natural-language prompt to send to the agent. */
  prompt: string;
  /** Absolute paths to expose to the agent via `--add-dir`. */
  addDirs?: string[];
  /** Resume a specific prior conversation by id. */
  conversationId?: string;
  /** Continue the most recent conversation instead of starting fresh. */
  continueConversation?: boolean;
  /** Override the configured model for this single call. */
  model?: string;
  /**
   * Run the prompt as a "goal" — i.e. instruct the agent to complete the whole
   * task without pausing for plan approval. Mirrors the CLI's `/goal` prefix.
   */
  goal?: boolean;
}

/** Options for launching the interactive TUI in a terminal. */
export interface SessionOptions {
  addDirs?: string[];
  conversationId?: string;
  continueConversation?: boolean;
  model?: string;
  /** An initial prompt to seed the interactive session (`--prompt-interactive`). */
  initialPrompt?: string;
}

/**
 * A normalized event produced from the CLI's `--output-format json` stream.
 *
 * The real `agy` JSON schema is not publicly pinned, so {@link normalizeEvent}
 * maps several plausible field names onto this small, stable shape. Unknown
 * payloads survive as `raw` events rather than being dropped.
 */
export type AgyEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  | { kind: "result"; text: string; isError: boolean; conversationId?: string; usage?: AgyUsage }
  | { kind: "error"; message: string }
  | { kind: "raw"; line: string };

/** Token-usage accounting, when the CLI reports it. */
export interface AgyUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Result of probing the environment for a usable CLI binary. */
export interface DetectionResult {
  /** The resolved command/path that will be spawned. */
  command: string;
  /** True when the binary was found on disk or assumed resolvable via PATH. */
  found: boolean;
  /** Version string parsed from `agy --version`, when available. */
  version?: string;
  /**
   * True when we have positive evidence the user is signed in. This is best
   * effort: absence does not always mean "logged out".
   */
  loggedIn?: boolean;
}

/** A discrete action the onboarding logic can recommend to the user. */
export type OnboardingAction = "install" | "login" | "none";

/** Outcome of {@link decideOnboarding}: what to tell the user and how to fix it. */
export interface OnboardingDecision {
  action: OnboardingAction;
  /** Human-readable headline shown in a notification or the chat panel. */
  message: string;
  /** True when the extension can still attempt to run prompts. */
  canRun: boolean;
}
