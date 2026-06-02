/**
 * A thin, promise-based wrapper around `child_process.spawn` tailored to how
 * this extension drives `agy`: always with an explicit argv (never a shell
 * string, so prompts can't trigger shell injection), with optional streaming
 * callbacks, a hard timeout, and cooperative cancellation.
 *
 * It lives in `core` because it imports only Node built-ins — that lets the
 * test suite exercise it against the stub CLI without loading `vscode`.
 */
import { spawn } from "node:child_process";

/** Options controlling a single process run. */
export interface RunOptions {
  /** Working directory for the child (defaults to the parent's). */
  cwd?: string;
  /** Environment for the child (defaults to the parent's). */
  env?: NodeJS.ProcessEnv;
  /** Hard timeout in ms; the child is killed and `timedOut` is set when hit. */
  timeoutMs?: number;
  /** Data written to the child's stdin, then stdin is closed. */
  input?: string;
  /** Called for each decoded stdout chunk (for live streaming to the UI). */
  onStdout?: (chunk: string) => void;
  /** Called for each decoded stderr chunk. */
  onStderr?: (chunk: string) => void;
}

/** Everything known about a finished (or failed-to-start) process. */
export interface RunResult {
  /** Exit code, or `null` if the process was signaled. */
  code: number | null;
  /** Terminating signal, if any. */
  signal: NodeJS.Signals | null;
  /** Full captured stdout. */
  stdout: string;
  /** Full captured stderr. */
  stderr: string;
  /** True when the run was aborted by the timeout. */
  timedOut: boolean;
  /** Set when the process could not be spawned (e.g. ENOENT: missing binary). */
  spawnError?: NodeJS.ErrnoException;
}

/** A running process: await `result`, or `cancel()` to terminate early. */
export interface RunHandle {
  result: Promise<RunResult>;
  cancel(): void;
}

/**
 * Spawns `command` with `args`. Never rejects: failures to start (missing
 * binary, permission denied) resolve with {@link RunResult.spawnError} so
 * callers can branch on a single result object instead of mixing try/catch
 * with normal flow.
 */
export function runProcess(command: string, args: string[], options: RunOptions = {}): RunHandle {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    // Pipe all three streams; we manage stdin/stdout/stderr ourselves.
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;

  const result = new Promise<RunResult>((resolve) => {
    const finish = (partial: Omit<RunResult, "stdout" | "stderr" | "timedOut">) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({ ...partial, stdout, stderr, timedOut });
    };

    // Arm the timeout, if requested.
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // Escalate if the child ignores SIGTERM.
          setTimeout(() => child.kill("SIGKILL"), 2000).unref();
        }, options.timeoutMs)
      : undefined;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });

    // `error` fires when the process cannot be spawned at all.
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ code: null, signal: null, spawnError: err });
    });

    child.on("close", (code, signal) => {
      finish({ code, signal });
    });

    // Feed stdin if provided, then close it so the child can proceed.
    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    } else {
      child.stdin?.end();
    }
  });

  return {
    result,
    cancel: () => {
      if (!settled) {
        child.kill("SIGTERM");
      }
    }
  };
}
