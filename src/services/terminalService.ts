/**
 * Owns the VS Code integrated terminal(s) used for the CLI lifecycle actions
 * that want a real, user-visible TTY: install/update, changelog, and plugin
 * management.
 *
 * Chat — and the sign-in flow — are separate: each drives its own interactive
 * `agy` via [services/interactiveSession.ts], mirrored into a terminal on
 * demand. This service handles the standalone command-palette actions.
 */
import * as vscode from "vscode";

import { ShellKind, buildSessionArgs, buildSubcommandArgs, detectShellKind, quoteCommand } from "../core/argBuilder";
import { SessionOptions } from "../core/types";
import { CliService } from "./cliService";

/** Stable name so we reuse a single Antigravity terminal rather than spawning many. */
const TERMINAL_NAME = "Antigravity";

export class TerminalService {
  private terminal: vscode.Terminal | undefined;
  /** True once an interactive `agy` session has been launched in the terminal. */
  private sessionActive = false;

  constructor(private readonly cli: CliService) {}

  /**
   * The shell our terminal will run — we create it with no explicit `shellPath`,
   * so it uses the user's default (`vscode.env.shell`). We quote every command
   * line for *that* shell so a Windows path is executed, not echoed (#2).
   */
  private shellKind(): ShellKind {
    return detectShellKind(process.platform, vscode.env.shell);
  }

  /** Returns the shared Antigravity terminal, creating it if needed. */
  private getTerminal(): vscode.Terminal {
    if (!this.terminal || this.isClosed(this.terminal)) {
      this.terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, iconPath: new vscode.ThemeIcon("rocket") });
      this.sessionActive = false; // a fresh terminal has no running session
    }
    return this.terminal;
  }

  /** True when a terminal has been closed by the user. */
  private isClosed(terminal: vscode.Terminal): boolean {
    return vscode.window.terminals.indexOf(terminal) === -1;
  }

  /** Launches (or focuses) the interactive agent TUI. */
  startSession(options: SessionOptions = {}): void {
    const command = this.cli.resolveCommand();
    const args = buildSessionArgs(options, this.cli.getConfig());
    this.run(quoteCommand(command, args, this.shellKind()));
    this.sessionActive = true;
  }

  /**
   * Sends a slash command to the interactive session. If no session is running
   * yet, one is started first; the terminal queues the command so the TUI picks
   * it up once it is ready.
   */
  sendSlashCommand(line: string): void {
    if (!this.sessionActive || !this.terminal || this.isClosed(this.terminal)) {
      this.startSession();
    } else {
      this.terminal.show(true);
    }
    this.getTerminal().sendText(line, true);
  }

  /** Signs out via the TUI's `/logout` slash command. */
  logout(): void {
    this.sendSlashCommand("/logout");
  }

  /** Runs the CLI self-update command. */
  update(): void {
    this.runSubcommand("update");
  }

  /** Shows the CLI changelog in the terminal. */
  changelog(): void {
    this.runSubcommand("changelog");
  }

  /** Runs a plugin management command, e.g. `plugin list`. */
  runPluginCommand(args: string[]): void {
    const command = this.cli.resolveCommand();
    this.run(quoteCommand(command, ["plugin", ...args], this.shellKind()));
  }

  /** Runs a bare subcommand (`update`, `changelog`). */
  private runSubcommand(sub: "update" | "changelog"): void {
    const command = this.cli.resolveCommand();
    this.run(quoteCommand(command, buildSubcommandArgs(sub), this.shellKind()));
    this.sessionActive = false; // a subcommand is not an interactive session
  }

  /** Shows the terminal and sends a command line to it. */
  private run(commandLine: string): void {
    const terminal = this.getTerminal();
    terminal.show(true);
    terminal.sendText(commandLine, true);
  }

  /** Disposes the owned terminal on extension shutdown. */
  dispose(): void {
    this.terminal?.dispose();
  }
}
