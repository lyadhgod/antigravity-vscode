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
 * sandbox, and permission-skipping. Mutates and returns `args` for ergonomic
 * chaining.
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
 * The shell a command line will be *typed into* — a VS Code terminal runs the
 * user's shell, so what we `sendText` must be quoted for that shell, not just
 * POSIX. Getting this wrong is the Windows sign-in bug (#2): a POSIX
 * single-quoted path like `'C:\…\agy.exe'` is an inert *string literal* in
 * PowerShell (it's echoed, not executed) and mis-parsed in cmd.exe.
 */
export type ShellKind = "posix" | "powershell" | "cmd";

/**
 * Classifies the shell a VS Code terminal will run from `process.platform` and
 * (optionally) `vscode.env.shell`. Non-Windows is always POSIX. On Windows we
 * read the shell path: PowerShell/pwsh, cmd, or a POSIX shell (Git Bash / WSL /
 * sh); an unknown Windows shell defaults to PowerShell, VS Code's modern
 * default. Pure (no `vscode` import) so the mapping is unit-testable. `#2`
 */
export function detectShellKind(platform: NodeJS.Platform, shellPath?: string): ShellKind {
  if (platform !== "win32") {
    return "posix";
  }
  const s = (shellPath ?? "").toLowerCase();
  // Order matters: "powershell"/"pwsh" both contain "sh", so match them first.
  if (s.includes("powershell") || s.includes("pwsh")) {
    return "powershell";
  }
  if (s.includes("cmd")) {
    return "cmd";
  }
  if (s.includes("bash") || s.includes("wsl") || /(^|[\\/])sh(\.exe)?$/.test(s) || s.includes("zsh")) {
    return "posix";
  }
  return "powershell";
}

/**
 * Renders an argv array back into a copy-pasteable command string for `shell`,
 * quoting only the arguments that actually need it. Used both for terminal
 * *display* and for `sendText` into a live terminal — so it must produce a line
 * the target shell will actually execute (#2). We still never pass this to
 * `spawn` (there we always use an explicit argv, no shell).
 */
export function quoteCommand(command: string, args: string[], shell: ShellKind = "posix"): string {
  const parts = [command, ...args];
  if (shell === "powershell") {
    // The call operator `&` makes PowerShell *execute* a quoted path instead of
    // echoing it as a string literal — the crux of the Windows sign-in bug (#2).
    // Prefixing it is harmless even for a bare command (`& agy --version`).
    return "& " + parts.map(psQuote).join(" ");
  }
  if (shell === "cmd") {
    return parts.map(cmdQuote).join(" ");
  }
  return parts.map(posixQuote).join(" ");
}

/** POSIX (bash/zsh/sh): single-quote, escaping embedded quotes as `'\''`. */
function posixQuote(arg: string): string {
  if (arg.length === 0) {
    return "''";
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** PowerShell: single-quote (backslash is literal), escaping quotes by doubling. */
function psQuote(arg: string): string {
  if (arg.length === 0) {
    return "''";
  }
  // No backslash here: a Windows path (`C:\…`) must be quoted so the space-free
  // ones still execute cleanly via `&`, and the drive path is treated as a path.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "''")}'`;
}

/** cmd.exe: double-quote (backslash is a normal path char), escaping `"` by doubling. */
function cmdQuote(arg: string): string {
  if (arg.length === 0) {
    return '""';
  }
  // Backslash is fine bare in cmd, so a space-free Windows path needs no quotes.
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}
