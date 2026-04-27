import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  test: {
    // Each suite gets its own SQLite file so tests run isolated and parallel.
    // Suites that need it set SSR_DB_PATH in a beforeAll hook.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
})
