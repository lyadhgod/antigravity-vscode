import * as assert from "node:assert";

import { MAX_PROMPT_LENGTH, sanitizePromptText } from "../../src/core/inputSanitizer";

describe("inputSanitizer.sanitizePromptText", () => {
  it("leaves ordinary prose untouched", () => {
    assert.strictEqual(sanitizePromptText("refactor the parser, please"), "refactor the parser, please");
  });

  it("keeps CJK, emoji, combining marks and RTL text verbatim (#8)", () => {
    for (const text of ["你好，请用一句话介绍你自己", "テストする", "안녕하세요", "👩‍💻", "café", "مرحبا"]) {
      assert.strictEqual(sanitizePromptText(text), text);
    }
  });

  it("folds every line break — CR/LF, VT/FF, NEL/LS/PS — and tab into one space", () => {
    // Each of these would otherwise end the line the CLI is reading, splitting
    // one prompt into two submissions.
    assert.strictEqual(sanitizePromptText("a\r\nb"), "a b");
    assert.strictEqual(sanitizePromptText("a\nb\rc"), "a b c");
    assert.strictEqual(sanitizePromptText("a\u000Bb\u000Cc"), "a b c");
    assert.strictEqual(sanitizePromptText("a\u0085b\u2028c\u2029d"), "a b c d");
    assert.strictEqual(sanitizePromptText("a\tb"), "a b");
  });

  it("removes the control bytes that wedged a live session (verified against agy 1.1.11)", () => {
    // Ctrl+Z is how this extension ends a session; sent mid-prompt it suspended
    // the CLI and the submitting Enter then did nothing.
    assert.strictEqual(sanitizePromptText("what is 2+2\u001A ignore me"), "what is 2+2 ignore me");
    // The bracketed-paste introducer put the input box into a state that ate Enter.
    assert.strictEqual(sanitizePromptText("tell me a joke\u001B[200~x"), "tell me a joke[200~x");
  });

  it("removes the rest of the control space: C0, DEL and C1", () => {
    assert.strictEqual(sanitizePromptText("a\u0000b\u0003c\u007Fd\u009Be"), "abcde");
  });

  it("removes bidi overrides/isolates but keeps the plain RTL marks", () => {
    // Trojan Source: these reorder the display without changing the characters.
    assert.strictEqual(sanitizePromptText("ok\u202Edrowssap\u202C"), "okdrowssap");
    assert.strictEqual(sanitizePromptText("a\u2066b\u2069c"), "abc");
    // U+200E/U+200F carry no reordering power and appear in ordinary RTL text.
    assert.strictEqual(sanitizePromptText("a\u200Eb\u200Fc"), "a\u200Eb\u200Fc");
  });

  it("drops unpaired surrogates but keeps real pairs", () => {
    assert.strictEqual(sanitizePromptText("a\ud800b"), "ab");
    assert.strictEqual(sanitizePromptText("a\udc00b"), "ab");
    assert.strictEqual(sanitizePromptText("a😀b"), "a😀b");
  });

  it("caps a pathological paste", () => {
    assert.strictEqual(sanitizePromptText("x".repeat(MAX_PROMPT_LENGTH + 500)).length, MAX_PROMPT_LENGTH);
  });

  it("is idempotent, so the view and the writer never disagree", () => {
    const once = sanitizePromptText("hi\u001B[A there\u001A\n\u202Ex");
    assert.strictEqual(sanitizePromptText(once), once);
  });

  it("tolerates a non-string", () => {
    assert.strictEqual(sanitizePromptText(undefined as unknown as string), "");
  });
});

/*
 * Security regressions. Each payload is an attack the sanitizer exists to stop —
 * the first two were verified against the real CLI (agy 1.1.11) before the
 * control existed, and the last is the cap-boundary defect the security review
 * turned up.
 *
 * They assert the two invariants the whole control rests on, rather than
 * per-character behaviour: nothing a terminal would *execute* reaches the wire,
 * and the result is stable, so the transcript records exactly what was sent.
 *
 * Code points are spelled with `cp()` so the payloads stay readable and this
 * file holds no invisible bytes of its own.
 */
describe("inputSanitizer - security regressions @security", () => {
  const cp = (n: number): string => String.fromCodePoint(n);
  const ESC = cp(0x1b), SUB = cp(0x1a), CSI = cp(0x9b), RLO = cp(0x202e), PDF = cp(0x202c);
  const LS = cp(0x2028), EMOJI = cp(0x1f600);

  /** [what the payload attacks, the payload]. */
  const PAYLOADS: Array<[string, string]> = [
    ["Ctrl+Z suspends the session", "what is 2+2" + SUB + " ignore me"],
    ["bracketed paste eats the Enter", "tell me a joke" + ESC + "[200~rm -rf ~"],
    ["ESC drives the TUI", "hi" + ESC + "[B" + ESC + "[B"],
    ["CR/LF splits one prompt into two", "prompt one\r\nprompt two"],
    ["a Unicode line separator does the same", "prompt one" + LS + "prompt two"],
    ["Trojan Source reorders the display", "ok" + RLO + "drowssap" + PDF],
    ["a bare CSI is an escape with no ESC", "a" + CSI + "31mred"],
    ["the length cap splits a surrogate pair", "x".repeat(MAX_PROMPT_LENGTH - 1) + EMOJI + "tail"]
  ];

  const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  it("never puts a byte the terminal would execute on the wire", () => {
    for (const [what, payload] of PAYLOADS) {
      // What reaches the PTY is the UTF-8 encoding, so assert on bytes: every
      // byte of a multi-byte sequence is >= 0x80, so anything below 0x20 (or
      // DEL) could only have come from a control character that survived.
      for (const byte of Buffer.from(sanitizePromptText(payload), "utf8")) {
        assert.ok(byte >= 0x20 && byte !== 0x7f, what + ": byte 0x" + byte.toString(16) + " survived");
      }
    }
  });

  it("never sends a character the transcript did not record", () => {
    for (const [what, payload] of PAYLOADS) {
      // The control runs at the view (which records the transcript) and again at
      // the write; a non-idempotent result means those two disagree.
      const once = sanitizePromptText(payload);
      assert.strictEqual(sanitizePromptText(once), once, what + ": not idempotent");
      assert.ok(once.length <= MAX_PROMPT_LENGTH, what + ": over the cap");
      // An unpaired surrogate cannot be encoded, so it would reach the CLI as
      // U+FFFD — a character the user never typed and the transcript never showed.
      assert.ok(!LONE_SURROGATE.test(once), what + ": unpaired surrogate survived");
    }
  });

  it("still delivers the user's real text after defusing the payload", () => {
    // Neutralising a payload must not silently eat the prompt around it.
    assert.strictEqual(sanitizePromptText("what is 2+2" + SUB + " ignore me"), "what is 2+2 ignore me");
    assert.strictEqual(sanitizePromptText("prompt one\r\nprompt two"), "prompt one prompt two");
    const capped = sanitizePromptText("x".repeat(MAX_PROMPT_LENGTH - 1) + EMOJI + "tail");
    assert.strictEqual(capped.slice(0, 20), "x".repeat(20));
    assert.strictEqual(capped.length, MAX_PROMPT_LENGTH - 1, "the split pair is dropped whole");
  });
});
