import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import localRules from "./eslint-rules/index.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: {
      local: localRules,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
      // React Compiler optimality hints — not correctness issues
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",

      // Pattern-guard rules. Each catches a shape that broke in an audit
      // round — see comments in eslint-rules/index.mjs.
      "local/no-hand-rolled-currency": "error",
      "local/no-workers-hazards": "error",
      "local/pg-helpers-require-org": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build artifacts from prior deploys / OpenNext
    ".next-old-*/**",
    ".open-next/**",
    ".open-next-old*/**",
    // Local rule source doesn't need to conform to its own rules
    "eslint-rules/**",
    // Dev / sim scripts — CommonJS-style smoke tests, not production code
    "scripts/smoke-test.js",
  ]),
]);

export default eslintConfig;
