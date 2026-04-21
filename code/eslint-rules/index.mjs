/**
 * Custom ESLint rules for this repo.
 *
 * Each rule prevents a shape that has caused bugs in prior audit rounds.
 * Keep the rules tight: only fire on patterns we've verified as real bugs;
 * false positives kill adoption.
 */

// ── no-hand-rolled-currency ────────────────────────────────────────────
//
// Catches: `$${x.toFixed(2)}` (template literal) or `>${x.toFixed(N)}<`
// (JSX text with literal $). These lose comma separators and diverge
// from the shared `formatCurrency` helper.
//
// Exceptions: anything inside a backtick string assigned to a variable
// literally named `csv` (rare) or inside an obvious export context is
// allowed — the cleanup codemod left those alone intentionally because
// commas in CSV break cells.

// Find a "hand-rolled currency" CallExpression anywhere in a fallback chain.
// Catches:
//   .toFixed(N)                     — original case
//   .toLocaleString(..)             — R14-H-6: bypass via toLocaleString
// Walks LogicalExpression (||, ??), ConditionalExpression (?:), and TS
// wrapper nodes so `${x?.toFixed(2) || "0.00"}` / ternary fallbacks still fire.
function findCurrencyCall(expr) {
  if (!expr) return null;
  if (
    expr.type === "CallExpression" &&
    expr.callee.type === "MemberExpression" &&
    !expr.callee.computed &&
    expr.callee.property.type === "Identifier" &&
    (expr.callee.property.name === "toFixed" ||
     expr.callee.property.name === "toLocaleString")
  ) return expr;
  if (expr.type === "LogicalExpression") {
    return findCurrencyCall(expr.left) || findCurrencyCall(expr.right);
  }
  if (expr.type === "ConditionalExpression") {
    return findCurrencyCall(expr.consequent) || findCurrencyCall(expr.alternate);
  }
  // `expr` wrapped in parens is a TSAsExpression / TSNonNullExpression / etc.
  if (expr.type === "TSAsExpression" || expr.type === "TSNonNullExpression" || expr.type === "TSTypeAssertion") {
    return findCurrencyCall(expr.expression);
  }
  return null;
}

// Kept for backward compatibility of the name inside this rule.
const findToFixedCall = findCurrencyCall;

// R14-H-6: detect `"$" + x.toFixed(2)` (string concat) outside templates.
// Walks BinaryExpression trees where `+` has one side being the literal "$"
// and the other side contains a `.toFixed` / `.toLocaleString` call.
function isDollarConcat(node) {
  if (!node || node.type !== "BinaryExpression" || node.operator !== "+") return false;
  const isDollar = (n) => n && n.type === "Literal" && n.value === "$";
  const hasCurrency = (n) => !!findCurrencyCall(n);
  return (
    (isDollar(node.left) && hasCurrency(node.right)) ||
    (isDollar(node.right) && hasCurrency(node.left))
  );
}

