import * as assert from "node:assert";
import * as path from "node:path";

import { JsonStreamParser } from "../../src/core/jsonStream";
import { runProcess } from "../../src/core/processRunner";
import { AgyEvent } from "../../src/core/types";

// Absolute path to the stub CLI (mocha runs from the repo root).
const STUB = path.join(process.cwd(), "test", "fixtures", "agy-stub.js");
const NODE = process.execPath;

describe("processRunner (integration, against the stub CLI)", () => {
  it("captures stdout from a clean run", async () => {
    const { result } = runProcess(NODE, [STUB, "--version"]);
    const res = await result;
    assert.strictEqual(res.code, 0);
    assert.ok(res.stdout.includes("1.4.2"));
    assert.strictEqual(res.spawnError, undefined);
  });

  it("streams chunks and the JSON parser yields normalized events end-to-end", async () => {
    const parser = new JsonStreamParser();
    const events: AgyEvent[] = [];
    let chunkCount = 0;

    const { result } = runProcess(
      NODE,
      [STUB, "--print", "--output-format", "json", "do something"],
      {
        onStdout: (chunk) => {
          chunkCount += 1;
          events.push(...parser.push(chunk));
        }
      }
    );
    const res = await result;
    events.push(...parser.flush());

    assert.strictEqual(res.code, 0);
    assert.ok(chunkCount > 0, "expected streaming callbacks to fire");

    // Text deltas, a tool event, and a final result should all be present.
    assert.ok(events.some((e) => e.kind === "text" && e.text === "Hello "));
    assert.ok(events.some((e) => e.kind === "tool" && e.name === "read_file"));
    const result_ = events.find((e) => e.kind === "result");
    assert.ok(result_ && result_.kind === "result");
    assert.strictEqual(result_.conversationId, "conv-abc123");
    assert.strictEqual(result_.usage?.totalTokens, 19);
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
    // A child that would sleep far longer than the timeout.
    const { result } = runProcess(NODE, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 200 });
    const res = await result;
    assert.strictEqual(res.timedOut, true);
  });

  it("can be cancelled", async () => {
    const handle = runProcess(NODE, ["-e", "setTimeout(() => {}, 10000)"]);
    handle.cancel();
    const res = await handle.result;
    // Either a signal or a non-zero/null code — the key point is it settled.
    assert.notStrictEqual(res.signal, undefined);
  });
});
