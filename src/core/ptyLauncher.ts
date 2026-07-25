/**
 * Decides HOW to launch the interactive `agy` on a real PTY, per platform. Pure
 * (no `vscode`, no `child_process`, no native module) so the platform branching
 * and the exact argv / `stty` construction are unit-tested on bare Node. The
 * side-effecting spawn lives in [services/interactiveSession.ts].
 *
 * Why this exists: `agy`'s interactive TUI only renders on a real TTY. On
 * **Linux** we get one for free by running `agy` under util-linux `script` (a PTY
 * shim that ships with the OS), sizing it with `stty` before `exec agy`.
 * **macOS/BSD `script` cannot be used at all**: it calls `tcgetattr`/`TIOCGWINSZ`
 * on its own stdin and aborts unless that fails with `ENOTTY`. Node's piped stdio
 * is a socketpair, whose ioctls fail with `EOPNOTSUPP`, so it dies immediately
 * with `script: tcgetattr/ioctl: Operation not supported on socket` — and a
 * pipe/FIFO stdin fails the same way, so there is no stdin we can both write to
 * and hand to `script`. That instant exit is the macOS sign-in bug (#3): the auth
 * probe never saw a screen and reported "signed in" no matter what. macOS instead
 * uses `expect` (also part of the base system), which allocates the PTY itself and
 * does not care what its own stdio is. On **native Windows** neither exists, so we
 * need a ConPTY
 * from the prebuilt `@lydell/node-pty-win32-*` backend (Node-API, so it loads in
 * any Electron host without a rebuild); when that backend is missing we report it
 * plainly (see {@link missingPtyBackendMessage}) instead of crashing (#1, #2).
 * This module just says which plan applies; it never spawns anything.
 */

/** PTY geometry — wide to minimise wrapping; the emulator must match exactly. */
export interface PtyGeometry {
  cols: number;
  rows: number;
}

/**
 * How to launch `agy`:
 * - `script`  — Unix: spawn `command`/`args` as an ordinary piped child; the PTY
 *               is allocated by the shim itself (`script` on Linux, `expect` on
 *               macOS/BSD), and our stdin/stdout are its input/output.
 * - `conpty`  — Windows: spawn `command`/`args` directly on a `node-pty` ConPTY,
 *               sized via `cols`/`rows` (no shim).
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

/** Tcl double-quoted word: escapes the characters `expect` would substitute. */
export function tclQuote(s: string): string {
  return `"${s.replace(/[\\$"[\]]/g, (c) => `\\${c}`)}"`;
}

/**
 * The `expect` program used as the macOS/BSD PTY shim. `stty_init` sizes the PTY
 * *before* the spawn (`stty`'s job on Linux), `-noecho` keeps the command line
 * out of the stream the emulator parses, and `interact` wires our piped
 * stdin/stdout to the PTY until either side ends.
 *
 * The trailing `kill` is how a closed session is actually reaped: `agy` ignores
 * SIGHUP and `expect` puts it in its own session, so killing the shim alone
 * leaves it running forever. Closing our end of stdin returns from `interact`
 * and runs this line (see the `terminate` closure in services/interactiveSession).
 */
export function expectScript(agy: string, argv: string[], geo: PtyGeometry): string {
  return (
    `set stty_init "rows ${geo.rows} cols ${geo.cols}"\n` +
    `spawn -noecho ${[agy, ...argv].map(tclQuote).join(" ")}\n` +
    "set child [exp_pid]\n" +
    "interact\n" +
    "catch {exec kill -9 $child}\n"
  );
}

/**
 * Picks the launch plan for the current platform:
 *   - Windows ⇒ ConPTY. A `.cmd`/`.bat` shim (how npm-installed CLIs land on
 *     PATH) is not an executable image, so it is run through `cmd.exe /c`.
 *   - Linux ⇒ util-linux `script -q -e -c "<inner>" /dev/null`.
 *   - macOS/BSD ⇒ `expect -c "<script>"`, because BSD `script` refuses to run
 *     with piped stdio at all (#3, see the file header).
 */
export function planLaunch(
  platform: NodeJS.Platform,
  agy: string,
  argv: string[],
  geo: PtyGeometry
): LaunchPlan {
  if (isWindows(platform)) {
    const shim = /\.(cmd|bat)$/i.test(agy);
    const command = shim ? "cmd.exe" : agy;
    const args = shim ? ["/c", agy, ...argv] : argv;
    return { kind: "conpty", command, args, cols: geo.cols, rows: geo.rows };
  }
  if (platform === "linux") {
    const inner = scriptInnerCommand(agy, argv, geo);
    return { kind: "script", command: "script", args: ["-q", "-e", "-c", inner, "/dev/null"] };
  }
  return { kind: "script", command: "expect", args: ["-c", expectScript(agy, argv, geo)] };
}

/**
 * The message shown when the Windows ConPTY backend can't be loaded — used
 * instead of the old, misleading "agy isn't installed / you're not signed in"
 * (issues #1, #2). It names the real cause and the working fallback.
 */
export function missingPtyBackendMessage(): string {
  return (
    "Antigravity chat needs a pseudo-terminal to run the agy TUI, and this build " +
    "of the extension is missing the Windows ConPTY backend " +
    "(@lydell/node-pty-win32-*). Reinstall the latest extension release, or use " +
    "the CLI in the integrated terminal via “Antigravity: Toggle Session Terminal”."
  );
}
