import * as assert from "node:assert";
import * as path from "node:path";

import { runProcess } from "../../src/core/processRunner";

// Absolute path to the stub CLI (mocha runs from the repo root).
const STUB = path.join(process.cwd(), "test", "fixtures", "agy-stub.js");
const NODE = process.execPath;

describe("processRunner (integration, against the stub CLI)", () => {
  it("captures stdout from a clean version run", async () => {
    const { result } = runProcess(NODE, [STUB, "--version"]);
    const res = await result;
    assert.strictEqual(res.code, 0);
    assert.ok(res.stdout.includes("1.0.4"));
    assert.strictEqual(res.spawnError, undefined);
  });

  it("streams plain-text chunks for a headless prompt", async () => {
    let streamed = "";
    let chunkCount = 0;
    const { result } = runProcess(NODE, [STUB, "--print", "--print-timeout", "10m", "do something"], {
      onStdout: (chunk) => {
        chunkCount += 1;
        streamed += chunk;
      }
    });
    const res = await result;
    assert.strictEqual(res.code, 0);
    assert.ok(chunkCount > 0, "expected streaming callbacks to fire");
    assert.strictEqual(streamed.trim(), "Hello from the agent.");
  });

  it("reports a non-zero exit with stderr for a login failure", async () => {
    const { result } = runProcess(NODE, [STUB, "--print", "please LOGIN"]);
    const res = await result;
    assert.strictEqual(res.code, 1);
    assert.ok(res.stderr.toLowerCase().includes("not logged in"));
  });

  it("surfaces a spawn error for a missing binary rather than throwing", async () => {
    const { result } = runProcess("this-binary-does-not-exist-xyz", ["--version"]);
    const res = await result;
    assert.ok(res.spawnError, "expected a spawnError");
    assert.strictEqual(res.spawnError?.code, "ENOENT");
  });

  it("enforces the timeout and reports timedOut", async () => {
    const { result } = runProcess(NODE, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    const res = await result;
    assert.strictEqual(res.timedOut, true);
  });

  it("can be cancelled", async () => {
    const handle = runProcess(NODE, ["-e", "setTimeout(() => {}, 10000)"]);
    handle.cancel();
    const res = await handle.result;
    assert.notStrictEqual(res.signal, undefined);
  });
});
