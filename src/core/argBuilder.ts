/**
 * Pure functions that translate high-level intents (run a headless prompt,
 * start an interactive session, sign in, …) into the exact `agy` argument
 * vectors. Keeping this logic free of `vscode` and side effects makes the most
 * error-prone part of a CLI wrapper — the flags — fully unit-testable.
 *
 * Flag names follow the documented Antigravity CLI surface:
 *   --print / -p, --output-format, --model, --add-dir, --continue / -c,
 *   --conversation, --prompt-interactive / -i, --dangerously-skip-permissions,
 *   --print-timeout, --version.
 */
import { AntigravityConfig, PrintOptions, SessionOptions } from "./types";

/** The `/goal ` prefix tells the agent to run a task to completion. */
const GOAL_PREFIX = "/goal ";

/**
 * Appends flags that are common to every model-driven invocation: the model,
 * the workspace directories, permission-skipping, and any user `extraArgs`.
 * Mutates and returns `args` for ergonomic chaining.
 */
function applyCommonFlags(
  args: string[],
  config: AntigravityConfig,
  opts: { addDirs?: string[]; model?: string }
): string[] {
  const model = opts.model || config.model;
  if (model) {
    args.push("--model", model);
  }
  for (const dir of opts.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  if (config.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (config.extraArgs.length > 0) {
    args.push(...config.extraArgs);
  }
  return args;
}

/**
 * Builds the argv for a headless prompt (`agy --print …`). The prompt text is
 * always the final argument so it is never mistaken for a flag value.
 */
export function buildPrintArgs(opts: PrintOptions, config: AntigravityConfig): string[] {
  const args: string[] = ["--print"];

  if (config.outputFormat) {
    args.push("--output-format", config.outputFormat);
  }
  // Per-call timeout mirrors the configured budget so a hung agent is bounded.
  if (config.printTimeoutMs > 0) {
    args.push("--print-timeout", String(config.printTimeoutMs));
  }
  if (opts.continueConversation) {
    args.push("--continue");
  }
  if (opts.conversationId) {
    args.push("--conversation", opts.conversationId);
  }

  applyCommonFlags(args, config, { addDirs: opts.addDirs, model: opts.model });

  const prompt = opts.goal ? GOAL_PREFIX + opts.prompt : opts.prompt;
  args.push(prompt);
  return args;
}

/**
 * Builds the argv for an interactive TUI session launched in a terminal.
 * With no options this is simply `agy` (bare), which opens the full TUI.
 */
export function buildSessionArgs(opts: SessionOptions, config: AntigravityConfig): string[] {
  const args: string[] = [];

  if (opts.continueConversation) {
    args.push("--continue");
  }
  if (opts.conversationId) {
    args.push("--conversation", opts.conversationId);
  }

  applyCommonFlags(args, config, { addDirs: opts.addDirs, model: opts.model });

  // An initial prompt is passed last via the interactive variant so the TUI
  // opens pre-seeded but still interactive.
  if (opts.initialPrompt) {
    args.push("--prompt-interactive", opts.initialPrompt);
  }
  return args;
}

/** Argv for `agy --version`. */
export function buildVersionArgs(): string[] {
  return ["--version"];
}

/**
 * Argv for self-update (`agy update`). Subcommand, not a flag, so it leads.
 */
export function buildUpdateArgs(): string[] {
  return ["update"];
}

/**
 * Renders an argv array back into a copy-pasteable shell command string,
 * quoting only the arguments that actually need it. Used for terminal display
 * and the "Install CLI" affordance — never for execution (we always spawn with
 * an explicit argv to avoid shell injection).
 */
export function quoteCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteArg).join(" ");
}

/** Quotes a single argument for human-readable display. */
function quoteArg(arg: string): string {
  if (arg.length === 0) {
    return "''";
  }
  // Safe shell tokens (no whitespace or metacharacters) are shown bare.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  // Otherwise single-quote and escape embedded single quotes.
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
