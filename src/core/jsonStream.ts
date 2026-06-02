/**
 * Incremental, fault-tolerant parser for the CLI's `--output-format json`
 * stream, normalized into {@link AgyEvent}s the chat UI can render.
 *
 * Why so defensive? The exact JSON schema emitted by `agy` is not publicly
 * pinned, and agentic CLIs commonly stream **NDJSON** (one JSON object per
 * line) while sometimes emitting a single trailing summary object. This parser
 * therefore:
 *   - buffers partial chunks and only parses complete lines;
 *   - parses each line independently, tolerating interleaved plain text;
 *   - maps a range of plausible field names onto a stable event shape;
 *   - never throws — anything unrecognized is surfaced as a `raw` event so no
 *     output is silently lost.
 */
import { AgyEvent, AgyUsage } from "./types";

/** Reads the first present key from a record, with a typed fallback. */
function pick<T>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      return obj[key] as T;
    }
  }
  return undefined;
}

/** Extracts a usage object from any of the commonly-used field spellings. */
function extractUsage(obj: Record<string, unknown>): AgyUsage | undefined {
  const usage = pick<Record<string, unknown>>(obj, ["usage", "tokens", "token_usage"]);
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const input = pick<number>(usage, ["input_tokens", "inputTokens", "prompt_tokens", "input"]);
  const output = pick<number>(usage, ["output_tokens", "outputTokens", "completion_tokens", "output"]);
  const total = pick<number>(usage, ["total_tokens", "totalTokens", "total"]);
  if (input === undefined && output === undefined && total === undefined) {
    return undefined;
  }
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

/**
 * Maps one already-parsed JSON value onto an {@link AgyEvent}. Returns `null`
 * when the object carries no renderable signal (so callers can skip it).
 *
 * Recognized, in priority order: explicit errors, final results, tool/action
 * activity, and assistant text. The `type`/`role` discriminator is honored when
 * present but is not required.
 */
export function normalizeEvent(value: unknown): AgyEvent | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const type = (pick<string>(obj, ["type", "role", "event"]) ?? "").toLowerCase();

  // 1. Errors.
  const errorMessage = pick<string>(obj, ["error", "error_message", "errorMessage"]);
  if (errorMessage || type === "error") {
    return { kind: "error", message: errorMessage ?? "The agent reported an error." };
  }

  // 2. Final result / summary objects.
  const result = pick<string>(obj, ["result", "response", "final", "answer"]);
  if (result !== undefined || type === "result" || type === "final") {
    return {
      kind: "result",
      text: result ?? "",
      isError: pick<boolean>(obj, ["is_error", "isError"]) ?? false,
      conversationId: pick<string>(obj, ["conversation_id", "conversationId", "session_id", "sessionId"]),
      usage: extractUsage(obj)
    };
  }

  // 3. Tool / action activity.
  if (type === "tool_use" || type === "tool" || type === "action" || obj.tool !== undefined) {
    const name = pick<string>(obj, ["name", "tool", "tool_name", "action"]) ?? "tool";
    const detail = pick<string>(obj, ["detail", "input", "command", "path", "summary"]);
    return { kind: "tool", name, detail: detail ? String(detail) : undefined };
  }

  // 4. Assistant text — possibly nested under message.content[].text.
  const text = extractText(obj);
  if (text) {
    return { kind: "text", text };
  }

  return null;
}

/** Pulls assistant text out of the several shapes models emit it in. */
function extractText(obj: Record<string, unknown>): string | undefined {
  const direct = pick<string>(obj, ["text", "content", "delta", "message"]);
  if (typeof direct === "string") {
    return direct;
  }
  // OpenAI/Anthropic-style: { message: { content: [{ type:"text", text }] } }
  const message = pick<Record<string, unknown>>(obj, ["message", "delta"]);
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      const parts = content
        .map((part) => (part && typeof part === "object" ? (part as Record<string, unknown>).text : undefined))
        .filter((t): t is string => typeof t === "string");
      if (parts.length > 0) {
        return parts.join("");
      }
    }
  }
  return undefined;
}

/**
 * Stateful, push-based parser. Feed it raw stdout chunks; it returns any events
 * that became complete. Call {@link flush} once the process exits to drain the
 * final unterminated line.
 */
export class JsonStreamParser {
  private buffer = "";

  /** Feeds a chunk of stdout and returns events parsed from complete lines. */
  push(chunk: string): AgyEvent[] {
    this.buffer += chunk;
    const events: AgyEvent[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const event = this.parseLine(line);
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  /** Parses whatever remains in the buffer after the stream ends. */
  flush(): AgyEvent[] {
    const remaining = this.buffer;
    this.buffer = "";
    const event = this.parseLine(remaining);
    return event ? [event] : [];
  }

  /**
   * Parses a single line: JSON when possible (normalized), otherwise non-empty
   * plain text is preserved as a `raw` event. Blank lines are dropped.
   */
  private parseLine(line: string): AgyEvent | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return normalizeEvent(JSON.parse(trimmed));
      } catch {
        // Fall through: malformed/partial JSON shown verbatim rather than lost.
      }
    }
    return { kind: "raw", line: trimmed };
  }
}

/**
 * Convenience for the non-streaming case: parse an entire captured stdout
 * buffer at once. Handles a single JSON object, a JSON array of events, or
 * NDJSON, and always returns at least one event for non-empty input.
 */
export function parseWhole(output: string): AgyEvent[] {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return [];
  }
  // Try the whole buffer as one JSON value first (single object or array).
  try {
    const value = JSON.parse(trimmed);
    if (Array.isArray(value)) {
      return value.map(normalizeEvent).filter((e): e is AgyEvent => e !== null);
    }
    const single = normalizeEvent(value);
    if (single) {
      return [single];
    }
  } catch {
    // Not a single JSON value — fall back to the line-oriented parser.
  }
  const parser = new JsonStreamParser();
  return [...parser.push(output), ...parser.flush()];
}
