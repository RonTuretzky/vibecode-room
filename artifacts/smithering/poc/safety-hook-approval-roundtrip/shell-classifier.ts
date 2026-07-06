/**
 * shell-classifier.ts — deterministic shell-command classifier for the Vibersyn safety hook.
 *
 * Per eng §8.1.1 (R9 critical): distinguishes read-safe shell (ungated, preserves AC11.1 autonomy)
 * from mutating/unknown shell (gated, deny-by-default).
 *
 * NOTE (POC FINDING): The production impl should use a real shell parser (shell-quote, P-SHELL-PARSE)
 * to handle all edge cases. This POC uses a conservative regex approach that errs toward gating on
 * anything ambiguous — safe but potentially over-gating. Behavior difference vs real parser:
 *   - Nested parens/backticks in read-safe programs → this impl gates (real parser: could allow if no mutation)
 *   - Here-docs → this impl gates (real parser: gate too — injection risk)
 *   - In practice: the deny-by-default backstop means false positives (over-gating) are safe, false negatives (under-gating) are not.
 */

export type SimpleCommandVerdict = "read-safe" | "mutating" | "unknown";

export interface SimpleCommand {
  argv0: string;
  rawArgs: string;
  verdict: SimpleCommandVerdict;
  reason: string;
}

export interface ShellVerdict {
  verdict: SimpleCommandVerdict;
  gated: boolean;
  parts: SimpleCommand[];
  raw: string;
}

// ── Read-safe allowlist ───────────────────────────────────────────────────────

const READ_SAFE_PROGRAMS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "echo", "printf",
  "env", "which", "type", "date", "tree", "sort", "uniq", "cut", "column",
  "diff", "cmp", "grep", "rg", "ag", "find", "sed", "awk",
  "git", "bun", "node", "tsc", "deno",
]);

// Programs that are ONLY read-safe with specific subcommands
const READ_SAFE_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "branch", "remote", "rev-parse",
  "describe", "blame", "ls-files", "cat-file",
]);

const READ_SAFE_GIT_FLAG_PATTERNS = [/^--list$/, /^-v$/, /^config$/];

// ── Mutating allowlist ────────────────────────────────────────────────────────

const MUTATING_PROGRAMS = new Set([
  "rm", "rmdir", "unlink", "shred", "dd", "mkfs", "truncate",
  "chmod", "chown", "kill", "pkill", "reboot", "shutdown",
  "mv", "cp", "install", "ln",
  "docker", "kubectl", "terraform", "helm",
  "psql", "mysql", "sqlite3", "pg", "mongosh",
  "npm", "yarn", "pnpm",
]);

