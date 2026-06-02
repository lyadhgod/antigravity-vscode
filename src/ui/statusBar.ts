/**
 * A status-bar entry that reflects CLI availability at a glance and offers a
 * one-click path to the chat panel. It re-probes on demand (after install /
 * config changes) via {@link refresh}.
 */
import * as vscode from "vscode";

import { decideOnboarding } from "../core/onboarding";
import { CliService } from "../services/cliService";

export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly cli: CliService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    // Clicking opens the chat; the icon/text communicate readiness.
    this.item.command = "antigravity.openChat";
    this.item.show();
    this.setReady(false);
  }

  /** Re-detects the CLI and updates the label/tooltip accordingly. */
  async refresh(): Promise<void> {
    this.item.text = "$(loading~spin) Antigravity";
    const detection = await this.cli.detect();
    const decision = decideOnboarding(detection);
    this.setReady(decision.canRun, decision.message);
  }

  /** Applies the visual ready/attention state. */
  private setReady(ready: boolean, tooltip?: string): void {
    this.item.text = ready ? "$(rocket) Antigravity" : "$(rocket) Antigravity $(warning)";
    this.item.tooltip = tooltip ?? "Antigravity — open chat";
    this.item.backgroundColor = ready
      ? undefined
      : new vscode.ThemeColor("statusBarItem.warningBackground");
  }

  dispose(): void {
    this.item.dispose();
  }
}
