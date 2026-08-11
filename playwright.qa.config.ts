import { defineConfig, devices } from "@playwright/test";

const port = process.env.PASEO_PORT ?? "5173";
const baseURL = (process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.qa.pw.ts",
  globalSetup: "./e2e/qa.global-setup.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "playwright-report-qa" }]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report-qa" }]],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: "test-results/qa",
  workers: 2,
  use: {
    baseURL,
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "pnpm dev:service",
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