// Injection/opacity patterns — anything with these is unknown → gated
const INJECTION_PATTERNS = [
  /\$\(/, // command substitution
  /`[^`]/,  // backtick command substitution
  /\beval\b/,
  /\bexec\b/,
  /\bsource\b|\b\.\s/,
  /<\(/, // process substitution input
  />\(/, // process substitution output
];

// Shell operators that split simple commands
const SPLIT_OPERATORS = /&&|\|\||;|\n|\|/;

// Redirect patterns — write (>) or append (>>) to a non-null target.
// We strip /dev/null redirects before testing so they don't trigger the guard.
const WRITE_REDIRECT = /(?<![<>])>(?!>)/;
const APPEND_REDIRECT = />>/;
const DEV_NULL_REDIRECT = />{1,2}\s*\/dev\/(null|stderr|stdout|stdin)\b/g;

// ── Classification ────────────────────────────────────────────────────────────

function classifySimpleCommand(raw: string): SimpleCommand {
  const trimmed = raw.trim();

  // Empty command
  if (!trimmed) {
    return { argv0: "", rawArgs: "", verdict: "read-safe", reason: "empty" };
  }

  // Injection/opacity check first — fail fast
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        argv0: trimmed.split(/\s+/)[0] ?? "",
        rawArgs: trimmed,
        verdict: "unknown",
        reason: `injection pattern detected: ${pattern.source}`,
      };
    }
  }

  // Write redirects (> or >>) — strip /dev/null-style inert redirects first
  const strippedRedirects = trimmed.replace(DEV_NULL_REDIRECT, "");
  if (WRITE_REDIRECT.test(strippedRedirects) || APPEND_REDIRECT.test(strippedRedirects)) {
    return {
      argv0: trimmed.split(/\s+/)[0] ?? "",
      rawArgs: trimmed,
      verdict: "mutating",
      reason: "write redirect detected",
    };
  }

  const tokens = trimmed.split(/\s+/);
  const argv0 = tokens[0] ?? "";
  const restArgs = tokens.slice(1).join(" ");

  // Explicitly mutating programs
  if (MUTATING_PROGRAMS.has(argv0)) {
    return {
      argv0,
      rawArgs: restArgs,
      verdict: "mutating",
      reason: `${argv0} is explicitly mutating`,
    };
  }

  // mv / cp with file targets (always mutating)
  if (argv0 === "mv" || argv0 === "cp") {
    return { argv0, rawArgs: restArgs, verdict: "mutating", reason: `${argv0} modifies filesystem` };
  }

  // git special handling
  if (argv0 === "git") {
    const subcommand = tokens[1] ?? "";

    // Mutating git operations
    const MUTATING_GIT = new Set([
      "push", "reset", "clean", "checkout", "restore", "rebase",
      "merge", "am", "revert", "stash", "tag", "fetch", "pull",
      "commit", "add", "rm", "mv", "init", "clone", "submodule",
    ]);

    if (MUTATING_GIT.has(subcommand)) {
      // git push --force is especially dangerous
      if (subcommand === "push") {
        return { argv0, rawArgs: restArgs, verdict: "mutating", reason: "git push is mutating (VCS)" };
      }
      if (subcommand === "reset" && trimmed.includes("--hard")) {
        return { argv0, rawArgs: restArgs, verdict: "mutating", reason: "git reset --hard discards changes" };
      }
      if (subcommand === "clean" && (trimmed.includes("-f") || trimmed.includes("-fd"))) {
        return { argv0, rawArgs: restArgs, verdict: "mutating", reason: "git clean -f deletes untracked files" };
      }
      // For most mutating git ops, gate them
      return { argv0, rawArgs: restArgs, verdict: "mutating", reason: `git ${subcommand} is mutating` };
    }

    // Read-safe git operations
    if (READ_SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
      return { argv0, rawArgs: restArgs, verdict: "read-safe", reason: `git ${subcommand} is read-only` };
    }

    // git config --get is read-safe; git config --set is mutating
    if (subcommand === "config") {
      if (trimmed.includes("--get") || trimmed.includes("--list") || trimmed.includes("-l")) {
        return { argv0, rawArgs: restArgs, verdict: "read-safe", reason: "git config --get/--list is read-only" };
      }
      return { argv0, rawArgs: restArgs, verdict: "mutating", reason: "git config without --get/--list is mutating" };
    }

    // Unknown git subcommand → unknown → gated
    return { argv0, rawArgs: restArgs, verdict: "unknown", reason: `git ${subcommand} not in allowlist` };
  }

  // bun special handling
  if (argv0 === "bun") {
    const subcommand = tokens[1] ?? "";
    // bun test, bun run type-check, bun --version are read-safe
    if (subcommand === "test" || subcommand === "--version" || subcommand === "-v") {
      return { argv0, rawArgs: restArgs, verdict: "read-safe", reason: `bun ${subcommand} is read-only` };
    }
    // bun install, bun publish, bun add, bun remove are mutating
    if (["install", "publish", "add", "remove", "update", "link", "unlink"].includes(subcommand)) {
      return { argv0, rawArgs: restArgs, verdict: "mutating", reason: `bun ${subcommand} modifies dependencies` };
    }
    // bun run <script> — could be anything
    if (subcommand === "run") {
      const script = tokens[2] ?? "";
      // Read-safe scripts
      if (["typecheck", "type-check", "lint", "check"].some(s => script.includes(s))) {
        return { argv0, rawArgs: restArgs, verdict: "read-safe", reason: `bun run ${script} is a check script` };
      }
      return { argv0, rawArgs: restArgs, verdict: "unknown", reason: `bun run ${script} could be mutating` };
    }
    return { argv0, rawArgs: restArgs, verdict: "unknown", reason: `bun ${subcommand} not in read-safe list` };
  }

  // tsc special handling
  if (argv0 === "tsc") {
    if (trimmed.includes("--noEmit") || trimmed.includes("--version") || trimmed.includes("-v")) {
      return { argv0, rawArgs: restArgs, verdict: "read-safe", reason: "tsc --noEmit is read-only" };
    }
    return { argv0, rawArgs: restArgs, verdict: "unknown", reason: "tsc without --noEmit could write output" };
  }

  // find special handling — read-safe unless it has -delete/-exec/-execdir/-fprint
  if (argv0 === "find") {
    if (/-delete|-exec|-execdir|-fprint/.test(trimmed)) {
      return { argv0, rawArgs: restArgs, verdict: "mutating", reason: "find with -delete/-exec/-fprint is mutating" };
    }
    return { argv0, rawArgs: restArgs, verdict: "read-safe", reason: "find without mutation flags is read-only" };
  }

  // sed special handling — in-place (-i) is mutating
  if (argv0 === "sed") {
    if (/\s-[a-zA-Z]*i/.test(trimmed) || trimmed.includes("--in-place")) {
      return { argv0, rawArgs: restArgs, verdict: "mutating", reason: "sed -i modifies files in-place" };
    }
    return { argv0, rawArgs: restArgs, verdict: "read-safe", reason: "sed without -i is read-only" };
  }

  // awk — generally read-safe unless it has print-to-file
  if (argv0 === "awk") {
    if (/print\s*>/.test(trimmed)) {
      return { argv0, rawArgs: restArgs, verdict: "mutating", reason: "awk with print > writes to file" };
    }
    return { argv0, rawArgs: restArgs, verdict: "read-safe", reason: "awk without file-write is read-only" };
  }

  // Known read-safe programs (no special subcommand logic needed)
  if (READ_SAFE_PROGRAMS.has(argv0)) {
    return { argv0, rawArgs: restArgs, verdict: "read-safe", reason: `${argv0} is in the read-safe allowlist` };
  }

  // Unknown program → deny-by-default
  return {
    argv0,
    rawArgs: restArgs,
    verdict: "unknown",
    reason: `${argv0} not in allowlist (deny-by-default)`,
  };
}

