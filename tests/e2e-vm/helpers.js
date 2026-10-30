import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

// Shared by the specs that launch real QEMU VMs. They need QEMU on PATH and a
// Debian 13 image build from vm/build-debian-13.sh, which playwright.config.js
// links into this run's own VM data dir.

const dataDir = process.env.E2E_VM_DATA_DIR || '';
const machinesDir = join(dataDir, 'machines');
const qemu = process.arch === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64';
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';

const listDir = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// Checked once, so a host without QEMU or the image skips instead of failing.
let usable;
const qemuUsable = () => {
  if (usable === undefined) {
    try {
      execFileSync(qemu, ['--version'], { stdio: 'ignore', timeout: 20000 });
      usable =
        Boolean(dataDir) && listDir(join(dataDir, 'images', 'debian-13')).some((name) => name.startsWith(`${arch}-`));
    } catch {
      usable = false;
    }
  }
  return usable;
};

const listBrowserVms = () => listDir(machinesDir);

const qemuPid = (name) => Number.parseInt(readFileSync(join(machinesDir, name, 'qemu.pid'), 'utf8'), 10);

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const requestSignInLink = async (page, email) => {
  await page.goto('/signin');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('To sign in, click the link sent to')).toBeVisible();
};

// Relative to the project's baseURL, so it talks to the app that runs VMs.
const fetchLatestNonce = async (page, email) => {
  const response = await page.request.get(`/dev/nonces?email=${encodeURIComponent(email)}`);
  const { nonce } = await response.json();
  return nonce;
};

const signIn = async (page, email) => {
  await requestSignInLink(page, email);
  const nonce = await fetchLatestNonce(page, email);
  await page.goto(`/continue?nonce=${nonce}`);
  await page.getByRole('button', { name: 'Sign In' }).click();
};

// Launches through the real UI and returns the new browser's public id.
const launchBrowser = async (page, name, { proxy, os } = {}) => {
  await page.goto('/browsers/launch');
  await page.locator('#name').fill(name);
  if (os) {
    await page.getByLabel(os, { exact: true }).check();
  }
  if (proxy) {
    await page.getByLabel('Use proxy').check();
    await page.getByLabel('Proxy URL').fill(proxy);
  }
  await page.getByRole('button', { name: 'Launch' }).click();
  await expect(page).toHaveURL(/\/browsers\/B[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);
  return new URL(page.url()).pathname.split('/').pop();
};

const terminateBrowser = async (page, publicId, name) => {
  await page.goto(`/browsers/${publicId}/terminate`);
  await page.locator('#name').fill(name);
  await page.getByRole('button', { name: 'Terminate' }).click();
  await expect(page.getByText(`${name} is terminated`)).toBeVisible({ timeout: 60000 });
};

// Skips the suite on a host without QEMU, waits for the VM snapshot, and
// kills any VM a test leaves behind. Call it at the top of a spec, or in a
// test.describe.
const useQemuVms = () => {
  // The app saves its snapshot in the background after it starts, and new
  // browsers start only from it.
  test.beforeAll(async () => {
    test.skip(!qemuUsable(), `requires ${qemu} and a VM image build for ${arch} on this host`);
    test.setTimeout(300000);
    await expect
      .poll(() => existsSync(join(dataDir, 'snapshots', 'debian-13', 'machine.json')), {
        timeout: 280000,
        intervals: [1000]
      })
      .toBe(true);
  });

  // Safety net: a test that does not terminate its browser, or fails before it
  // does, must not leak a running VM, nor a VM dir that the next test counts.
  test.afterEach(() => {
    for (const name of listBrowserVms()) {
      try {
        process.kill(qemuPid(name), 'SIGKILL');
      } catch {
        // Already gone.
      }
      rmSync(join(machinesDir, name), { recursive: true, force: true });
    }
  });
};

export {
  dataDir,
  arch,
  machinesDir,
  listBrowserVms,
  qemuPid,
  isAlive,
  signIn,
  launchBrowser,
  terminateBrowser,
  useQemuVms
};
