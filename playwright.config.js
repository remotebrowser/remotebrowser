import { linkSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// One app serves both projects:
// - the `app` project covers the pages that need no browser;
// - the `qemu` project launches real Chromium VMs, skipping itself where QEMU
//   or the VM image is missing.

const APP_PORT = 3000;

// Fresh PGlite dir per run; a caller-provided PGLITE_DATA_DIR wins. Only a
// dir we created is cleaned up.
const providedDataDir = process.env.PGLITE_DATA_DIR;
const dataDir = providedDataDir || mkdtempSync(join(tmpdir(), 'remotebrowser-e2e-'));

// Its own VM data dir, so the tests see only the VMs this run started. It
// shares the image builds of every OS in the usual one through hard links, so
// it needs the same filesystem, and saves only its own snapshot. Without
// builds, the VM tests skip themselves.
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
  // Short, as QEMU's socket paths in it must fit Linux's limit (src/vm/layout.js).
  const dir = mkdtempSync(join(import.meta.dirname, '.data', 'e2e'));
  for (const os of listDir(join(usual, 'images'))) {
    const images = (root) => join(root, 'images', os.name);
    for (const build of os.isDirectory() ? listDir(images(usual)) : []) {
      if (build.isDirectory() && !build.name.startsWith('.')) {
        mkdirSync(join(images(dir), build.name), { recursive: true });
        for (const file of readdirSync(join(images(usual), build.name))) {
          linkSync(join(images(usual), build.name, file), join(images(dir), build.name, file));
        }
      }
    }
  }
  return dir;
};

// Workers load this config again, so they must reuse the dir, not make a new
// one.
const vmDataDir = process.env.E2E_VM_DATA_DIR || vmDataDirFor();

process.env.E2E_PGLITE_DIRS = JSON.stringify(providedDataDir ? [] : [dataDir]);
process.env.E2E_VM_DATA_DIR = vmDataDir;

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
    baseURL: `http://localhost:${APP_PORT}`,
    trace: 'on-first-retry'
  },
  globalTeardown: './tests/e2e/global-teardown.js',
  webServer: {
    command: 'node src/index.js',
    url: `http://localhost:${APP_PORT}/health`,
    env: { PGLITE_DATA_DIR: dataDir, PORT: String(APP_PORT), VM_DATA_DIR: vmDataDir },
    // Never reuse a running server: it would carry the previous run's data.
    reuseExistingServer: false,
    timeout: 30000
  },
  projects: [
    {
      name: 'app',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'qemu',
      testDir: './tests/e2e-vm',
      // A cold VM boot is slower than a container start, more so without KVM.
      timeout: 180000,
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
