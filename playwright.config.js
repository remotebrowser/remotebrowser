import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The app is pointed at a stand-in browserfleet server rather than a real one,
// and that server sits on its answer for a moment so browsers.spec.js can prove
// the launch route returns without waiting for provisioning.
const MOCK_BROWSERFLEET_PORT = 8991;
const MOCK_BROWSERFLEET_URL = `http://127.0.0.1:${MOCK_BROWSERFLEET_PORT}`;
const MOCK_BROWSERFLEET_DELAY_MS = 1500;

// Fresh PGlite dir per run; a caller-provided PGLITE_DATA_DIR wins.
const createPgliteDataDir = () => mkdtempSync(join(tmpdir(), 'remotebrowser-e2e-pglite-'));
const pgliteDataDir = process.env.PGLITE_DATA_DIR || createPgliteDataDir();
const pgliteDataDirIsTemporary = !process.env.PGLITE_DATA_DIR;
process.env.PGLITE_DATA_DIR = pgliteDataDir;
process.env.PGLITE_DATA_DIR_CLEANUP = pgliteDataDirIsTemporary ? '1' : '0';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalTeardown: './tests/e2e/global-teardown.js',
  // Started in order, so the app comes up with somewhere to send its requests.
  webServer: [
    {
      command: 'node tests/e2e/mock-remotebrowser.js',
      url: `${MOCK_BROWSERFLEET_URL}/health`,
      env: {
        PORT: String(MOCK_BROWSERFLEET_PORT),
        MOCK_BROWSERFLEET_DELAY_MS: String(MOCK_BROWSERFLEET_DELAY_MS)
      },
      reuseExistingServer: !process.env.CI,
      timeout: 10000
    },
    {
      command: 'node src/index.js',
      url: 'http://localhost:3000/health',
      env: { BROWSERFLEET_URL: MOCK_BROWSERFLEET_URL, PGLITE_DATA_DIR: pgliteDataDir },
      // Never reuse a running server: it would carry the previous run's data.
      reuseExistingServer: false,
      timeout: 30000
    }
  ]
});
