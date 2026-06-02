/**
 * The bridge between VS Code and the pure core. It reads `antigravity.*`
 * settings and open folders, resolves the binary, runs headless prompts while
 * streaming normalized events, and probes the CLI for detection/onboarding.
 *
 * All `vscode`- and `fs`-specific concerns live here; the heavy logic is
 * delegated to `core/*` so it stays unit-testable.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { buildPrintArgs, buildVersionArgs } from "../core/argBuilder";
import { ResolverEnv, resolveBinary } from "../core/binaryResolver";
import { JsonStreamParser, parseWhole } from "../core/jsonStream";
import { looksLikeLoginError, parseVersion } from "../core/onboarding";
import { runProcess } from "../core/processRunner";
import { AgyEvent, AntigravityConfig, DetectionResult, PrintOptions } from "../core/types";

/** Callbacks a caller (the chat view) supplies to observe a running prompt. */
export interface PromptObserver {
  /** Each normalized event as it is parsed from the stream. */
  onEvent: (event: AgyEvent) => void;
  /** Resolves when the process exits; `ok` reflects a zero exit code. */
  onDone: (summary: { ok: boolean; timedOut: boolean; loginError: boolean }) => void;
}

/** Handle for an in-flight prompt so the UI can cancel it. */
export interface PromptHandle {
  cancel(): void;
}

export class CliService {
  /** Reads the live `antigravity.*` configuration into a plain object. */
  getConfig(): AntigravityConfig {
    const c = vscode.workspace.getConfiguration("antigravity");
    return {
      cliPath: c.get<string>("cliPath", "agy"),
      model: c.get<string>("model", ""),
      extraArgs: c.get<string[]>("extraArgs", []),
      skipPermissions: c.get<boolean>("skipPermissions", false),
      printTimeoutMs: c.get<number>("printTimeoutMs", 600000),
      autoAddWorkspaceFolders: c.get<boolean>("autoAddWorkspaceFolders", true),
      outputFormat: c.get<"json" | "text">("outputFormat", "json"),
      installCommand: c.get<string>(
        "installCommand",
        "curl -fsSL https://antigravity.google/cli/install.sh | bash"
      )
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

  /** Folders to expose to the agent, honoring the auto-add setting. */
  private addDirs(explicit?: string[]): string[] {
    if (explicit && explicit.length > 0) {
      return explicit;
    }
    return this.getConfig().autoAddWorkspaceFolders ? this.getWorkspaceDirs() : [];
  }

  /**
   * Probes the environment by running `agy --version`. A spawn error means the
   * binary is missing (drives the "install" onboarding path); a clean run
   * yields the version. Login state is left `undefined` here because
   * `--version` does not require auth — it is inferred later from prompt output.
   */
  async detect(): Promise<DetectionResult> {
    const command = this.resolveCommand();
    const { result } = runProcess(command, buildVersionArgs(), {
      cwd: this.cwd(),
      timeoutMs: 15000
    });
    const res = await result;

    if (res.spawnError) {
      return { command, found: false };
    }
    const version = parseVersion(res.stdout || res.stderr);
    return { command, found: true, version };
  }

  /**
   * Runs a headless prompt, streaming normalized events to `observer`. Returns
   * a handle for cancellation. Never throws: spawn/login/timeout failures are
   * reported through `observer.onEvent`/`observer.onDone`.
   */
  runPrint(options: PromptOptionsInput, observer: PromptObserver): PromptHandle {
    const config = this.getConfig();
    const printOptions: PrintOptions = {
      prompt: options.prompt,
      addDirs: this.addDirs(options.addDirs),
      conversationId: options.conversationId,
      continueConversation: options.continueConversation,
      model: options.model,
      goal: options.goal
    };
    const command = this.resolveCommand();
    const args = buildPrintArgs(printOptions, config);
    const parser = new JsonStreamParser();
    const json = config.outputFormat === "json";

    // Count emitted events so we can fall back to whole-buffer parsing if the
    // line-oriented stream yielded nothing (e.g. a single multi-line JSON blob).
    let emitted = 0;
    const emit = (event: AgyEvent) => {
      emitted += 1;
      observer.onEvent(event);
    };

    const { result, cancel } = runProcess(command, args, {
      cwd: this.cwd(),
      timeoutMs: config.printTimeoutMs,
      // In text mode there is no JSON to parse; stream raw lines straight through.
      onStdout: (chunk) => {
        if (json) {
          parser.push(chunk).forEach(emit);
        } else {
          emit({ kind: "text", text: chunk });
        }
      }
    });

    result.then((res) => {
      if (json) {
        parser.flush().forEach(emit);
        // Robustness net: a well-formed but non-line-delimited payload.
        if (emitted === 0 && !res.spawnError && res.stdout.trim()) {
          parseWhole(res.stdout).forEach(emit);
        }
      }
      if (res.spawnError) {
        emit({
          kind: "error",
          message: `Could not run “${command}”. Is the Antigravity CLI installed and on your PATH?`
        });
      } else if (res.stderr.trim()) {
        emit({ kind: "raw", line: res.stderr.trim() });
      }
      observer.onDone({
        ok: res.code === 0 && !res.spawnError,
        timedOut: res.timedOut,
        loginError: looksLikeLoginError(res.stdout + "\n" + res.stderr)
      });
    });

    return { cancel };
  }
}

/** Loosened prompt options accepted from the UI (folders filled in by the service). */
export interface PromptOptionsInput {
  prompt: string;
  addDirs?: string[];
  conversationId?: string;
  continueConversation?: boolean;
  model?: string;
  goal?: boolean;
}
