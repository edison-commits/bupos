#!/usr/bin/env node
/**
 * Pre-merge adversarial audit — assembles a Claude-ready audit prompt
 * from the pending diff + recent closure notes. Two modes:
 *
 *   1. `--print`  → writes the prompt to stdout. Paste into Claude
 *      Code / chat / wherever for a manual round. Zero API cost.
 *
 *   2. (default)  → if ANTHROPIC_API_KEY is set, calls the Messages
 *      API (Claude Sonnet) with the prompt + instructs the model to
 *      return JSON findings. Exits 1 on CRITICAL/HIGH findings,
 *      0 otherwise. Posts a human-readable summary.
 *
 * Why this exists: R21, R22, and R23 each caught bugs that
 * `lint + typecheck + existing tests` missed. The audit agents
 * reason about threat models, Workers-runtime behavior, and
 * concurrency edge cases — classes of bugs that static analysis
 * can't catch. Making this a merge gate turns adversarial reasoning
 * from "sometimes" to "every PR".
 *
 * CI integration: `.github/workflows/pre-merge-audit.yml` runs this
 * on `pull_request`, posts findings as a PR comment, fails the check
 * on HIGH+. Self-hosted or skipped if ANTHROPIC_API_KEY absent.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const MODE_PRINT = process.argv.includes("--print");
const BASE_REF = process.env.BASE_REF ?? "origin/main";

// R24-H-3: validate the base ref exists before computing the diff.
// On workflow_dispatch `github.base_ref` is empty → BASE_REF resolves
// to `origin/` which git can't parse → prior code fell through to an
// empty diff silently. Exit 2 ("audit inputs broken") so CI can
// distinguish "no findings" from "couldn't assemble a diff".
function verifyBaseRef() {
  if (!BASE_REF || BASE_REF === "origin/") {
    return { ok: false, reason: "BASE_REF is empty (unset or branch-less dispatch)" };
  }
  try {
    execSync(`git rev-parse --verify ${JSON.stringify(BASE_REF)}`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `BASE_REF '${BASE_REF}' does not resolve (${(err instanceof Error ? err.message : String(err)).slice(0, 200)})`,
    };
  }
}

function gitDiff() {
  return execSync(`git diff ${BASE_REF}...HEAD --unified=3 --no-color`, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function gitChangedFiles() {
  return execSync(`git diff ${BASE_REF}...HEAD --name-only`, {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

function readClosureNotes() {
  try {
    const src = fs.readFileSync(path.join(ROOT, "docs/KNOWN_ISSUES.md"), "utf8");
    // Grab the last three round closures' sections (R21/R22/R23 at
    // time of writing — this auto-picks up future rounds).
    const matches = src.match(/### `R\d+ closures`.*?(?=\n### `|\n---|\n## |$)/gs) ?? [];
    return matches.slice(-3).join("\n\n");
  } catch {
    return "";
  }
}

// R24-H-3: when the diff is embedded in ```` ```diff ```` fences,
// any diff line that happens to contain three backticks terminates
// the outer fence early, collapsing the prompt's framing. Defensive
// escape: replace runs of 3+ backticks with zero-width-joined variants
// that still read human-readable but don't terminate a fence.
function escapeFenceBreakers(s) {
  return s.replace(/```/g, "`\u200B``");
}

const PROMPT_MAX_DIFF_BYTES = 150_000;

function assemblePrompt() {
  const rawDiff = gitDiff();
  const files = gitChangedFiles();
  const closures = readClosureNotes();
  const truncated = rawDiff.length > PROMPT_MAX_DIFF_BYTES;
  const diff = escapeFenceBreakers(
    truncated
      ? rawDiff.slice(0, PROMPT_MAX_DIFF_BYTES) +
        `\n\n[... TRUNCATED: original diff was ${rawDiff.length} bytes; audit prompt capped at ${PROMPT_MAX_DIFF_BYTES} ...]\n`
      : rawDiff,
  );
  if (truncated) {
    console.warn(
      `⚠  Diff exceeds ${PROMPT_MAX_DIFF_BYTES} bytes (${rawDiff.length}); truncated in prompt. Consider splitting the PR for full audit coverage.`,
    );
  }

  return `You are a pre-merge adversarial auditor for BuPOS, a multi-tenant POS on Next.js + Cloudflare Workers + Neon/Supabase Postgres.

Your job: review the pending diff and find bugs that \`lint + typecheck + existing tests\` would miss. Prior rounds found: concurrency races, Workers-runtime binding bugs, search-path hijacks, timing oracles, module-state leaks, FK ordering bugs, silent placebo guardrails. Expect the same classes.

Output format — STRICT JSON, one finding per entry:
\`\`\`json
{
  "findings": [
    {
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
      "title": "Short noun phrase",
      "file": "src/path/to/file.ts",
      "line": 123,
      "quote": "<15-word code snippet>",
      "scenario": "What attacker or runtime sequence triggers this",
      "fix": "One-sentence fix direction"
    }
  ]
}
\`\`\`

CRITICAL = cross-tenant data loss / account takeover / auth bypass.
HIGH = security bypass / real correctness under load.
MEDIUM = integrity / DoS / operational.
LOW = hardening / polish.
INFO = style.

Rules:
- Read ALL changed files. Don't skip.
- Target 3-15 findings. If none, output \`{"findings": []}\` — don't pad.
- Skip anything already in closure notes below (already caught + fixed).
- Be specific: actual exploit sequences, not vague worries.
- Hunt for:
  • race conditions when the diff touches concurrency or tx boundaries
  • Workers-specific hazards: module-scope state, waitUntil, fetch cancellation, getCloudflareContext
  • SECURITY DEFINER functions without search_path
  • SQL injection / RLS bypass via raw pool.query (should use orgQuery/orgTx)
  • timing oracles in auth paths
  • FK ordering or constraint-violation paths not caught
  • fix-creates-new-bug patterns (last round's fix introducing this round's finding)

## Recent closure notes (skip findings already here)

${closures.slice(0, 5000)}

## Changed files (${files.length})

${files.map((f) => `- ${f}`).join("\n")}

## Diff

\`\`\`diff
${diff}
\`\`\`

Output ONLY the JSON, no preamble. If the diff is empty or contains only whitespace/config changes, output \`{"findings": []}\`.`;
}

async function callClaude(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("✗ ANTHROPIC_API_KEY not set — use --print to dump the prompt, or set the key.");
    process.exit(2);
  }
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error(`✗ Anthropic API error (${resp.status}): ${txt.slice(0, 500)}`);
    process.exit(2);
  }
  const body = await resp.json();
  const text = body.content?.[0]?.text ?? "";
  // R24-H-3: greedy /\{[\s\S]*\}/ matches from the first `{` to the
  // last `}` — breaks if the model prefaces with natural-language
  // text containing `{example}`. Try a fenced ```json block first,
  // then a top-level JSON-looking span, and as a last resort try
  // parsing the whole response.
  const parseAttempts = [
    // Preferred: ```json ... ``` fenced block
    () => {
      const m = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      return m ? m[1] : null;
    },
    // A JSON object that starts the response (with optional whitespace).
    () => {
      const m = text.match(/^\s*(\{[\s\S]*\})\s*$/);
      return m ? m[1] : null;
    },
    // A JSON object starting with the known "findings" key.
    () => {
      const m = text.match(/\{\s*"findings"\s*:[\s\S]*\}/);
      return m ? m[0] : null;
    },
    // Last resort: greedy match (historical behavior).
    () => {
      const m = text.match(/\{[\s\S]*\}/);
      return m ? m[0] : null;
    },
  ];
  for (const attempt of parseAttempts) {
    const candidate = attempt();
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try next strategy
    }
  }
  console.error("✗ No parseable JSON in agent response:");
  console.error(text.slice(0, 1000));
  process.exit(2);
}

function summarize(findings) {
  const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [], INFO: [] };
  for (const f of findings) (bySeverity[f.severity] ?? bySeverity.INFO).push(f);

  console.log("\n── Pre-merge audit report ──\n");
  for (const sev of ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]) {
    const items = bySeverity[sev];
    if (!items.length) continue;
    console.log(`\n${sev} (${items.length}):`);
    for (const f of items) {
      console.log(`  • ${f.title}`);
      console.log(`    ${f.file}:${f.line}`);
      if (f.quote) console.log(`    quote: ${f.quote.slice(0, 100)}`);
      console.log(`    scenario: ${(f.scenario ?? "").slice(0, 200)}`);
      console.log(`    fix: ${(f.fix ?? "").slice(0, 200)}`);
    }
  }
  const gatingCount = bySeverity.CRITICAL.length + bySeverity.HIGH.length;
  console.log(`\nTotal: ${findings.length} finding(s). Gating (CRITICAL+HIGH): ${gatingCount}.`);
  return gatingCount;
}

// R24-H-3: refuse to produce a silent-pass on a broken input.
const baseRefCheck = verifyBaseRef();
if (!baseRefCheck.ok) {
  console.error(`✗ pre-merge audit: ${baseRefCheck.reason}`);
  console.error(
    `  Set BASE_REF to a valid ref (default 'origin/main'). Manual dispatch with no PR context is unsupported.`,
  );
  process.exit(2);
}

const prompt = assemblePrompt();

// R24-H-3: empty diff → not a silent "no findings," but an input
// problem to surface.
{
  const diffBytes = prompt.match(/```diff\n([\s\S]*?)```/)?.[1]?.trim() ?? "";
  if (diffBytes.length === 0) {
    console.error(`✗ pre-merge audit: empty diff between BASE_REF='${BASE_REF}' and HEAD.`);
    console.error(
      `  Either the branch is up-to-date with base (no changes to audit) or the base ref was wrong.`,
    );
    // Exit 0 only if there are genuinely no changed files — a truly
    // fast-forward no-op PR.
    const changedCount = gitChangedFiles().length;
    if (changedCount === 0) {
      console.log("✓ no changed files; nothing to audit.");
      process.exit(0);
    }
    console.error(`  ${changedCount} file(s) changed but diff came out empty — investigating.`);
    process.exit(2);
  }
}

if (MODE_PRINT) {
  process.stdout.write(prompt);
  process.exit(0);
}

const result = await callClaude(prompt);
const findings = result.findings ?? [];
const gating = summarize(findings);

if (gating > 0) {
  console.log("\n✗ Pre-merge audit BLOCKED — address CRITICAL/HIGH findings before merge.\n");
  process.exit(1);
}
console.log("\n✓ Pre-merge audit passed (no CRITICAL/HIGH findings).\n");
