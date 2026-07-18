/**
 * The bridge between VS Code and the pure core. It reads `antigravity.*`
 * settings and open folders, resolves the binary, checks sign-in state, and
 * probes the CLI for detection/onboarding.
 *
 * Chat itself no longer goes through here: it runs an interactive `agy` per
 * session via [services/interactiveSession.ts]. This service now covers the
 * environment-facing concerns (binary, config, auth, version).
 *
 * All `vscode`- and `fs`-specific concerns live here; the heavy logic is in
 * `core/*` so it stays unit-testable.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { buildVersionArgs } from "../core/argBuilder";
import { ResolverEnv, resolveBinary } from "../core/binaryResolver";
import { oauthTokenPath, parseVersion } from "../core/onboarding";
import { runProcess } from "../core/processRunner";
import { AntigravityConfig, DetectionResult } from "../core/types";

export class CliService {
  /** Reads the live `antigravity.*` configuration into a plain object. */
  getConfig(): AntigravityConfig {
    const c = vscode.workspace.getConfiguration("antigravity");
    return {
      cliPath: c.get<string>("cliPath", "agy"),
      extraArgs: c.get<string[]>("extraArgs", []),
      skipPermissions: c.get<boolean>("skipPermissions", false),
      sandbox: c.get<boolean>("sandbox", false),
      autoAddWorkspaceFolders: c.get<boolean>("autoAddWorkspaceFolders", true)
    };
  }

  /** Absolute paths of open workspace folders, used for `--add-dir`. */
  getWorkspaceDirs(): string[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === "file")
      .map((f) => f.uri.fsPath);
  }

  /** Builds the injectable environment view the binary resolver needs. */
  private resolverEnv(): ResolverEnv {
    return {
      platform: process.platform,
      env: process.env,
      join: path.join,
      fileExists: (candidate) => {
        try {
          return fs.statSync(candidate).isFile();
        } catch {
          return false;
        }
      }
    };
  }

  /** The concrete command/path that will be spawned for the CLI. */
  resolveCommand(): string {
    return resolveBinary(this.getConfig().cliPath, this.resolverEnv());
  }

  /** Primary working directory for spawned processes (first folder, else cwd). */
  private cwd(): string | undefined {
    return this.getWorkspaceDirs()[0];
  }

  /**
   * Best-effort sign-in check: older CLIs cache an OAuth token on disk after the
   * Google sign-in flow, so a non-empty token file means "signed in" — a fast,
   * reliable *positive*. It is NOT a reliable *negative*, though: newer CLIs keep
   * the credential in the OS keychain (macOS Keychain) and a sign-in done in the
   * terminal leaves no file we can read, so an authenticated user can still read
   * as "signed out" (issues #3, #5). That is why the gate never hard-blocks on
   * this result — the webview always offers "Continue anyway", and the live
   * interactive session (which detects `state === "signin"`) is the real source
   * of truth once a chat starts.
   */
  isAuthenticated(): boolean {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    if (!home) {
      return false;
    }
    try {
      return fs.statSync(oauthTokenPath(home, path.join)).size > 0;
    } catch {
      return false;
    }
  }

  /**
   * Probes the environment: runs `agy --version` to confirm the binary exists,
   * and checks the OAuth token for sign-in state.
   */
  async detect(): Promise<DetectionResult> {
    const command = this.resolveCommand();
    const { result } = runProcess(command, buildVersionArgs(), { cwd: this.cwd(), timeoutMs: 15000 });
    const res = await result;

    if (res.spawnError) {
      return { command, found: false, authenticated: false };
    }
    return {
      command,
      found: true,
      version: parseVersion(res.stdout || res.stderr),
      authenticated: this.isAuthenticated()
    };
  }
}