/**
 * Splits a compound shell command into simple commands.
 * Conservative: if splitting seems unsafe (nested parens), returns the original as-is.
 */
function splitSimpleCommands(raw: string): string[] {
  // Count parens and brackets to detect complex nesting
  let depth = 0;
  for (const ch of raw) {
    if (ch === "(" || ch === "{") depth++;
    if (ch === ")" || ch === "}") depth--;
  }
  if (depth !== 0) {
    // Unbalanced — treat as single unknown command
    return [raw];
  }

  // Split on operators, handling quoted strings naively
  // We do NOT try to parse quotes fully — conservative: treat any ambiguity as unknown
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const rest = raw.slice(i);

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (inSingle || inDouble) {
      current += ch;
      continue;
    }

    // Check for two-char operators
    const two = raw.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      parts.push(current);
      current = "";
      i++; // skip second char
      continue;
    }

    if (ch === ";" || ch === "\n") {
      parts.push(current);
      current = "";
      continue;
    }

    // Pipe — unless it's part of ||
    if (ch === "|" && raw[i + 1] !== "|") {
      parts.push(current);
      current = "";
      continue;
    }

    current += ch;
  }
  if (current.trim()) parts.push(current);

  return parts.filter(p => p.trim());
}

/**
 * Main entry point: classify a shell command string.
 *
 * The compound verdict is the MOST DANGEROUS of the simple-command verdicts:
 *   read-safe < mutating ≤ unknown  (for gating purposes)
 * If ANY part is mutating or unknown, the whole command is gated.
 */
export function classifyShellCommand(raw: string): ShellVerdict {
  const parts = splitSimpleCommands(raw);
  const classified = parts.map(p => classifySimpleCommand(p));

  // Compound verdict = most dangerous
  let compoundVerdict: SimpleCommandVerdict = "read-safe";
  for (const c of classified) {
    if (c.verdict === "unknown") { compoundVerdict = "unknown"; break; }
    if (c.verdict === "mutating") { compoundVerdict = "mutating"; }
  }

  return {
    verdict: compoundVerdict,
    gated: compoundVerdict !== "read-safe",
    parts: classified,
    raw,
  };
}

/**
 * Given a Smithers `defineTool` call context, classify the tool call.
 * Returns whether it should be gated (blocked for approval in Safe mode).
 */
export function classifyToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
): { klass: string; gated: boolean; reason: string; shellVerdict?: ShellVerdict } {
  const name = toolName.toLowerCase();

  // Read tools — never gated
  if (name === "read" || name === "grep" || name === "glob") {
    return { klass: "read", gated: false, reason: "read-only tool" };
  }

  // Bash/shell — classify the command
  if (name === "bash" || name === "shell" || name === "terminal") {
    const cmd = (toolArgs.cmd ?? toolArgs.command ?? toolArgs.input ?? "") as string;
    const shellVerdict = classifyShellCommand(String(cmd));
    return {
      klass: shellVerdict.verdict === "read-safe" ? "read" : (shellVerdict.verdict === "mutating" ? "shell" : "unknown"),
      gated: shellVerdict.gated,
      reason: shellVerdict.parts.map(p => p.reason).join("; "),
      shellVerdict,
    };
  }

  // Write/Edit tools — always gated
  if (name === "write" || name === "edit" || name === "create" || name === "overwrite") {
    return { klass: "fs-write", gated: true, reason: "file write tool" };
  }

  // Delete tools
  if (name === "delete" || name === "unlink" || name === "removefile") {
    return { klass: "fs-delete", gated: true, reason: "file delete tool" };
  }

  // Git push, db mutations — vcs-push / db-mutate
  if (name === "gitpush" || name === "push") {
    return { klass: "vcs-push", gated: true, reason: "VCS push tool" };
  }

  // Unknown tool — deny-by-default
  return { klass: "unknown", gated: true, reason: `${toolName} not in classification allowlist (deny-by-default)` };
}
