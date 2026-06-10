import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4174",
    browserName: "chromium",
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    timezoneId: "UTC",
    video: "retain-on-failure",
    viewport: { width: 1280, height: 900 },
  },
  webServer: [
    {
      command: "node ./tests/e2e/mock-gateway.cjs",
      url: "http://127.0.0.1:4010/readyz",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "npm run -w apps/frontend dev -- --host 127.0.0.1 --port 4174",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...process.env,
        VITE_GATEWAY_URL: "http://127.0.0.1:4010",
      },
    },
  ],
});
