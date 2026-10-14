import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  timeout: 120_000,
  workers: 1,
  // A fresh disposable profile on retry avoids intermittent Electron/CDP
  // startup handshakes on hosted Windows. Retain the failed attempt's trace.
  retries: process.env.CI ? 1 : 0,
  outputDir: ".runtime/playwright-results",
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
