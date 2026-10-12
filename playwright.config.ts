import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  timeout: 120_000,
  workers: 1,
  outputDir: ".runtime/playwright-results",
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
