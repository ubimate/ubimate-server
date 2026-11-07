import { defineConfig, devices } from '@playwright/test';

// The admin app against a faked API (each spec routes the requests it needs). Port 5391, not 5173:
// 5173 is often the web app or a running tauri dev, and Playwright would reuse whatever is there.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5391',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'vite --port 5391 --strictPort',
    url: 'http://localhost:5391',
    reuseExistingServer: false,
  },
});
