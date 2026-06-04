/**
 * Owns the VS Code integrated terminal(s) used for the CLI lifecycle actions
 * that want a real, user-visible TTY: the Google sign-in flow, install/update,
 * changelog, and plugin management.
 *
 * Chat is separate: each session drives its own interactive `agy` via
 * [services/interactiveSession.ts], mirrored into a terminal on demand. This
 * service handles the standalone command-palette actions.
 */
import * as vscode from "vscode";

import { buildSessionArgs, buildSubcommandArgs, quoteCommand } from "../core/argBuilder";
import { SessionOptions } from "../core/types";
import { CliService } from "./cliService";

/** Stable name so we reuse a single Antigravity terminal rather than spawning many. */
const TERMINAL_NAME = "Antigravity";

export class TerminalService {
  private terminal: vscode.Terminal | undefined;
  /** True once an interactive `agy` session has been launched in the terminal. */
  private sessionActive = false;

  constructor(private readonly cli: CliService) {}

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
    this.run(quoteCommand(command, args));
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

  /**
   * Triggers the Google sign-in flow. The CLI starts authentication on first
   * run; on a desktop it opens the browser, on a remote/SSH host it prints an
   * authorization URL plus a one-time code in this terminal.
   */
  login(): void {
    this.startSession();
    vscode.window.showInformationMessage(
      "Antigravity sign-in started in the terminal. If a browser does not open, follow the printed URL and code, then reload."
    );
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
    this.run(quoteCommand(command, ["plugin", ...args]));
  }

  /** Runs a bare subcommand (`update`, `changelog`). */
  private runSubcommand(sub: "update" | "changelog"): void {
    const command = this.cli.resolveCommand();
    this.run(quoteCommand(command, buildSubcommandArgs(sub)));
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
