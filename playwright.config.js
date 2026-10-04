import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// One e2e run covers both provisioning paths:
// - the `mock` project points the app at a stand-in fleet (no containers), held
//   back on purpose so browsers.spec.js can prove the launch route returns
//   before provisioning finishes;
// - the `podman`/`docker` projects run the app in its default local mode and
//   launch real Chrome containers, skipping themselves where that runtime is
//   missing or cannot run containers.

const MOCK_BROWSERFLEET_PORT = 8991;
const MOCK_BROWSERFLEET_URL = `http://127.0.0.1:${MOCK_BROWSERFLEET_PORT}`;
const MOCK_BROWSERFLEET_DELAY_MS = 1500;

const MOCK_APP_PORT = 3000;
const CONTAINER_RUNTIMES = ['podman', 'docker'];

// Fresh PGlite dir per app instance; a caller-provided PGLITE_DATA_DIR wins and
// gets a per-instance suffix. Only dirs we created are cleaned up.
const providedDataDir = process.env.PGLITE_DATA_DIR;
const dataDirFor = (name) =>
  providedDataDir ? `${providedDataDir}-${name}` : mkdtempSync(join(tmpdir(), `remotebrowser-e2e-${name}-`));

const appServer = ({ port, dataDir, env }) => ({
  command: 'node src/index.js',
  url: `http://localhost:${port}/health`,
  env: { PGLITE_DATA_DIR: dataDir, PORT: String(port), ...env },
  // Never reuse a running server: it would carry the previous run's data.
  reuseExistingServer: false,
  timeout: 30000
});

const mockDataDir = dataDirFor('mock');
const containerServers = CONTAINER_RUNTIMES.map((runtime, index) => ({
  runtime,
  port: MOCK_APP_PORT + 1 + index,
  dataDir: dataDirFor(runtime)
}));

process.env.E2E_PGLITE_DIRS = JSON.stringify(
  providedDataDir ? [] : [mockDataDir, ...containerServers.map((server) => server.dataDir)]
);

export default defineConfig({
  testDir: './tests/e2e',
  // Real containers are heavy and the sign-in helper takes the newest nonce per
  // address, so run one test at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${MOCK_APP_PORT}`,
    trace: 'on-first-retry'
  },
  globalTeardown: './tests/e2e/global-teardown.js',
  // Started in order: the stand-in fleet first, then one app per project.
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
    appServer({ port: MOCK_APP_PORT, dataDir: mockDataDir, env: { BROWSERFLEET_URL: MOCK_BROWSERFLEET_URL } }),
    ...containerServers.map((server) =>
      appServer({
        port: server.port,
        dataDir: server.dataDir,
        env: {
          CONTAINER_RUNTIME: server.runtime,
          ...(process.env.CONTAINER_IMAGE ? { CONTAINER_IMAGE: process.env.CONTAINER_IMAGE } : {})
        }
      })
    )
  ],
  projects: [
    {
      name: 'mock',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${MOCK_APP_PORT}` }
    },
    ...containerServers.map((server) => ({
      name: server.runtime,
      testDir: './tests/e2e-container',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${server.port}`,
        containerRuntime: server.runtime
      }
    }))
  ]
});
