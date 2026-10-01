import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  // Vendure's bcrypt login and the first sync run against a real server on a shared machine.
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    // The dev store's CORS allows the web export on port 8099.
    baseURL: 'http://127.0.0.1:8099',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // pnpm e2e serves the export itself, with the CSP as a response header (scripts/serve-web.ts), and stops it.
  webServer: process.env.E2E_WEB_SERVED ? undefined : {
    command: 'pnpm exec expo serve --port 8099',
    url: 'http://127.0.0.1:8099',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
