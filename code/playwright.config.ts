/**
 * Playwright config — R23 prevention push.
 *
 * Runs a small end-to-end suite against a live Next.js dev server
 * backed by the Docker Postgres. The primary motivation is to catch
 * bugs like R23-H-2 (createProductAction 500'd due to FK violation for
 * an unknown number of audit rounds because no test exercised the
 * admin product-creation path end-to-end).
 *
 * Conventions:
 *   • Tests assume Docker Postgres is already up + migrated. CI spins
 *     this up before invoking `npm run test:e2e`; locally run
 *     `npm run docker:up && npm run docker:migrate`.
 *   • A global-setup helper seeds an admin employee + credential so
 *     tests can log in via the standard /login form.
 *   • Uses Chromium only — cross-browser matrix is out of scope.
 *   • Sequential (fileParallelism=false) because tests share the DB.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3101);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  globalSetup: "./e2e/global-setup.ts",
  webServer: {
    command: `PORT=${PORT} USE_POSTGRES=true DATABASE_URL="postgresql://postgres:postgres@localhost:54329/bupos_test" npm run dev`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    // R24-H-1: bumped from 120s → 180s. Cold CI runner + Next 16
    // dev-server compile + OpenNext miniflare bootstrap + first DB
    // query can legitimately exceed 120s; 180s leaves headroom
    // without masking genuine startup failures (kept well under
    // Playwright's default test-file hangs).
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
