import { defineConfig, devices } from "@playwright/test";

const PORT = 4317;

/**
 * Browser-level tests for Clasp Studio.
 *
 * By default Playwright's bundled Chromium is used (`pnpm exec playwright
 * install chromium` once). Set CLASP_E2E_CHANNEL=chrome to run in an
 * installed Google Chrome instead and skip that download.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        ...(process.env.CLASP_E2E_CHANNEL ? { channel: process.env.CLASP_E2E_CHANNEL } : {}),
      },
    },
  ],
  webServer: {
    // Vite serves the Studio (and the workspace packages as source) directly.
    command: `node node_modules/vite/bin/vite.js apps/studio --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
