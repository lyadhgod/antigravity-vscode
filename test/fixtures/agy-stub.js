#!/usr/bin/env node
/*
 * Stub `agy` CLI used by the test suite.
 *
 * The real Antigravity CLI cannot be installed or signed into from the sandbox
 * (the Google download/auth hosts are firewalled), so this script emulates just
 * enough of the documented surface for the tests and for manual smoke-testing:
 *
 *   agy --version                  -> prints a version line
 *   agy update                     -> prints an "updated" line
 *   agy --print [flags] <prompt>   -> streams NDJSON events (or plain text)
 *
 * Prompt content triggers deterministic scenarios:
 *   contains "LOGIN"  -> emits an auth error on stderr and exits 1
 *   contains "BOOM"   -> emits a generic error on stderr and exits 2
 *   otherwise         -> streams text deltas, a tool event, and a result
 *
 * Point the extension at it with:  "antigravity.cliPath": "<abs>/agy-stub.js"
 * (it is directly executable thanks to the shebang).
 */
"use strict";

const argv = process.argv.slice(2);

function flagValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// `--version`
if (argv.includes("--version")) {
  process.stdout.write("agy version 1.4.2 (go1.22.0)\n");
  process.exit(0);
}

// `update` subcommand
if (argv[0] === "update") {
  process.stdout.write("Antigravity CLI is up to date (1.4.2)\n");
  process.exit(0);
}

// `--print` headless prompt
if (argv.includes("--print") || argv.includes("-p")) {
  const outputFormat = flagValue("--output-format") || "text";
  // The prompt is the final argument (arg builder always places it last).
  const prompt = argv[argv.length - 1] || "";

  if (/LOGIN/i.test(prompt)) {
    process.stderr.write("Error: not logged in. Run agy to sign in.\n");
    process.exit(1);
  }
  if (/BOOM/i.test(prompt)) {
    process.stderr.write("Error: something went boom\n");
    process.exit(2);
  }

  if (outputFormat === "json") {
    const lines = [
      { type: "text", text: "Hello " },
      { type: "text", text: "from the agent." },
      { type: "tool_use", name: "read_file", path: "src/index.ts" },
      {
        type: "result",
        result: "Hello from the agent.",
        is_error: false,
        conversation_id: "conv-abc123",
        usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 }
      }
    ];
    for (const line of lines) {
      process.stdout.write(JSON.stringify(line) + "\n");
    }
  } else {
    process.stdout.write("Hello from the agent.\n");
  }
  process.exit(0);
}

// Bare invocation would launch the interactive TUI; tests don't drive that.
process.stdout.write("antigravity interactive session (stub)\n");
process.exit(0);
