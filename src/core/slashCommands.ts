/**
 * Catalog of Antigravity slash commands surfaced by the in-UI navigator (#8).
 *
 * This is the REAL command set, captured directly from `agy` v1.0.4 by driving
 * the interactive TUI through a PTY and reading its `/` autocomplete (all 35
 * entries, including the parenthesised aliases). It supersedes the earlier,
 * partly-guessed list — commands like `/compact`, `/memory`, `/init`, `/commit`
 * and `/cost` do **not** exist in agy and have been removed.
 *
 * Routing (`target`):
 *   - `native`  → handled by the extension directly for the best webview UX
 *                 (`/clear` starts a new session, `/help` shows this catalog,
 *                 `/logout` runs the account command, `/changelog` opens it).
 *   - `session` → forwarded verbatim to the session's live interactive `agy`,
 *                 where it actually runs (model picker, diff, permissions,
 *                 MCP, …). Interactive pickers are best driven from the terminal
 *                 mirror (the title-bar terminal button).
 *
 * The navigator also allows free-form `/anything`, so this list is a
 * discoverability aid, not an allowlist.
 */
import { SlashCommand } from "./types";

/** The curated catalog — every command agy actually offers (v1.0.4). */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/add-dir", description: "Add a directory to the workspace", target: "session", takesArgs: true },
  { name: "/agents", description: "List available custom agents", target: "session" },
  { name: "/artifact", description: "View and review artifacts", target: "session" },
  { name: "/btw", description: "Ask a side question without interrupting the current task", target: "session", takesArgs: true },
  { name: "/changelog", description: "Show release notes and changes", target: "native" },
  { name: "/clear", description: "Clear the conversation and start a new one", target: "native", alias: "new" },
  { name: "/config", description: "Open the settings panel", target: "session", alias: "settings" },
  { name: "/context", description: "Visualize current context usage", target: "session" },
  { name: "/copy", description: "Copy the last response to the clipboard", target: "session" },
  { name: "/credits", description: "Show remaining G1 credits and the purchase link", target: "session" },
  { name: "/diff", description: "View uncommitted changes and per-turn diffs", target: "session" },
  { name: "/exit", description: "Exit the session", target: "session", alias: "quit" },
  { name: "/fast", description: "Execute tasks directly — faster for simple tasks", target: "session" },
  { name: "/feedback", description: "Submit feedback to improve the agent", target: "session", takesArgs: true },
  { name: "/fork", description: "Branch the conversation at this point", target: "session", alias: "branch" },
  { name: "/goal", description: "Run until the specified goal is completely finished", target: "session", takesArgs: true },
  { name: "/grill-me", description: "Interview me to align on a plan", target: "session", takesArgs: true },
  { name: "/help", description: "Show available commands and keybindings", target: "native" },
  { name: "/hooks", description: "Manage hook configurations for tool events", target: "session" },
  { name: "/keybindings", description: "Set custom keybindings", target: "session" },
  { name: "/logout", description: "Log out and clear saved credentials", target: "native" },
  { name: "/mcp", description: "Manage MCP servers", target: "session" },
  { name: "/model", description: "Set the active model", target: "session" },
  { name: "/open", description: "Open a file or view opened/edited files", target: "session" },
  { name: "/permissions", description: "Manage tool permissions", target: "session" },
  { name: "/planning", description: "Plan before executing — for deep research or complex tasks", target: "session" },
  { name: "/rename", description: "Rename the current conversation", target: "session", takesArgs: true },
  { name: "/resume", description: "Browse and resume past conversations", target: "session", alias: "switch" },
  { name: "/rewind", description: "Rewind the conversation to a previous message", target: "session", alias: "undo" },
  { name: "/schedule", description: "Run an instruction on a recurring schedule or one-time timer", target: "session", takesArgs: true },
  { name: "/skills", description: "List available skills", target: "session" },
  { name: "/statusline", description: "Toggle or configure the statusline", target: "session" },
  { name: "/tasks", description: "View background tasks", target: "session" },
  { name: "/title", description: "Toggle a custom terminal window title", target: "session" },
  { name: "/usage", description: "View model quota usage", target: "session", alias: "quota" }
];

/** Splits a `/command rest...` input into its command name and argument text. */
export function parseSlash(input: string): { command: string; args: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) {
    return { command: trimmed, args: "" };
  }
  return { command: trimmed.slice(0, spaceIndex), args: trimmed.slice(spaceIndex + 1).trim() };
}

/** The set of strings a command answers to: its name and its `/alias`, if any. */
function aliasNames(c: SlashCommand): string[] {
  return c.alias ? [c.name, "/" + c.alias] : [c.name];
}

/**
 * Filters the catalog for the navigator. `query` may include the leading slash.
 * Matches commands whose name (or alias) *starts with* the query first, then
 * those that merely contain it, so the closest prefixes rank highest.
 */
export function filterSlashCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (q === "" || q === "/") {
    return SLASH_COMMANDS;
  }
  const bare = q.replace(/^\//, "");
  const starts = SLASH_COMMANDS.filter((c) => aliasNames(c).some((n) => n.toLowerCase().startsWith(q)));
  const contains = SLASH_COMMANDS.filter(
    (c) => !aliasNames(c).some((n) => n.toLowerCase().startsWith(q)) && aliasNames(c).some((n) => n.toLowerCase().includes(bare))
  );
  return [...starts, ...contains];
}

/** Looks up a catalog entry by exact name or alias (case-insensitive). */
export function findSlashCommand(name: string): SlashCommand | undefined {
  const n = name.trim().toLowerCase();
  return SLASH_COMMANDS.find((c) => aliasNames(c).some((a) => a.toLowerCase() === n));
}
