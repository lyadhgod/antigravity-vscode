/**
 * Makes user-supplied text safe to type into the live `agy` TUI.
 *
 * Everything the panel submits — a chat prompt, a "Write-in" answer, the OAuth
 * code — is written verbatim onto a **pseudo-terminal**, where the CLI reads it
 * as keystrokes. So a control byte inside that text is not data: it is a key
 * press, and the TUI acts on it. Verified against the real CLI (agy 1.1.11)
 * driven through `core/ptyLauncher`:
 *
 *   - `"what is 2+2" + U+001A + " ignore me"` — U+001A is Ctrl+Z, which this
 *     extension itself uses to end a session (see
 *     `InteractiveSessionService.dispose`). The tail was swallowed, the session
 *     was suspended, and the Enter that followed did nothing: the prompt was
 *     never submitted, and the composer would have stayed locked for the rest
 *     of the session.
 *   - `"tell me a joke" + ESC + "[200~…"` — the bracketed-paste introducer put
 *     the input box into a paste state that ate the submitting Enter, wedging
 *     the session the same way.
 *
 * Both are reachable from ordinary use: pasting into the composer from a
 * terminal, a log file, or a model's own output. That is why this runs on the
 * host side (the trust boundary), not only in the webview.
 *
 * Unicode text is the point of all this — CJK input via an IME (#8) is exactly
 * the case that made multi-byte handling matter — so the rule is narrow: strip
 * what a terminal would *execute*, keep every printable character. Wide (CJK)
 * characters, combining marks, emoji (ZWJ sequences included) and the plain
 * bidi marks used by real Arabic/Hebrew text all pass through untouched.
 *
 * Pure (no `vscode`, no I/O) so it is unit-tested on bare Node.
 */

/**
 * Hard ceiling on one submitted line. The TUI has to echo and re-render
 * whatever it is handed; this is far above any real prompt but stops a
 * pathological paste from being typed into it a megabyte at a time.
 */
export const MAX_PROMPT_LENGTH = 100_000;

/**
 * Anything that would end the line the CLI is reading. `\n`/`\r` are the
 * obvious pair, but a terminal treats VT (U+000B) and FF (U+000C) as line
 * breaks too, and NEL/LS/PS (U+0085, U+2028, U+2029) are their Unicode
 * equivalents — each one could split a single prompt into two submissions. Tab
 * joins them because the input box reads it as a completion key, not as
 * whitespace. All become one space, so a pasted paragraph stays one readable
 * prompt instead of losing its word breaks.
 */
const LINE_BREAKS = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029\t]/g;

/**
 * The rest of the control space, removed outright: C0 + DEL (ESC and every
 * Ctrl-key the TUI binds) and C1, where U+009B is a bare CSI — an escape
 * sequence introducer with no ESC in front of it.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Bidirectional embedding/override/isolate controls — the "Trojan Source"
 * family. They reorder the *display* of a line without changing its
 * characters, so text can be made to read as something other than what is
 * submitted, both in the chat transcript and in the CLI's own echo. Nothing in
 * a prompt needs them. The plain marks U+200E/U+200F are deliberately NOT here:
 * they carry no reordering power of their own and appear in ordinary RTL text.
 */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * Halves of a surrogate pair with no partner. They cannot be encoded as UTF-8,
 * so Node would put U+FFFD on the wire; dropping them keeps what we send equal
 * to what we recorded and showed.
 */
const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Cleans one line of user text for the CLI's input box.
 *
 * Idempotent, so it is safe to apply again at the write itself as a backstop
 * for a path that forgot to — which is exactly how it is wired: the view
 * sanitizes on the way in (so the transcript records what was really sent) and
 * `InteractiveSessionService` sanitizes again on the way out.
 */
export function sanitizePromptText(text: string): string {
  const stripped = String(text ?? "")
    .replace(LINE_BREAKS, " ")
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_CONTROLS, "");
  // Cap BEFORE the surrogate rule, never after. `slice` counts UTF-16 code
  // units, so a cap landing inside an astral character (emoji, rare CJK) splits
  // the pair; strip the halves first and the orphan is already past the rule,
  // reaches the PTY as U+FFFD, and makes this function non-idempotent — which
  // would leave the transcript recording something other than what was sent.
  const capped = stripped.length > MAX_PROMPT_LENGTH ? stripped.slice(0, MAX_PROMPT_LENGTH) : stripped;
  return capped.replace(LONE_SURROGATES, "");
}
