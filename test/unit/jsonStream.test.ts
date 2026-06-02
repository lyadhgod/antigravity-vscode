import * as assert from "node:assert";

import { JsonStreamParser, normalizeEvent, parseWhole } from "../../src/core/jsonStream";

describe("jsonStream.normalizeEvent", () => {
  it("recognizes assistant text under several field names", () => {
    assert.deepStrictEqual(normalizeEvent({ type: "text", text: "hi" }), { kind: "text", text: "hi" });
    assert.deepStrictEqual(normalizeEvent({ delta: "more" }), { kind: "text", text: "more" });
  });

  it("extracts text from nested message.content arrays", () => {
    const ev = normalizeEvent({ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } });
    assert.deepStrictEqual(ev, { kind: "text", text: "ab" });
  });

  it("maps result objects with conversation id and usage", () => {
    const ev = normalizeEvent({
      type: "result",
      result: "done",
      conversation_id: "c-9",
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }
    });
    assert.deepStrictEqual(ev, {
      kind: "result",
      text: "done",
      isError: false,
      conversationId: "c-9",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }
    });
  });

  it("maps tool activity", () => {
    assert.deepStrictEqual(normalizeEvent({ type: "tool_use", name: "read", path: "a.ts" }), {
      kind: "tool",
      name: "read",
      detail: "a.ts"
    });
  });

  it("maps errors and prioritizes them", () => {
    assert.deepStrictEqual(normalizeEvent({ error: "nope" }), { kind: "error", message: "nope" });
  });

  it("returns null for objects with no renderable signal", () => {
    assert.strictEqual(normalizeEvent({ irrelevant: true }), null);
    assert.strictEqual(normalizeEvent("not an object"), null);
  });
});

describe("jsonStream.JsonStreamParser", () => {
  it("emits events only for complete lines and buffers partials", () => {
    const p = new JsonStreamParser();
    const first = p.push('{"text":"a"}\n{"text":"b"');
    assert.deepStrictEqual(first, [{ kind: "text", text: "a" }]);
    // Second object was incomplete; completing it now yields it.
    const second = p.push('}\n');
    assert.deepStrictEqual(second, [{ kind: "text", text: "b" }]);
  });

  it("preserves non-JSON lines as raw passthrough", () => {
    const p = new JsonStreamParser();
    assert.deepStrictEqual(p.push("warning: low memory\n"), [{ kind: "raw", line: "warning: low memory" }]);
  });

  it("flushes a trailing unterminated line", () => {
    const p = new JsonStreamParser();
    assert.deepStrictEqual(p.push('{"text":"tail"}'), []);
    assert.deepStrictEqual(p.flush(), [{ kind: "text", text: "tail" }]);
  });

  it("tolerates malformed JSON without throwing", () => {
    const p = new JsonStreamParser();
    assert.deepStrictEqual(p.push("{not valid json}\n"), [{ kind: "raw", line: "{not valid json}" }]);
  });
});

describe("jsonStream.parseWhole", () => {
  it("parses a single JSON object", () => {
    assert.deepStrictEqual(parseWhole('{"result":"ok"}'), [
      { kind: "result", text: "ok", isError: false, conversationId: undefined, usage: undefined }
    ]);
  });

  it("parses a JSON array of events", () => {
    assert.deepStrictEqual(parseWhole('[{"text":"a"},{"text":"b"}]'), [
      { kind: "text", text: "a" },
      { kind: "text", text: "b" }
    ]);
  });

  it("parses NDJSON and ignores blank lines", () => {
    const out = parseWhole('{"text":"a"}\n\n{"text":"b"}\n');
    assert.deepStrictEqual(out, [
      { kind: "text", text: "a" },
      { kind: "text", text: "b" }
    ]);
  });

  it("returns nothing for empty input", () => {
    assert.deepStrictEqual(parseWhole("   \n  "), []);
  });
});
