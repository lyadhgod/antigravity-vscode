/**
 * Decides HOW to launch the interactive `agy` on a real PTY, per platform. Pure
 * (no `vscode`, no `child_process`, no native module) so the platform branching
 * and the exact argv / `stty` construction are unit-tested on bare Node. The
 * side-effecting spawn lives in [services/interactiveSession.ts].
 *
 * Why this exists: `agy`'s interactive TUI only renders on a real TTY. On
 * macOS/Linux we get one for free by running `agy` under `script` (a PTY shim
 * that ships with the OS), sizing it with `stty` before `exec agy`. On **native
 * Windows** neither `script` nor `stty` exists — the old code spawned `script`
 * anyway, which fails with `ENOENT` and surfaced as a misleading "agy isn't
 * installed" error (issues #1 and #2). Windows needs a ConPTY, obtained from the
 * optional `node-pty` backend; when that backend is unavailable we report it
 * plainly (see {@link missingPtyBackendMessage}) and point at WSL instead of
 * crashing. This module just says which plan applies; it never spawns anything.
 */

/** PTY geometry — wide to minimise wrapping; the emulator must match exactly. */
export interface PtyGeometry {
  cols: number;
  rows: number;
}

/**
 * How to launch `agy`:
 * - `script`  — Unix: spawn `command`/`args` (a `script -c "stty…; exec agy"`).
 * - `conpty`  — Windows: spawn `command`/`args` directly on a `node-pty` ConPTY,
 *               sized via `cols`/`rows` (no `script`/`stty`).
 */
export type LaunchPlan =
  | { kind: "script"; command: string; args: string[] }
  | { kind: "conpty"; command: string; args: string[]; cols: number; rows: number };

const isWindows = (platform: NodeJS.Platform): boolean => platform === "win32";

/** POSIX single-quote for embedding a word in the `script -c` inner command. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The inner `stty <size>; exec agy …` command handed to `script -c` on Unix.
 * `script` gives a 0×0 PTY when its stdio is piped, so we size it with `stty`
 * before `exec`-ing `agy` (which replaces the shell, so no extra process lingers).
 */
export function scriptInnerCommand(agy: string, argv: string[], geo: PtyGeometry): string {
  return (
    `stty rows ${geo.rows} cols ${geo.cols} 2>/dev/null; exec ` +
    [agy, ...argv].map(shQuote).join(" ")
  );
}

/**
 * Picks the launch plan for the current platform. Windows ⇒ ConPTY (node-pty);
 * everything else ⇒ the `script` PTY shim with an `stty`-sized inner command.
 */
export function planLaunch(
  platform: NodeJS.Platform,
  agy: string,
  argv: string[],
  geo: PtyGeometry
): LaunchPlan {
  if (isWindows(platform)) {
    return { kind: "conpty", command: agy, args: argv, cols: geo.cols, rows: geo.rows };
  }
  const inner = scriptInnerCommand(agy, argv, geo);
  return { kind: "script", command: "script", args: ["-q", "-e", "-c", inner, "/dev/null"] };
}

/**
 * The message shown when the Windows ConPTY backend (`node-pty`) can't be
 * loaded — used instead of the old, misleading "agy isn't installed / you're not
 * signed in" (issues #1, #2). It names the real cause and the working fallback.
 */
export function missingPtyBackendMessage(): string {
  return (
    "Antigravity chat needs a pseudo-terminal to run the agy TUI, and native " +
    "Windows requires the node-pty backend, which isn't available in this build. " +
    "Run VS Code connected to WSL (where agy works today), or use the CLI in the " +
    "integrated terminal via “Antigravity: Toggle Session Terminal”."
  );
}
