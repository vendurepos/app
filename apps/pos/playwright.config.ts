import { defineConfig, devices } from '@playwright/test';

// scripts/measure-sync.sh serves the export on its own port (8199), so it never meets the smoke or e2e server.
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 8099);
// pnpm e2e:hosted points the specs at a hosted build (scripts/e2e-hosted.sh); nothing is served locally then.
const BASE_URL = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  // The demo build's spec runs alone, against the demo export (scripts/e2e-demo.sh); never against a normal build.
  testMatch: process.env.E2E_DEMO ? ['**/demo.spec.ts'] : undefined,
  // The initial-sync measurement is not a test: only scripts/measure-sync.sh runs it.
  testIgnore: process.env.E2E_DEMO ? [] : process.env.MEASURE_SYNC ? ['**/demo.spec.ts'] : ['**/measure-sync.spec.ts', '**/demo.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 60_000,
  // Vendure's bcrypt login and the first sync run against a real server on a shared machine.
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    // The dev store's CORS allows the web export on ports 8099 and 8199.
    baseURL: BASE_URL ?? `http://127.0.0.1:${WEB_PORT}`,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // pnpm e2e serves the export itself, with the CSP as a response header (scripts/serve-web.ts), and stops it.
  webServer: process.env.E2E_WEB_SERVED || BASE_URL ? undefined : {
    command: `pnpm exec expo serve --port ${WEB_PORT}`,
    url: `http://127.0.0.1:${WEB_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
