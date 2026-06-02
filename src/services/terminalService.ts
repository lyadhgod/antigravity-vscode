/**
 * Owns the VS Code integrated terminal(s) used for everything that is inherently
 * interactive and best handled by the CLI's own TUI:
 *   - the full agent session (`agy`),
 *   - the Google sign-in flow (first run of `agy` opens a browser / prints a
 *     code), and
 *   - install/update commands.
 *
 * Headless prompts go through {@link CliService.runPrint} instead and render in
 * the Material 3 chat panel; this service is for the cases where a live TTY is
 * the right tool.
 */
import * as vscode from "vscode";

import { buildSessionArgs, buildUpdateArgs, quoteCommand } from "../core/argBuilder";
import { SessionOptions } from "../core/types";
import { CliService } from "./cliService";

/** Stable name so we reuse a single Antigravity terminal rather than spawning many. */
const TERMINAL_NAME = "Antigravity";

export class TerminalService {
  private terminal: vscode.Terminal | undefined;

  constructor(private readonly cli: CliService) {}

  /** Returns the shared Antigravity terminal, creating it if needed. */
  private getTerminal(): vscode.Terminal {
    // VS Code disposes terminals when the user closes them; detect that and
    // recreate so we never send text to a dead terminal.
    if (!this.terminal || this.isClosed(this.terminal)) {
      this.terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, iconPath: new vscode.ThemeIcon("rocket") });
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
  }

  /**
   * Triggers the Google sign-in flow. The CLI starts authentication on first
   * run; on a desktop it opens the browser, on a remote/SSH host it prints an
   * authorization URL plus a one-time code in this terminal.
   */
  login(): void {
    // Running the bare TUI is the documented entry point for first-run auth.
    this.startSession();
    vscode.window.showInformationMessage(
      "Antigravity sign-in started in the terminal. If a browser does not open, follow the printed URL and code."
    );
  }

  /**
   * Signs the user out. The CLI clears credentials via its `/logout` slash
   * command inside the TUI, so we open a session and send it.
   */
  logout(): void {
    this.startSession();
    this.getTerminal().sendText("/logout", true);
  }

  /** Runs the CLI self-update command. */
  update(): void {
    const command = this.cli.resolveCommand();
    this.run(quoteCommand(command, buildUpdateArgs()));
  }

  /**
   * Runs the configured install command. Used when the binary is missing, so it
   * intentionally does not depend on resolving `agy` first.
   */
  install(): void {
    this.run(this.cli.getConfig().installCommand);
    vscode.window.showInformationMessage(
      "Installing the Antigravity CLI in the terminal. After it finishes, run “Antigravity: Sign In”."
    );
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
