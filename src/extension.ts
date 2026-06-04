/**
 * Extension entry point.
 *
 * Activation is light: construct the service graph, register the chat webview
 * and all commands, and let the webview probe the CLI lazily (so activation
 * never blocks on a missing/slow binary or a sign-in check).
 *
 * Architecture (see docs/ARCHITECTURE.md):
 *   core/*      — pure, vscode-free logic (resolution, args, onboarding, slash catalog)
 *   services/*  — CliService (headless prompts + auth) + TerminalService (interactive)
 *   ui/*        — ChatViewProvider (Material 3 webview, auth gate, slash routing)
 *   commands/*  — command wiring onto the services
 */
import * as vscode from "vscode";

import { registerCommands } from "./commands";
import { CliService } from "./services/cliService";
import { InteractiveSessionService } from "./services/interactiveSession";
import { TerminalService } from "./services/terminalService";
import { ChatViewProvider } from "./ui/chatViewProvider";

/** Called by VS Code the first time any activation event fires. */
export function activate(context: vscode.ExtensionContext): void {
  // 1. Service graph.
  const cli = new CliService();
  const terminal = new TerminalService(cli);
  const interactive = new InteractiveSessionService(cli);
  const chat = new ChatViewProvider(context.extensionUri, cli, interactive, context);

  // 2. Register the Material 3 chat panel in the activity-bar container.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      // Keep the transcript alive when hidden so a long-running turn isn't lost.
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // 3. Commands + lifecycle.
  registerCommands(context, { cli, terminal, chat });
  context.subscriptions.push({ dispose: () => terminal.dispose() });
  // Kill every background interactive `agy` process on shutdown.
  context.subscriptions.push({ dispose: () => interactive.disposeAll() });

  // 4. Refresh the panel when relevant settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("antigravity")) {
        void chat.refreshState();
      }
    })
  );
}

/** Disposables registered in {@link activate} handle teardown; nothing else to do. */
export function deactivate(): void {
  /* no-op */
}
