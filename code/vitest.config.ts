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
      // The `server-only` / `client-only` marker packages resolve their
      // `default` export to a THROWING module unless the resolver sets the
      // `react-server` condition (Next.js does; plain node/vitest doesn't).
      // Alias them to an empty no-op so tests can import real
      // server-component code without "cannot be imported from a Client
      // Component" errors. The production build uses Next's own alias.
      "server-only": path.resolve(__dirname, "./test-stubs/empty-module.ts"),
      "client-only": path.resolve(__dirname, "./test-stubs/empty-module.ts"),
    },
  },
});
