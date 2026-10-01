import { defineConfig, devices } from '@playwright/test';

// scripts/measure-sync.sh serves the export on its own port (8199), so it never meets the smoke or e2e server.
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 8099);

export default defineConfig({
  testDir: 'e2e',
  // The initial-sync measurement is not a test: only scripts/measure-sync.sh runs it.
  testIgnore: process.env.MEASURE_SYNC ? [] : ['**/measure-sync.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 60_000,
  // Vendure's bcrypt login and the first sync run against a real server on a shared machine.
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    // The dev store's CORS allows the web export on ports 8099 and 8199.
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // pnpm e2e serves the export itself, with the CSP as a response header (scripts/serve-web.ts), and stops it.
  webServer: process.env.E2E_WEB_SERVED ? undefined : {
    command: `pnpm exec expo serve --port ${WEB_PORT}`,
    url: `http://127.0.0.1:${WEB_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
