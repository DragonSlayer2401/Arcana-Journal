import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  respectGitIgnore: true,
  testMatch: ['tests/*.spec.ts', 'src/features/**/__tests__/**/*.spec.ts'],
  testIgnore: 'ServiceWorkerUpdate.spec.ts',
  fullyParallel: true,
  workers: 3,
  timeout: 45_000,
  expect: { timeout: 12_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1050 } },
    },
    { name: 'mobile-chromium', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
});
