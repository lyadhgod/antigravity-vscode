#!/usr/bin/env node
/*
 * Stub `agy` CLI used by the test suite.
 *
 * Emulates the parts of the real Antigravity CLI surface the tests rely on,
 * matching the verified v1.0.4 behavior: headless `--print` emits **plain text**
 * (there is no JSON output mode).
 *
 *   agy --version                  -> prints a version line
 *   agy update                     -> prints an "up to date" line
 *   agy changelog                  -> prints changelog text
 *   agy --print [flags] <prompt>   -> prints a plain-text reply
 *
 * Prompt content triggers deterministic scenarios:
 *   contains "LOGIN"  -> emits an auth error on stderr and exits 1
 *   contains "BOOM"   -> emits a generic error on stderr and exits 2
 *   otherwise         -> streams two plain-text lines and exits 0
 *
 * Point the extension at it with "antigravity.cliPath": "<abs>/agy-stub.js".
 */
"use strict";

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write("agy version 1.0.4 (go1.22.0)\n");
  process.exit(0);
}
if (argv[0] === "update") {
  process.stdout.write("Antigravity CLI is up to date (1.0.4)\n");
  process.exit(0);
}
if (argv[0] === "changelog") {
  process.stdout.write("1.0.4:\n- Stub changelog entry.\n");
  process.exit(0);
}

if (argv.includes("--print") || argv.includes("-p")) {
  const prompt = argv[argv.length - 1] || "";
  if (/LOGIN/i.test(prompt)) {
    process.stderr.write("Error: not logged in. Run agy to sign in.\n");
    process.exit(1);
  }
  if (/BOOM/i.test(prompt)) {
    process.stderr.write("Error: something went boom\n");
    process.exit(2);
  }
  // Plain text, emitted as two writes to exercise streaming.
  process.stdout.write("Hello from ");
  process.stdout.write("the agent.\n");
  process.exit(0);
}

process.stdout.write("antigravity interactive session (stub)\n");
process.exit(0);
