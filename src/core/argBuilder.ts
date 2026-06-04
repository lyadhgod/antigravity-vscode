/**
 * Pure functions that translate high-level intents into the exact `agy`
 * argument vectors. Keeping this logic free of `vscode` and side effects makes
 * the most error-prone part of a CLI wrapper — the flags — fully unit-testable.
 *
 * Flags verified against the real `agy` v1.0.4 `--help`:
 *   --continue/-c, --conversation <id>, --prompt-interactive/-i,
 *   --add-dir <path> (repeatable), --dangerously-skip-permissions, --sandbox.
 * Subcommands: install, update, changelog, plugin.
 * There is intentionally NO --model and NO --output-format (the CLI rejects
 * them). Chat uses the interactive TUI, so there is no print-args builder here.
 */
import { AntigravityConfig, SessionOptions } from "./types";

/**
 * Appends flags common to model-driven invocations: workspace directories,
 * sandbox, permission-skipping, and any user `extraArgs`. Mutates and returns
 * `args` for ergonomic chaining.
 */
function applyCommonFlags(args: string[], config: AntigravityConfig, addDirs?: string[]): string[] {
  for (const dir of addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  if (config.sandbox) {
    args.push("--sandbox");
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
 * Builds the argv for an interactive TUI session. With no options this is an
 * empty argv (bare `agy` opens the full TUI).
 */
export function buildSessionArgs(opts: SessionOptions, config: AntigravityConfig): string[] {
  const args: string[] = [];

  if (opts.continueConversation) {
    args.push("--continue");
  }
  if (opts.conversationId) {
    args.push("--conversation", opts.conversationId);
  }

  // Per-session toggles (the New Session menu, #5) override the global settings
  // when provided; `??` keeps the config default when an option is left unset.
  const effective: AntigravityConfig = {
    ...config,
    sandbox: opts.sandbox ?? config.sandbox,
    skipPermissions: opts.skipPermissions ?? config.skipPermissions
  };
  applyCommonFlags(args, effective, opts.addDirs);

  if (opts.initialPrompt) {
    args.push("--prompt-interactive", opts.initialPrompt);
  }
  return args;
}

/** Argv for `agy --version`. */
export function buildVersionArgs(): string[] {
  return ["--version"];
}

/** Argv for a subcommand with no extra flags (e.g. `update`, `changelog`). */
export function buildSubcommandArgs(subcommand: "update" | "changelog", rest: string[] = []): string[] {
  return [subcommand, ...rest];
}

/**
 * Renders an argv array back into a copy-pasteable shell command string,
 * quoting only the arguments that actually need it. Used for terminal display —
 * never for execution (we always spawn with an explicit argv).
 */
export function quoteCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteArg).join(" ");
}

/** Quotes a single argument for human-readable display. */
function quoteArg(arg: string): string {
  if (arg.length === 0) {
    return "''";
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
