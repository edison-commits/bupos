/**
 * R8-L-12: vitest config for the PG-backed integration suite.
 *
 * Separate from the unit config (`vitest.config.ts`) so:
 *   • `npm test` stays fast (no Docker dependency)
 *   • `npm run test:integration` targets only `src/__tests__/integration/*`
 *   • Integration tests run sequentially (no parallel — they share the
 *     same DB state, and the seed is deterministic only serially)
 *
 * Preconditions: `npm run docker:up && npm run docker:migrate` has run
 * against the Docker Postgres (see scripts + README).
 */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/integration/**/*.test.ts"],
    // Integration suite runs sequentially — each file targets the same
    // seeded DB and tests wrap mutations in ROLLBACK. Vitest 4 shuffled
    // poolOptions around; rather than chase the type churn, we just
    // disable parallelism via `fileParallelism: false` which is the
    // stable user-facing knob.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
