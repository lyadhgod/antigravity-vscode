import * as assert from "node:assert";
import { spawn } from "node:child_process";

import { planLaunch } from "../../src/core/ptyLauncher";

/**
 * Runs the launch plan this host would really use, with a small shell script
 * standing in for `agy`, spawned exactly the way the extension spawns it (piped
 * stdio). It asserts both halves of what the TUI needs:
 *   - `stty size` prints 40x120, i.e. the child really is on a correctly sized PTY;
 *   - a line written to the child's stdin comes back, i.e. keystrokes reach it.
 * Either half failing is the macOS bug (#3): BSD `script` aborts outright on
 * piped stdin, and the chat then blamed the sign-in state.
 */
describe("ptyLauncher (integration, spawns the real PTY shim on this host)", function () {
  it("puts the command on a real 40x120 PTY that accepts input", async function () {
    if (process.platform === "win32") {
      this.skip(); // ConPTY path — covered by the unit test + a real Windows run.
    }
    this.timeout(15000);
    const plan = planLaunch(
      process.platform,
      "/bin/sh",
      ["-c", "stty size; read line; echo GOT:$line"],
      { cols: 120, rows: 40 }
    );
    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn(plan.command, plan.args);
      let out = "";
      proc.stdout.on("data", (b: Buffer) => (out += b.toString()));
      proc.stderr.on("data", (b: Buffer) => (out += b.toString()));
      proc.on("error", reject);
      proc.on("close", () => resolve(out));
      setTimeout(() => proc.stdin.write("ping\r"), 500);
      setTimeout(() => proc.kill("SIGKILL"), 10000);
    });
    assert.match(output, /40 120/, `expected a 40x120 PTY, got: ${output}`);
    assert.match(output, /GOT:ping/, `expected stdin to reach the child, got: ${output}`);
  });
});
