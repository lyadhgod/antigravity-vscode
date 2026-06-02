/**
 * Extension entry point.
 *
 * Activation is intentionally light: construct the service graph, register the
 * chat webview + all commands + the status bar, and probe the CLI once so the
 * UI can guide installation/sign-in if needed. Everything that talks to the CLI
 * does so lazily, so activation never blocks on a missing or slow binary.
 *
 * Architecture (see docs/ARCHITECTURE.md):
 *   core/*      — pure, vscode-free logic (resolution, args, parsing, onboarding)
 *   services/*  — CliService (headless prompts) + TerminalService (interactive)
 *   ui/*        — ChatViewProvider (Material 3 webview) + StatusBar
 *   commands/*  — command wiring onto the services
 */
import * as vscode from "vscode";

import { registerCommands } from "./commands";
import { CliService } from "./services/cliService";
import { TerminalService } from "./services/terminalService";
import { ChatViewProvider } from "./ui/chatViewProvider";
import { StatusBar } from "./ui/statusBar";

/** Called by VS Code the first time any activation event fires. */
export function activate(context: vscode.ExtensionContext): void {
  // 1. Service graph. CliService owns config/detection/headless runs;
  //    TerminalService owns the interactive TTY surface.
  const cli = new CliService();
  const terminal = new TerminalService(cli);
  const chat = new ChatViewProvider(context.extensionUri, cli);
  const statusBar = new StatusBar(cli);

  // 2. Register the Material 3 chat panel in the activity-bar container.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      // Keep the transcript alive when the panel is hidden so a long-running
      // turn isn't lost when the user switches views.
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // 3. Commands + lifecycle disposables.
  registerCommands(context, { cli, terminal, chat, statusBar });
  context.subscriptions.push(statusBar, { dispose: () => terminal.dispose() });

  // 4. Re-probe and refresh the UI whenever relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("antigravity")) {
        void statusBar.refresh();
        void chat.refreshState();
      }
    })
  );

  // 5. Initial probe (non-blocking) so the status bar reflects reality.
  void statusBar.refresh();
}

/** Disposables registered in {@link activate} handle teardown; nothing else to do. */
export function deactivate(): void {
  /* no-op */
}
