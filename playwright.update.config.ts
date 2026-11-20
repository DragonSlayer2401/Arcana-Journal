import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'update.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results/update',
  use: { baseURL: 'http://127.0.0.1:4175', trace: 'retain-on-failure', serviceWorkers: 'allow' },
  projects: [{ name: 'update-chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tests/update-server.mjs',
    url: 'http://127.0.0.1:4175/__test__/ready',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
