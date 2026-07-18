/**
 * Registers every `antigravity.*` command and maps it onto the right service,
 * covering the full CLI surface: chat (headless), interactive sessions, account
 * (sign in/out), and CLI lifecycle (install, update, changelog, plugins).
 */
import * as path from "node:path";
import * as vscode from "vscode";

import { decideOnboarding } from "../core/onboarding";
import { CliService } from "../services/cliService";
import { TerminalService } from "../services/terminalService";
import { ChatViewProvider } from "../ui/chatViewProvider";

/** Services the command handlers depend on. */
export interface CommandDeps {
  cli: CliService;
  terminal: TerminalService;
  chat: ChatViewProvider;
}

/** Registers all commands; disposables are pushed onto the context. */
export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { cli, terminal, chat } = deps;
  const on = (id: string, handler: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  // --- Chat (headless) -------------------------------------------------------
  on("antigravity.openChat", () => chat.focus());
  on("antigravity.newChat", () => chat.newSession());
  on("antigravity.stop", () => chat.stop());
  on("antigravity.insertSlashCommand", () => chat.openSlashNavigator());

  on("antigravity.ask", async () => {
    const text = await vscode.window.showInputBox({
      prompt: "Ask Antigravity",
      placeHolder: "e.g. Refactor this module to use async/await"
    });
    if (text) {
      chat.ask(text);
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
    if (question) {
      chat.ask(buildSelectionPrompt(editor, question));
    }
  });

  // --- Interactive sessions --------------------------------------------------
  // The title-bar terminal button toggles a terminal mirroring the *active*
  // chat session's live process (#4): open if hidden, close if already showing.
  on("antigravity.startSession", () => chat.toggleActiveSessionTerminal());

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

  // --- Account ---------------------------------------------------------------
  on("antigravity.login", () => {
    chat.focus();
    chat.startLogin();
  });
  on("antigravity.logout", () => {
    terminal.logout();
    void chat.refreshState();
  });

  // --- CLI lifecycle ---------------------------------------------------------
  on("antigravity.update", () => terminal.update());
  on("antigravity.showChangelog", () => terminal.changelog());

  on("antigravity.managePlugins", async () => {
    const action = await vscode.window.showQuickPick(
      [
        { label: "List plugins", args: ["list"] },
        { label: "Import from Gemini", args: ["import", "gemini"] },
        { label: "Import from Claude", args: ["import", "claude"] },
        { label: "Install plugin…", args: ["install"] },
        { label: "Uninstall plugin…", args: ["uninstall"] },
        { label: "Enable plugin…", args: ["enable"] },
        { label: "Disable plugin…", args: ["disable"] }
      ],
      { placeHolder: "Plugin action" }
    );
    if (!action) {
      return;
    }
    // Install/uninstall/enable/disable need a target name.
    if (["install", "uninstall", "enable", "disable"].includes(action.args[0]) && action.args.length === 1) {
      const target = await vscode.window.showInputBox({
        prompt: `Plugin name/target to ${action.args[0]}`,
        placeHolder: action.args[0] === "install" ? "name@marketplace" : "plugin-name"
      });
      if (!target) {
        return;
      }
      action.args.push(target.trim());
    }
    terminal.runPluginCommand(action.args);
  });

  on("antigravity.showVersion", async () => {
    const detection = await cli.detect();
    void vscode.window.showInformationMessage(decideOnboarding(detection).message);
  });

  // --- Settings --------------------------------------------------------------
  on("antigravity.openSettings", () =>
    vscode.commands.executeCommand("workbench.action.openSettings", "antigravity")
  );
}

/**
 * Wraps a code selection in a fenced block annotated with its language and
 * workspace-relative path, then appends the user's question — far better
 * context for the agent than the snippet alone.
 */
function buildSelectionPrompt(editor: vscode.TextEditor, question: string): string {
  const doc = editor.document;
  const code = doc.getText(editor.selection);
  const lang = doc.languageId || "";
  const rel = vscode.workspace.asRelativePath(doc.uri);
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  return `From \`${path.basename(rel)}\` (lines ${start}-${end}):\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n${question}`;
}
