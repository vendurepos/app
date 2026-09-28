import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  use: {
    // The dev store's CORS allows the web export on port 8099.
    baseURL: 'http://127.0.0.1:8099',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'pnpm exec expo serve --port 8099',
    url: 'http://127.0.0.1:8099',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
