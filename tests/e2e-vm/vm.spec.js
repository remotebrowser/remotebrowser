import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import {
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
} from './helpers.js';

// End-to-end against real QEMU VMs. Each test drives the UI to launch a
// browser, then inspects the VM state dir and the QEMU process directly to
// prove Chromium is actually running (and, for the CDP test, actually answering).
// See helpers.js for what the host needs.

const readdirSafe = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// The first bytes a VNC server sends are its RFB protocol version.
const rfbGreeting = (port) =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => socket.setTimeout(10000));
    socket.once('data', (data) => {
      socket.destroy();
      resolve(data.toString('latin1', 0, 12));
    });
    socket.once('timeout', () => socket.destroy(new Error('no RFB greeting')));
    socket.once('error', reject);
  });

// The guest cannot reach the host's loopback, but it can reach the host's
// other addresses, as it would a proxy elsewhere on the network.
const hostAddress = () =>
  Object.values(networkInterfaces())
    .flat()
    .find((info) => info && info.family === 'IPv4' && !info.internal)?.address;

// A stand-in upstream proxy that records each CONNECT and refuses it.
const startUpstreamProxy = (address) =>
  new Promise((resolve) => {
    const seen = [];
    const server = createServer((req, res) => res.writeHead(502).end());
    server.on('connect', (req, socket) => {
      seen.push({ target: req.url, auth: req.headers['proxy-authorization'] ?? null });
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    server.listen(0, address, () => resolve({ seen, port: server.address().port, close: () => server.close() }));
  });

test.describe('real QEMU VMs', () => {
  useQemuVms();

  test('launching a browser really starts a Chromium VM, and terminating it removes it', async ({ page }) => {
    await signIn(page, 'e2e-qemu-lifecycle@example.com');
    await expect(page).toHaveURL('/');

    const browserName = 'e2e-qemu-otter';
    const publicId = await launchBrowser(page, browserName);

    // The status line self-refreshes every 3s; wait until the VM has booted
    // and the app has flipped the browser to running.
    await expect(page.locator('#browser-status')).toContainText('running', { timeout: 150000 });
    await expect(page.locator('#browser-connection-info')).toContainText('Copy instructions', { timeout: 60000 });

    const created = listBrowserVms();
    expect(created, 'exactly one new Chromium VM should exist').toHaveLength(1);
    const vm = created[0];
    expect(vm).toMatch(/^Q[23456789abcdefghijkmnpqrstuvwxyz]{8}$/);
    const pid = qemuPid(vm);
    expect(isAlive(pid)).toBe(true);

    // The display is viewable over VNC, on the loopback port the app recorded.
    const vncPort = Number(readFileSync(join(machinesDir, vm, 'vnc-port'), 'utf8'));
    expect(await rfbGreeting(vncPort)).toBe('RFB 003.008\n');

    await terminateBrowser(page, publicId, browserName);
    await expect.poll(() => listBrowserVms().includes(vm), { timeout: 30000 }).toBe(false);
    await expect.poll(() => isAlive(pid), { timeout: 30000 }).toBe(false);
  });

  test('a browser launched on Ubuntu 26.04 runs on its own snapshot and answers over CDP', async ({ page }) => {
    const ubuntuBuilt = readdirSafe(join(dataDir, 'images', 'ubuntu-26.04')).some((name) =>
      name.startsWith(`${arch}-`)
    );
    test.skip(!ubuntuBuilt, 'requires an Ubuntu 26.04 image build from vm/build-ubuntu-26.04.sh');
    test.setTimeout(300000);
    // The app saves this snapshot in the background too, after Debian's or alongside it.
    await expect
      .poll(() => existsSync(join(dataDir, 'snapshots', 'ubuntu-26.04', 'machine.json')), {
        timeout: 120000,
        intervals: [1000]
      })
      .toBe(true);

    await signIn(page, 'e2e-qemu-ubuntu@example.com');
    const browserName = 'e2e-qemu-ubuntu-otter';
    const publicId = await launchBrowser(page, browserName, { os: 'Ubuntu 26.04' });
    await expect(page.locator('#browser-status')).toContainText('running', { timeout: 150000 });
    await expect(page.locator('a.page-preview-link').first()).toBeVisible({ timeout: 60000 });

    const [vm] = listBrowserVms();
    expect(JSON.parse(readFileSync(join(machinesDir, vm, 'machine.json'), 'utf8')).os).toBe('ubuntu-26.04');

    await terminateBrowser(page, publicId, browserName);
  });

  test('the running browser answers over CDP and streams a real screenshot', async ({ page }) => {
    await signIn(page, 'e2e-qemu-cdp@example.com');
    const browserName = 'e2e-qemu-cdp-otter';
    const publicId = await launchBrowser(page, browserName);
    await expect(page.locator('#browser-status')).toContainText('running', { timeout: 150000 });
    // The preview only renders after the app has listed the browser's page
    // targets over CDP, so its presence proves Chrome is answering.
    // The link, not the image: htmx soon swaps the <img> for a live <canvas>.
    const preview = page.locator('a.page-preview-link').first();
    await expect(preview).toBeVisible({ timeout: 60000 });
    const href = await preview.getAttribute('href');

    // The first read may get the PNG placeholder while the capture runs.
    let shot;
    await expect
      .poll(
        async () => {
          shot = await page.request.get(`${href}/view`);
          return shot.headers()['content-type'];
        },
        { timeout: 30000 }
      )
      .toBe('image/jpeg');
    expect(shot.status()).toBe(200);
    const jpeg = await shot.body();
    // JPEG magic number: a real render, not an error page.
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    await terminateBrowser(page, publicId, browserName);
  });

  test('the launch form refuses a proxy URL it cannot use, before any VM starts', async ({ page }) => {
    await signIn(page, 'e2e-qemu-bad-proxy@example.com');
    await page.goto('/browsers/launch');
    await page.locator('#name').fill('e2e-qemu-lost-otter');
    // The URL input is off until the box is checked.
    await expect(page.getByLabel('Proxy URL')).toBeDisabled();
    await page.getByLabel('Use proxy').check();
    await expect(page.getByLabel('Proxy URL')).toBeEnabled();
    await expect(page.getByLabel('Proxy URL')).toBeFocused();
    await page.getByLabel('Proxy URL').fill('https://proxy.example.com:443');
    await page.getByRole('button', { name: 'Launch' }).click();
    await expect(page.getByRole('alert')).toContainText('The proxy URL must start with http://');
    await expect(page.locator('#proxy')).toHaveValue('https://proxy.example.com:443');
    expect(listBrowserVms()).toHaveLength(0);
  });

  test('a browser launched with a proxy sends its traffic through it', async ({ page }) => {
    const address = hostAddress();
    test.skip(!address, 'requires a non-loopback IPv4 address on this host');
    const upstream = await startUpstreamProxy(address);
    try {
      await signIn(page, 'e2e-qemu-proxy@example.com');
      const browserName = 'e2e-qemu-proxied-otter';
      const publicId = await launchBrowser(page, browserName, {
        proxy: `http://alice:s3cret@${address}:${upstream.port}`
      });
      await expect(page.locator('#browser-status')).toContainText('running', { timeout: 150000 });
      // The browser opens a search engine at launch, over HTTPS.
      await expect
        .poll(() => upstream.seen.filter(({ target }) => target.endsWith(':443')).length, { timeout: 60000 })
        .toBeGreaterThan(0);
      expect(upstream.seen[0].auth).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
      await terminateBrowser(page, publicId, browserName);
    } finally {
      upstream.close();
    }
  });

  test('suspending a browser stops its VM, and resuming brings back the same pages', async ({ page }) => {
    await signIn(page, 'e2e-qemu-suspend@example.com');
    const browserName = 'e2e-qemu-sleepy-otter';
    const publicId = await launchBrowser(page, browserName);
    await expect(page.locator('#browser-status')).toContainText('running', { timeout: 150000 });
    // Each preview links to its page by CDP target id, which only the same
    // Chrome process, carried on, would still have.
    const pageLink = page.locator('a.page-preview-link').first();
    await expect(pageLink).toBeVisible({ timeout: 60000 });
    const pageHref = await pageLink.getAttribute('href');
    const [vm] = listBrowserVms();
    const pid = qemuPid(vm);
    // Compressed with zstd where the host has it.
    const savedState = join(machinesDir, vm, 'suspended.state');
    const hasSavedState = () => existsSync(savedState) || existsSync(`${savedState}.zst`);

    const suspend = async () => {
      await page.getByRole('link', { name: 'Suspend' }).click();
      await expect(page).toHaveURL(`/browsers/${publicId}/suspend`);
      await expect(page.getByText('cannot be undone')).toHaveCount(0);
      await page.getByRole('button', { name: 'Suspend' }).click();
      await expect(page.getByText('Suspending...')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Suspend' })).toBeHidden();
      // Saving the VM's memory takes a while.
      await expect(page).toHaveURL(`/browsers/${publicId}`, { timeout: 120000 });
      await expect(page.locator('#browser-status')).toContainText('suspended');
      await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
    };

    await suspend();
    expect(isAlive(pid), 'QEMU should exit, which frees the VM memory').toBe(false);
    expect(hasSavedState()).toBe(true);

    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByText('Resuming...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume' })).toBeHidden();
    await expect(page).toHaveURL(`/browsers/${publicId}`, { timeout: 60000 });
    await expect(page.locator('#browser-status')).toContainText('running', { timeout: 60000 });
    await expect(page.locator('#browser-connection-info')).toContainText('Copy instructions');
    await expect(page.locator(`a.page-preview-link[href="${pageHref}"]`)).toBeVisible({ timeout: 60000 });
    expect(isAlive(qemuPid(vm))).toBe(true);
    expect(hasSavedState(), 'the saved state is stale once the VM runs again').toBe(false);

    // A suspended browser can still be terminated.
    await suspend();
    await terminateBrowser(page, publicId, browserName);
    await expect.poll(() => listBrowserVms().includes(vm), { timeout: 30000 }).toBe(false);
  });
});
