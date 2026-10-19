import { linkSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// One e2e run covers both provisioning paths:
// - the `mock` project points the app at a stand-in fleet (no VMs), held
//   back on purpose so browsers.spec.js can prove the launch route returns
//   before provisioning finishes;
// - the `qemu` project runs the app in its default local mode and launches real
//   Chromium VMs, skipping itself where QEMU or the VM image is missing.

const MOCK_BROWSERFLEET_PORT = 8991;
const MOCK_BROWSERFLEET_URL = `http://127.0.0.1:${MOCK_BROWSERFLEET_PORT}`;
const MOCK_BROWSERFLEET_DELAY_MS = 1500;

const MOCK_APP_PORT = 3000;

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

// Its own VM data dir, so the tests see only the VMs this run started. It
// shares the image builds of the usual one through hard links, so it needs
// the same filesystem, and saves only its own snapshot. Without builds, the
// VM tests skip themselves.
const listDir = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
const vmDataDirFor = () => {
  const usual = process.env.VM_DATA_DIR || join(import.meta.dirname, '.data', 'vm');
  mkdirSync(join(import.meta.dirname, '.data'), { recursive: true });
  const dir = mkdtempSync(join(import.meta.dirname, '.data', 'e2e-vm-'));
  for (const build of listDir(join(usual, 'images'))) {
    if (build.isDirectory() && !build.name.startsWith('.')) {
      mkdirSync(join(dir, 'images', build.name), { recursive: true });
      for (const file of readdirSync(join(usual, 'images', build.name))) {
        linkSync(join(usual, 'images', build.name, file), join(dir, 'images', build.name, file));
      }
    }
  }
  return dir;
};

const mockDataDir = dataDirFor('mock');
const vmServer = {
  port: MOCK_APP_PORT + 1,
  dataDir: dataDirFor('qemu'),
  // Workers load this config again, so they must reuse the dir, not make a
  // new one.
  vmDataDir: process.env.E2E_VM_DATA_DIR || vmDataDirFor()
};

process.env.E2E_PGLITE_DIRS = JSON.stringify(providedDataDir ? [] : [mockDataDir, vmServer.dataDir]);
process.env.E2E_VM_DATA_DIR = vmServer.vmDataDir;

export default defineConfig({
  testDir: './tests/e2e',
  // Real VMs are heavy and the sign-in helper takes the newest nonce per
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
    appServer({
      port: vmServer.port,
      dataDir: vmServer.dataDir,
      env: { VM_DATA_DIR: vmServer.vmDataDir }
    })
  ],
  projects: [
    {
      name: 'mock',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${MOCK_APP_PORT}` }
    },
    {
      name: 'qemu',
      testDir: './tests/e2e-vm',
      // A cold VM boot is slower than a container start, more so without KVM.
      timeout: 180000,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${vmServer.port}` }
    }
  ]
});
