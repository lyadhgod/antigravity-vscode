/**
 * Registers every `antigravity.*` command and maps it onto the right service.
 *
 * Two interaction surfaces are exposed, matching how the CLI is actually used:
 *   - **Chat panel** (headless `--print`) for ask / selection / goal flows that
 *     render in the Material 3 webview.
 *   - **Integrated terminal** (interactive TUI) for full sessions, sign-in,
 *     install, and update — anything that wants a live TTY.
 */
import * as path from "node:path";
import * as vscode from "vscode";

import { decideOnboarding } from "../core/onboarding";
import { CliService } from "../services/cliService";
import { TerminalService } from "../services/terminalService";
import { ChatViewProvider } from "../ui/chatViewProvider";
import { StatusBar } from "../ui/statusBar";

/** Services the command handlers depend on. */
export interface CommandDeps {
  cli: CliService;
  terminal: TerminalService;
  chat: ChatViewProvider;
  statusBar: StatusBar;
}

/** Registers all commands and returns the disposables for cleanup. */
export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { cli, terminal, chat, statusBar } = deps;

  /** Small helper to register and auto-dispose a command. */
  const on = (id: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  // --- Chat (headless) flows -------------------------------------------------
  on("antigravity.openChat", () => chat.focus());
  on("antigravity.newChat", () => chat.newChat());
  on("antigravity.stop", () => chat.stop());

  on("antigravity.ask", async () => {
    const text = await vscode.window.showInputBox({
      prompt: "Ask Antigravity",
      placeHolder: "e.g. Refactor this module to use async/await"
    });
    if (text) {
      chat.ask(text);
    }
  });

  on("antigravity.runGoal", async () => {
    const text = await vscode.window.showInputBox({
      prompt: "Describe a goal to run to completion",
      placeHolder: "e.g. Add unit tests for the parser and make them pass"
    });
    if (text) {
      chat.ask(text, { goal: true });
    }
  });

  on("antigravity.askWithSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage("Select some code first, then run “Ask About Selection”.");
      return;
    }
    const question = await vscode.window.showInputBox({
      prompt: "What should Antigravity do with the selection?",
      value: "Explain this code"
    });
    if (!question) {
      return;
    }
    chat.ask(buildSelectionPrompt(editor, question));
  });

  // --- Interactive terminal flows -------------------------------------------
  on("antigravity.startSession", () => terminal.startSession());
  on("antigravity.continueConversation", () => terminal.startSession({ continueConversation: true }));

  on("antigravity.resumeConversation", async () => {
    const id = await vscode.window.showInputBox({
      prompt: "Conversation id to resume",
      placeHolder: "Paste a previous conversation id"
    });
    if (id) {
      terminal.startSession({ conversationId: id.trim() });
    }
  });

  on("antigravity.addDirectory", async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: true,
      openLabel: "Add to agent workspace"
    });
    if (picked && picked.length > 0) {
      terminal.startSession({ addDirs: picked.map((u) => u.fsPath) });
    }
  });

  // --- Account & lifecycle ---------------------------------------------------
  on("antigravity.login", () => terminal.login());
  on("antigravity.logout", () => terminal.logout());
  on("antigravity.update", () => terminal.update());
  on("antigravity.installCli", () => terminal.install());

  on("antigravity.showVersion", async () => {
    const detection = await cli.detect();
    if (!detection.found) {
      const choice = await vscode.window.showWarningMessage(
        "Antigravity CLI not found.",
        "Install CLI"
      );
      if (choice) {
        terminal.install();
      }
      return;
    }
    void vscode.window.showInformationMessage(decideOnboarding(detection).message);
  });

  // --- Settings & model ------------------------------------------------------
  on("antigravity.openSettings", () =>
    vscode.commands.executeCommand("workbench.action.openSettings", "antigravity")
  );

  on("antigravity.selectModel", async () => {
    const current = cli.getConfig().model;
    const model = await vscode.window.showInputBox({
      prompt: "Model to pass to the agent (blank to use the CLI default)",
      value: current
    });
    if (model === undefined) {
      return;
    }
    await vscode.workspace
      .getConfiguration("antigravity")
      .update("model", model, vscode.ConfigurationTarget.Global);
    void statusBar.refresh();
    void chat.refreshState();
  });
}

/**
 * Wraps a code selection in a fenced block annotated with its language and
 * workspace-relative path, then appends the user's question. Giving the agent
 * the file context tends to produce far better answers than the snippet alone.
 */
function buildSelectionPrompt(editor: vscode.TextEditor, question: string): string {
  const doc = editor.document;
  const code = doc.getText(editor.selection);
  const lang = doc.languageId || "";
  const rel = vscode.workspace.asRelativePath(doc.uri);
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  const header = `From \`${path.basename(rel)}\` (lines ${start}-${end}):`;
  return `${header}\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n${question}`;
}
