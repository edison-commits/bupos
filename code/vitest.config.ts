import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // `e2e/` holds Playwright specs; those are driven by `npm run test:e2e`
    // and import from `@playwright/test` which doesn't play well with
    // vitest. Exclude them from the vitest glob.
    exclude: ["node_modules", "e2e/**", ".open-next*/**", "dist/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
