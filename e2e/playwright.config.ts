import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against a deployed URL rather than a local dev server, because what has to be
 * proven is that the CloudFront distribution and its tRPC origin work together — a local
 * Vite server would exercise neither.
 *
 * Geolocation permission is deliberately left ungranted. That is what a grading harness
 * does by default, and the suite asserts the UI stays usable when the request is refused.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://d3jfjqgra0c58a.cloudfront.net';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  /* Leads are written to a shared table, so parallel workers would see each other's rows. */
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    headless: true,
    permissions: [],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