const noHandRolledCurrency = {
  meta: {
    type: "problem",
    docs: { description: "Forbid hand-rolled currency formatting" },
    messages: {
      templateDollar:
        "Hand-rolled currency formatting detected ($$${{{expr}}}.toFixed({{digits}})). Use formatCurrency() from @/lib/format.",
      jsxDollar:
        "Hand-rolled currency formatting detected ($...{{{expr}}}.toFixed({{digits}})). Use formatCurrency() from @/lib/format.",
      stringConcat:
        "Hand-rolled currency formatting detected (\"$\" + {{{expr}}}). Use formatCurrency() from @/lib/format.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename?.() || "";
    const sourceCode = context.sourceCode || context.getSourceCode?.();
    const raw = sourceCode?.text ?? "";

    // Thermal receipts and CSV exports intentionally emit plain-$N.NN
    // without thousands separators (narrow columns, CSV cell parsing).
    // Simulation / dev scripts don't render to users. Skip these scopes;
    // the rule only fires in UI / admin surfaces.
    if (
      /src\/lib\/receipt\//.test(filename) ||
      /\/email-receipt\//.test(filename) ||
      /\/scripts\//.test(filename)
    ) {
      return {};
    }

    return {
      TemplateLiteral(node) {
        // Template-literal case: `...$${expr.toFixed(N)}...`
        // We inspect the raw text between template quasis. For each
        // expression, check the preceding quasi's raw text ends with `$`
        // AND the expression (or anything nested inside a || / ?? / ternary
        // fallback) is a CallExpression to `.toFixed(N)`.
        for (let i = 0; i < node.expressions.length; i++) {
          const expr = node.expressions[i];
          const precedingQuasi = node.quasis[i];
          if (!precedingQuasi) continue;
          const precedingRaw = precedingQuasi.value.raw;
          if (!precedingRaw.endsWith("$")) continue;

          const toFixedCall = findToFixedCall(expr);
          if (toFixedCall) {
            // Skip CSV-building contexts — the enclosing statement starts
            // with `csv +=` or similar. Cheap string check on source.
            const exprSrc = sourceCode.getText(toFixedCall);
            const lineStart = raw.lastIndexOf("\n", toFixedCall.range[0]) + 1;
            const lineEnd = raw.indexOf("\n", toFixedCall.range[0]);
            const line = raw.slice(lineStart, lineEnd);
            if (/\bcsv\s*\+?=/i.test(line) || /escapeCsv|writeHeadCell/.test(line)) continue;

            const digits = toFixedCall.arguments[0]?.type === "Literal" ? String(toFixedCall.arguments[0].value) : "?";
            context.report({
              node: toFixedCall,
              messageId: "templateDollar",
              data: { expr: exprSrc.slice(0, 40), digits },
            });
          }
        }
      },

      JSXExpressionContainer(node) {
        // JSX-text case: `>${expr.toFixed(N)}<` or inside a text node
        // where the character immediately preceding `{` in source is `$`.
        // Walks through `||`, `??`, ternary, and TS wrappers.
        const toFixedCall = findToFixedCall(node.expression);
        if (toFixedCall) {
          // Look at the character just before `{` in the source.
          const start = node.range[0];
          const prevChar = raw[start - 1];
          if (prevChar !== "$") return;

          const exprSrc = sourceCode.getText(toFixedCall);
          const digits = toFixedCall.arguments[0]?.type === "Literal"
            ? String(toFixedCall.arguments[0].value)
            : "?";
          context.report({
            node: toFixedCall,
            messageId: "jsxDollar",
            data: { expr: exprSrc.slice(0, 40), digits },
          });
        }
      },

      // R14-H-6: `"$" + x.toFixed(2)` — catches string-concat currency
      // outside of template/JSX contexts.
      BinaryExpression(node) {
        if (!isDollarConcat(node)) return;
        // Skip CSV lines per the same heuristic as TemplateLiteral.
        const lineStart = raw.lastIndexOf("\n", node.range[0]) + 1;
        const lineEnd = raw.indexOf("\n", node.range[0]);
        const line = raw.slice(lineStart, lineEnd);
        if (/\bcsv\s*\+?=/i.test(line) || /escapeCsv|writeHeadCell/.test(line)) return;
        const exprSrc = sourceCode.getText(node).slice(0, 60);
        context.report({
          node,
          messageId: "stringConcat",
          data: { expr: exprSrc },
        });
      },
    };
    void filename; // reserved for future file-scoping
  },
};

// ── no-workers-hazards ─────────────────────────────────────────────────
//
// Catches Workers-incompatible patterns:
//   1. `void import(...).then(...)` — the `no_handle_cross_request_promise_resolution`
//      compat flag cancels the in-flight Promise when the response
//      returns, silently dropping the effect. Caught R11-H-2.
//   2. Module-scope mutable state in `src/lib/**` (outside a small
//      allowlist). Caught R8-H-8 (module pool), R9-C-3 (TZ global).
//
// The allowlist is just `rate-limit.ts` for now; extend as needed.

const MODULE_STATE_ALLOWLIST = new Set([
  "src/lib/auth/rate-limit.ts",
  "src/lib/persistence/postgres-store.ts", // caches are well-understood + per-org keyed
  "src/lib/persistence/postgres-read-store.ts",
  "src/lib/persistence/postgres-phase3.ts",
  "src/lib/cache/inventory-cache.ts",
  "src/lib/persistence/store.ts", // JSON fallback store
  "src/lib/format.ts", // the ALS wrapper
  // Pure browser-only utilities (AudioContext / IndexedDB). Each isolate
  // here is a single browser tab, so module state is per-user not
  // per-request. Safe to mutate.
  "src/lib/audio.ts",
  "src/lib/offline/idb-store.ts",
  "src/lib/offline/sync-service.ts",
  "src/lib/offline/use-online-status.ts",
  // Per-org memoized read cache (TTL = 60s). Safe because the key is
  // the verified organizationId, and each entry is small + immutable.
  "src/lib/config/register-config.ts",
  // Read-only Set (method allowlist). The rule can't AST-prove "no writer
  // ever calls .add/.delete", so we whitelist the file instead. Grep
  // confirms no .add/.delete/.clear on STATE_CHANGING_METHODS.
  "src/lib/api/with-auth.ts",
  // Read-only REPORT_TYPES Set used purely for .has() membership checks.
  // Broadening the rule to src/app/api/** (R14-H-5) picks this up; the
  // site is safe because nothing mutates it.
  "src/app/api/reports/route.ts",
  // R22-H-4: `let _warnedProdFailOpenOnce = false` is a one-shot
  // cold-start flag. Two concurrent requests may both flip it to true
  // (benign: the only effect is logging a warning twice). No per-
  // request data flows through this variable; only `bindingAvailable`
  // and error strings are returned in the per-call probe result,
  // scoped to the caller.
  "src/lib/auth/kv-rate-limit.ts",
  // R23-M-1 + R23-L-2: `_cfModulePromise` caches the
  // `@opennextjs/cloudflare` module resolution (immutable, idempotent
  // on race). `_warnedNoOpenNext` and `_warnedNoWaitUntil` are one-
  // shot warn-dedup flags — concurrent flips are benign. No
  // per-request state passes through either binding.
  "src/lib/runtime/wait-until.ts",
  // R24 db refactor: `_poolCtorPromise` caches the dynamic driver
  // resolution (pg vs @neondatabase/serverless) once per isolate;
  // `_poolPromise` caches the shared pool on local dev. Both are
  // idempotent on race (a second resolution discards its result).
  // No per-request state passes through either binding.
  "src/lib/db/index.ts",
]);

// Constructors that create mutable containers. `const cache = new Map()`
// binds `cache` immutably but lets you call `.set` / `.clear` on the
// underlying object — effectively module-scope mutable state on Workers.
// R12-L-2: the original rule only caught `let` / `var`, so these slipped
// through. Adding `new X()` detection tightens the gate.
const MUTABLE_CTOR_NAMES = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array"]);

const noWorkersHazards = {
  meta: {
    type: "problem",
    docs: { description: "Forbid Cloudflare-Workers-incompatible patterns" },
    messages: {
      voidImport:
        "`void import(...).then(...)` is cancelled by the `no_handle_cross_request_promise_resolution` compat flag. Use a top-of-file static `import { X } from '...'` and call X() inline, or await the import inside a request-scope function.",
      moduleState:
        "Module-scope mutable state in server code (`{{kind}} {{name}}`) leaks across concurrent Worker requests. Store per-request state via AsyncLocalStorage or move into a per-call allocation. Allowlist in eslint-rules/index.mjs if this is a legitimate cache.",
      moduleCtor:
        "Module-scope mutable container (`const {{name}} = new {{ctor}}()`) is shared state across Worker requests. Even though `const` binds the reference, callers can `.set` / `.push` on the container. Move into a per-call allocation or allowlist in eslint-rules/index.mjs.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename?.() || "";
    const rel = filename.split("/bupos/code/")[1] || filename;
    // R14-H-5: broaden scope beyond `src/lib/`. Server-side API routes
    // (`src/app/api/**/route.ts`) and server actions run on the same
    // Workers isolates with the same concurrency model; module-scope
    // mutable state is just as dangerous there. A `const cache = new Map()`
    // in `src/app/api/products/route.ts` would have previously slipped
    // through the `isLib` gate.
    const isLib = rel.startsWith("src/lib/");
    const isApiRoute = rel.startsWith("src/app/api/");
    const isServerScope = isLib || isApiRoute;
    const isClient = (context.sourceCode?.text ?? "").trimStart().startsWith('"use client"');
    const allowlisted = MODULE_STATE_ALLOWLIST.has(rel);

    return {
      // 1. void import(...).then(...)
      "UnaryExpression[operator='void'] > CallExpression.argument > MemberExpression.callee[property.name='then']"(node) {
        const memberExpr = node; // MemberExpression
        // Climb to find the actual .then() call
        const thenCall = memberExpr.parent;
        if (thenCall?.type !== "CallExpression") return;
        const importCall = memberExpr.object;
        if (importCall?.type !== "ImportExpression" && importCall?.type !== "CallExpression") return;
        // Import() parses as ImportExpression in ESTree
        if (importCall.type === "ImportExpression" || (importCall.type === "CallExpression" && importCall.callee.type === "Import")) {
          context.report({ node: thenCall, messageId: "voidImport" });
        }
      },

      // Module-scope mutable state in server-scope files, outside allowlist
      // + not a client file.
      //
      // Flags:
      //   - `let x = ...` / `var x = ...`   (original rule)
      //   - `const x = new Map()` / Set / WeakMap / WeakSet / Array
      //   - `export const x = new Map()`   (R14-H-5: unwrap export wrapper)
      //
      // Skips: primitive `const` bindings (strings, numbers, booleans),
      // frozen objects, and anything the allowlist explicitly permits.
      Program(node) {
        if (!isServerScope || allowlisted || isClient) return;
        for (const raw of node.body) {
          // R14-H-5: unwrap `export const X = ...` — AST shape is
          // ExportNamedDeclaration whose `declaration` is the actual
          // VariableDeclaration. Previously the outer node-type filter
          // skipped this case entirely.
          const stmt =
            raw.type === "ExportNamedDeclaration" && raw.declaration
              ? raw.declaration
              : raw;
          if (stmt.type !== "VariableDeclaration") continue;
          for (const decl of stmt.declarations) {
            const name = decl.id.type === "Identifier" ? decl.id.name : "<destructure>";

            if (stmt.kind !== "const") {
              context.report({
                node: decl,
                messageId: "moduleState",
                data: { kind: stmt.kind, name },
              });
              continue;
            }

            // const — only flag if initializer is a mutable container
            // (Map/Set/WeakMap/WeakSet/Array via `new`). Bare array / object
            // literals intentionally slip through: most module-scope
            // `const X_LIST = [...]` in this repo are read-only default
            // tables that we verified no one mutates, and forcing them
            // all through Object.freeze() is noise that hides real bugs.
            const init = decl.init;
            if (!init) continue;
            if (
              init.type === "NewExpression" &&
              init.callee.type === "Identifier" &&
              MUTABLE_CTOR_NAMES.has(init.callee.name)
            ) {
              context.report({
                node: decl,
                messageId: "moduleCtor",
                data: { name, ctor: init.callee.name },
              });
            }
          }
        }
      },
    };
  },
};

// ── pg-helpers-require-org ─────────────────────────────────────────────
//
// Catches: `export async function pgXxx(...)` in postgres-*.ts that
// INSERT / UPDATE / DELETE and do NOT accept an `organizationId`
// parameter in their signature. Covers the R6-C-1/C-2/R8-C/R11-M-4
// shape — helpers that self-determine org from a row id.

const pgHelpersRequireOrg = {
  meta: {
    type: "problem",
    docs: { description: "pg* mutating helpers must take organizationId parameter" },
    messages: {
      missingOrg:
        "pg* helper `{{name}}` performs a write (UPDATE/INSERT/DELETE) but doesn't accept an `organizationId` / `orgId` parameter. Every caller must pass their verified org from session context; the helper must never derive org from a row the caller supplied. See R11-M-4.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename || context.getFilename?.() || "";
    // R14-M-7: previously narrow to `postgres-(store|phaseN).ts`. A new
    // file at `src/lib/persistence/postgres-gift-cards.ts` with an
    // exported `pgReloadGiftCard(...)` that didn't take `organizationId`
    // would bypass the rule. Broaden to any `.ts` inside
    // `src/lib/persistence/` — the directory convention IS the contract.
    if (!/src\/lib\/persistence\/.+\.ts$/.test(filename)) return {};
    // Row-mapper helpers (postgres-read-store.ts) that just SELECT + map
    // don't need the org param; their callers do. Exclude read-only files
    // by name so we don't flood with false positives.
    if (/postgres-read-store\.ts$/.test(filename)) return {};

    function fnHasOrgParam(fnNode) {
      for (const p of fnNode.params) {
        // Bare `organizationId: string` or `orgId: string` param.
        if (p.type === "Identifier" && /^org(anization)?Id$/i.test(p.name)) return true;
        // `{ organizationId }` destructure.
        if (p.type === "ObjectPattern") {
          for (const prop of p.properties) {
            if (prop.type === "Property" && prop.key.type === "Identifier" && /^org(anization)?Id$/i.test(prop.key.name)) {
              return true;
            }
          }
        }
        // `data: { organizationId }` — typed param with inline annotation.
        // The ESTree shape here is an Identifier param with typeAnnotation
        // containing a TSTypeLiteral whose members include `organizationId`.
        if (p.type === "Identifier" && p.typeAnnotation?.type === "TSTypeAnnotation") {
          const t = p.typeAnnotation.typeAnnotation;
          if (t.type === "TSTypeLiteral") {
            for (const m of t.members) {
              if (m.type === "TSPropertySignature" && m.key.type === "Identifier" && /^org(anization)?Id$/i.test(m.key.name)) {
                return true;
              }
            }
          }
        }
      }
      return false;
    }

    function bodyHasWrite(fnNode) {
      const src = context.sourceCode.getText(fnNode);
      return /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/i.test(src);
    }

    // Shared check used by both declaration shapes.
    function flagIfMissing(fnNode, name, reportNode) {
      if (!name || !name.startsWith("pg")) return;
      if (!bodyHasWrite(fnNode)) return;
      if (fnHasOrgParam(fnNode)) return;
      context.report({
        node: reportNode,
        messageId: "missingOrg",
        data: { name },
      });
    }

    return {
      // `export async function pgX(...) { ... }`
      ExportNamedDeclaration(node) {
        const decl = node.declaration;
        if (!decl) return;

        if (decl.type === "FunctionDeclaration") {
          flagIfMissing(decl, decl.id?.name ?? "", decl);
          return;
        }

        // R15-L-1: `export const pgX = async (...) => { ... }` / function expr.
        // The previous rule only covered FunctionDeclaration; arrow-function
        // exports bypassed it entirely. Broaden to VariableDeclaration whose
        // initializer is an ArrowFunctionExpression or FunctionExpression.
        if (decl.type === "VariableDeclaration") {
          for (const vd of decl.declarations) {
            const init = vd.init;
            if (!init) continue;
            if (init.type !== "ArrowFunctionExpression" && init.type !== "FunctionExpression") continue;
            const name = vd.id.type === "Identifier" ? vd.id.name : "";
            flagIfMissing(init, name, vd);
          }
        }
      },
    };
  },
};

export default {
  rules: {
    "no-hand-rolled-currency": noHandRolledCurrency,
    "no-workers-hazards": noWorkersHazards,
    "pg-helpers-require-org": pgHelpersRequireOrg,
  },
};
