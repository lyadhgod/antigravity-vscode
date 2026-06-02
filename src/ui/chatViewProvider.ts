/**
 * Hosts the Material 3 Expressive chat panel as a `WebviewViewProvider` in the
 * Antigravity activity-bar container.
 *
 * Responsibilities:
 *   - build a locked-down webview (CSP + nonce, local resources only — required
 *     because the firewalled environment forbids any CDN/remote assets);
 *   - translate user actions from the webview into {@link CliService} calls;
 *   - stream normalized agent events back to the webview for rendering;
 *   - keep a conversation thread alive across turns via the CLI's
 *     `--conversation <id>` continuity.
 *
 * Heavy text rendering (markdown, code blocks) and all styling live in
 * `media/*`; this file is the typed controller around it.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";

import { decideOnboarding } from "../core/onboarding";
import { CliService, PromptHandle } from "../services/cliService";
import { ChatState, HostToWebview, WebviewToHost } from "./protocol";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  /** Must match the `views` id contributed in package.json. */
  public static readonly viewId = "antigravity.chatView";

  private view?: vscode.WebviewView;
  /** The in-flight prompt, if any, so we can cancel it. */
  private active?: PromptHandle;
  /** Conversation id captured from the CLI to thread follow-up turns. */
  private conversationId?: string;
  /** True once at least one turn has been sent in this chat. */
  private hasTurn = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly cli: CliService
  ) {}

  /** Called by VS Code when the view becomes visible. */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    // Route messages coming from the webview script.
    webviewView.webview.onDidReceiveMessage((msg: WebviewToHost) => this.onMessage(msg));
  }

  // --- Public API used by commands -----------------------------------------

  /** Reveals the chat panel (focuses the view container). */
  focus(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      void vscode.commands.executeCommand("antigravity.chatView.focus");
    }
  }

  /**
   * Sends a prompt programmatically (e.g. from the "Ask…" command or an editor
   * selection) and reveals the panel so the user sees the streamed reply.
   */
  ask(text: string, options: { goal?: boolean } = {}): void {
    this.focus();
    this.submit(text, options.goal ?? false);
  }

  /** Resets the conversation thread and clears the transcript. */
  newChat(): void {
    this.active?.cancel();
    this.active = undefined;
    this.conversationId = undefined;
    this.hasTurn = false;
    this.post({ type: "clear" });
    void this.refreshState();
  }

  /** Cancels any running prompt. */
  stop(): void {
    this.active?.cancel();
  }

  /** Re-probes the CLI and pushes the latest readiness state to the webview. */
  async refreshState(): Promise<void> {
    const detection = await this.cli.detect();
    const decision = decideOnboarding(detection);
    const config = this.cli.getConfig();
    const state: ChatState = {
      ready: decision.canRun,
      action: decision.action,
      message: decision.message,
      model: config.model || "default",
      version: detection.version
    };
    this.post({ type: "state", state });
  }

  // --- Message handling -----------------------------------------------------

  private onMessage(msg: WebviewToHost): void {
    switch (msg.type) {
      case "ready":
        void this.refreshState();
        break;
      case "submit":
        this.submit(msg.text, msg.goal);
        break;
      case "cancel":
        this.stop();
        break;
      case "newChat":
        this.newChat();
        break;
      case "command":
        // Whitelisted passthrough to extension commands (settings, login, …).
        void vscode.commands.executeCommand(msg.id);
        break;
    }
  }

  /**
   * Runs a single headless turn, echoing the user's message, streaming events,
   * and threading the conversation id so follow-ups share context.
   */
  private submit(text: string, goal: boolean): void {
    const prompt = text.trim();
    if (!prompt || this.active) {
      return; // ignore empties and double-submits while busy
    }
    this.post({ type: "userMessage", text: prompt });
    this.post({ type: "busy", value: true });

    this.active = this.cli.runPrint(
      {
        prompt,
        goal,
        conversationId: this.conversationId,
        continueConversation: this.conversationId === undefined && this.hasTurn
      },
      {
        onEvent: (event) => {
          if (event.kind === "result" && event.conversationId) {
            this.conversationId = event.conversationId; // remember the thread
          }
          this.post({ type: "event", event });
        },
        onDone: ({ ok, timedOut, loginError }) => {
          this.active = undefined;
          this.hasTurn = true;
          this.post({ type: "busy", value: false });
          this.post({ type: "done", ok, timedOut });
          if (loginError) {
            // Surface a first-class sign-in path rather than a raw 401.
            void vscode.window
              .showWarningMessage("Antigravity needs you to sign in.", "Sign In")
              .then((choice) => choice && vscode.commands.executeCommand("antigravity.login"));
          }
        }
      }
    );
  }

  // --- Rendering ------------------------------------------------------------

  /** Posts a typed message to the webview if it is alive. */
  private post(message: HostToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  /**
   * Loads the HTML shell and injects a per-load nonce, the CSP, and
   * webview-safe URIs for the local script/style. Inlining the nonce is the
   * standard VS Code pattern for allowing exactly one trusted script.
   */
  private renderHtml(webview: vscode.Webview): string {
    const mediaUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", file)).toString();
    const templatePath = vscode.Uri.joinPath(this.extensionUri, "media", "index.html").fsPath;
    const nonce = crypto.randomBytes(16).toString("base64");

    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} https: data:`
    ].join("; ");

    return fs
      .readFileSync(templatePath, "utf8")
      .replace(/{{csp}}/g, csp)
      .replace(/{{nonce}}/g, nonce)
      .replace(/{{styleUri}}/g, mediaUri("main.css"))
      .replace(/{{scriptUri}}/g, mediaUri("main.js"));
  }
}
