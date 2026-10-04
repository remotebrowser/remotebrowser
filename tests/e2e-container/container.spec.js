import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { test as base, expect } from '@playwright/test';

// End-to-end against a real container runtime. Playwright runs this file once per
// project (podman, docker); each test drives the UI to launch a browser, then
// inspects the host's containers directly to prove Chrome is actually running
// (and, for the CDP test, actually answering). Needs the runtime's CLI on PATH;
// the CONTAINER_IMAGE is pulled on first use.

const execFileAsync = promisify(execFile);
const CONTAINER_PREFIX = 'chrome-';

// The runtime under test, set per project in playwright.container.config.js.
const test = base.extend({ containerRuntime: ['podman', { option: true }] });

// Whether a runtime can run containers here, checked once per runtime so a host
// without it skips instead of failing.
const usable = new Map();
const runtimeUsable = (runtime) => {
  if (!usable.has(runtime)) {
    let ok = false;
    try {
      execFileSync(runtime, ['info'], { stdio: 'ignore', timeout: 20000 });
      ok = true;
    } catch {
      ok = false;
    }
    usable.set(runtime, ok);
  }
  return usable.get(runtime);
};

const runtime = async (binary, args) => {
  const { stdout } = await execFileAsync(binary, args);
  return stdout.trim();
};

// `ps`/`inspect`/`rm` share the same CLI shape for podman and docker. On an
// unusable runtime this returns nothing rather than throwing, so the cleanup
// hooks stay safe while the tests themselves skip.
const listBrowserContainers = async (binary) => {
  try {
    const stdout = await runtime(binary, ['ps', '--format', '{{.Names}}']);
    return stdout
      .split('\n')
      .map((name) => name.trim())
      .filter((name) => name.startsWith(CONTAINER_PREFIX));
  } catch {
    return [];
  }
};

const requestSignInLink = async (page, email) => {
  await page.goto('/signin');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('To sign in, click the link sent to')).toBeVisible();
};

// Relative to the project's baseURL, so each runtime variant talks to its own app.
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
const launchBrowser = async (page, name) => {
  await page.goto('/browsers/launch');
  await page.locator('#name').fill(name);
  await page.getByRole('button', { name: 'Launch' }).click();
  await expect(page).toHaveURL(/\/browsers\/B[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);
  return new URL(page.url()).pathname.split('/').pop();
};

const terminateBrowser = async (page, publicId, name) => {
  await page.goto(`/browsers/${publicId}/terminate`);
  await page.locator('#name').fill(name);
  await page.getByRole('button', { name: 'Terminate' }).click();
  await expect(page).toHaveURL('/browsers');
};

// Containers present before the project's tests, so cleanup never touches a
// browser the user already had running.
let baseline = [];

test.describe('real container runtime', () => {
  test.beforeEach(({ containerRuntime }) => {
    test.skip(!runtimeUsable(containerRuntime), `requires a working ${containerRuntime} runtime on this host`);
  });

  test.beforeAll(async ({ containerRuntime }) => {
    baseline = await listBrowserContainers(containerRuntime);
  });

  // Safety net: remove only containers created during this project. The happy
  // path terminates through the UI, but a failing assertion must not leak one.
  test.afterEach(async ({ containerRuntime }) => {
    const remaining = await listBrowserContainers(containerRuntime);
    for (const name of remaining) {
      if (!baseline.includes(name)) {
        await runtime(containerRuntime, ['rm', '-f', name]).catch(() => {});
      }
    }
  });

  test('launching a browser really starts a Google Chrome container, and terminating it removes it', async ({
    page,
    containerRuntime
  }) => {
    await signIn(page, `e2e-${containerRuntime}-lifecycle@example.com`);
    await expect(page).toHaveURL('/');

    const browserName = `e2e-${containerRuntime}-otter`;
    const publicId = await launchBrowser(page, browserName);

    // The connection info panel only renders once the app has recorded the
    // container id, which it does after `<runtime> run` returns.
    await expect(page.locator('#browser-connection-info')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('#browser-status')).toContainText('running');

    const created = (await listBrowserContainers(containerRuntime)).filter((name) => !baseline.includes(name));
    expect(created, 'exactly one new Google Chrome container should exist').toHaveLength(1);
    const container = created[0];
    const prefix = containerRuntime === 'docker' ? 'D' : 'P';
    expect(container).toMatch(new RegExp(`^chrome-${prefix}[23456789abcdefghijkmnpqrstuvwxyz]{8}$`));
    await expect
      .poll(() => runtime(containerRuntime, ['inspect', '--format', '{{.State.Running}}', container]))
      .toBe('true');

    await terminateBrowser(page, publicId, browserName);
    await expect
      .poll(async () => (await listBrowserContainers(containerRuntime)).includes(container), { timeout: 30000 })
      .toBe(false);
  });

  test('the running browser answers over CDP and streams a real screenshot', async ({ page, containerRuntime }) => {
    await signIn(page, `e2e-${containerRuntime}-cdp@example.com`);
    const browserName = `e2e-${containerRuntime}-cdp-otter`;
    const publicId = await launchBrowser(page, browserName);
    await expect(page.locator('#browser-connection-info')).toBeVisible({ timeout: 60000 });

    // The preview only renders after the app has listed the browser's page
    // targets over CDP, so its presence proves Chrome is answering.
    const preview = page.locator('img.browser-screenshot').first();
    await expect(preview).toBeVisible({ timeout: 60000 });
    const src = await preview.getAttribute('src');

    const shot = await page.request.get(src);
    expect(shot.status()).toBe(200);
    expect(shot.headers()['content-type']).toBe('image/png');
    const png = await shot.body();
    // PNG magic number: a real render, not an error page.
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    await terminateBrowser(page, publicId, browserName);
  });
});
