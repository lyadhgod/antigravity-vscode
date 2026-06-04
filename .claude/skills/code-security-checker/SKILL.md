---
name: code-security-checker
description: Run a comprehensive security review — scans git diff or full codebase, reports vulnerabilities, fixes them iteratively with test validation, and optionally codifies checks into the test suite. Use when asked to do a security check, security review, find vulnerabilities, or audit the code.
---

# Code Security Checker

A comprehensive security audit loop: detect scope → review → fix → test → (optionally) embed in test suite. Maximum 30 fix iterations before escalating to manual intervention.

---

## Step 1 — Determine scope

Run:
```bash
git diff HEAD
```

**If the diff is non-empty:** scope = changed files only. Extract the list:
```bash
git diff HEAD --name-only
```
Announce: "Git changes detected. Reviewing changed files only: `<list>`."

**If the diff is empty:** ask the user:
> No git changes detected. Would you like to run a full-codebase security review? (yes / no)

- **no** → stop here, nothing to do.
- **yes** → scope = entire repository. Announce: "Running full-codebase security review."

---

## Step 2 — Security review

Analyse **only the in-scope files** (changed files, or all source files for a full review). Apply the methodology below.

### What to look for

**Injection**
- Command injection: user-controlled data passed to `spawn`, `exec`, shell strings, template literals that build shell commands.
- Path traversal: user input joined to a file path without normalisation/sandboxing (`path.join` with untrusted parts, `readFile(userInput)`).
- XSS: `innerHTML`, `outerHTML`, `document.write`, `dangerouslySetInnerHTML` set from external data without escaping.
- SQL / NoSQL injection: string interpolation into queries.

**Authentication & authorisation**
- Auth bypass: missing checks, hardcoded credentials, predictable tokens.
- Privilege escalation: logic that lets a lower-privilege actor reach a higher-privilege path.

**Secrets & crypto**
- Hardcoded API keys, passwords, tokens, or private keys in source.
- Weak algorithms (MD5/SHA1 for passwords, `Math.random()` for security tokens).

**Data exposure**
- Sensitive fields (passwords, tokens, PII) written to logs or error messages.
- Overly broad API responses that return internal fields.

**Deserialization**
- `eval`, `new Function`, unsafe `JSON.parse` of untrusted payloads, `pickle.loads`, `yaml.load` (unsafe).

### What NOT to flag
Skip DOS, rate-limiting, resource exhaustion, missing audit logs, theoretical regex-DOS, lack of hardening measures, outdated deps, and anything below 80 % confidence of real exploitability.

### Output format

For each finding:
```
## Vuln N: <category> — <file>:<line>
- Severity: High | Medium | Low
- Description: <what and why>
- Exploit scenario: <concrete attack path>
- Recommendation: <specific fix>
```

If **no vulnerabilities found**: state so clearly and stop.

---

## Step 3 — Fix loop (max 30 iterations)

If findings exist, ask the user:
> `N` vulnerabilities found. Proceed to fix them? (yes / no)

**no** → print the findings report and stop.

**yes** → begin the fix loop. Track `ITERATION=0`.

### Each iteration:

1. **Increment** `ITERATION`. If `ITERATION > 30`:
   > ⚠️  Maximum iterations (30) reached. The following issues require manual intervention:
   > `<list remaining unfixed findings>`
   > Stop.

2. **Apply fixes** for all outstanding findings — edit files directly. Prefer minimal, targeted changes. Do not refactor surrounding code.

3. **Run the test suite:**
   ```bash
   npm test
   ```
   (Adapt to the project's test command: `pytest`, `go test ./...`, `cargo test`, etc. — check `package.json` / `Makefile` / CI config.)

4. **Evaluate:**
   - Tests pass → go to Step 4.
   - Tests fail → diagnose the failure. If the fix broke something unrelated to security, refine the fix and loop back to 3. If the failure is in a pre-existing broken test, note it and continue.

5. **Re-scan** the previously-flagged lines to confirm fixes are effective. If a fix is incomplete, add it back to the outstanding list and loop.

---

## Step 4 — Embed in test suite

Ask the user:
> Fixes applied and tests passing. Add security regression tests to the test suite so these vulnerabilities are caught automatically? (yes / no)

**no** → print a summary and stop.

**yes** → for each fixed vulnerability, add a test that:
- Attempts the exact exploit scenario described in the finding.
- Asserts it is rejected / sanitised / throws an appropriate error.
- Is grouped under a `security` describe-block or tagged `@security`.

Then re-run the full test suite. If tests fail, diagnose and fix (same 30-iteration cap, shared with the fix loop above). Once all pass, print:

> ✅ Security review complete. `N` vulnerabilities fixed. `M` regression tests added. All tests pass.

---

## Notes

- **Scope discipline:** never read or modify files outside the declared scope without asking.
- **No false positives:** only report findings where exploitation is concrete and the confidence is ≥ 80 %.
- **Preserve behaviour:** fixes must not change observable non-security behaviour. Run tests after every change.
- **Iteration counter is shared** across fix iterations and test-embedding iterations — the combined total must not exceed 30.
