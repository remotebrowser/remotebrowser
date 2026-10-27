import { test, expect } from '@playwright/test';

// Its own address, since the specs run in parallel and fetchLatestNonce()
// takes the newest link for an address (see the note in workspaces.spec.js).
const OWNER_EMAIL = 'e2e-apikey-owner@example.com';

const signIn = async (page, email) => {
  await page.goto('/signin');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('To sign in, click the link sent to')).toBeVisible();
  const response = await fetch(`http://localhost:3000/dev/nonces?email=${encodeURIComponent(email)}`);
  const { nonce } = await response.json();
  await page.goto(`/continue?nonce=${nonce}`);
  await page.getByRole('button', { name: 'Sign In' }).click();
};

// The app's Permissions-Policy denies clipboard reads, so paste with a real
// keypress instead, as in tests/e2e-vm/browsers.spec.js.
const pasteClipboardText = async (page) => {
  await page.evaluate(() => {
    const scratch = document.createElement('textarea');
    scratch.id = 'e2e-clipboard-scratch';
    document.body.appendChild(scratch);
  });
  const scratch = page.locator('#e2e-clipboard-scratch');
  await scratch.focus();
  await page.keyboard.press('ControlOrMeta+V');
  const text = await scratch.inputValue();
  await page.evaluate(() => document.getElementById('e2e-clipboard-scratch')?.remove());
  return text;
};

test('generating an API key shows it once, then lists only its preview', async ({ page, context }) => {
  // Automated Chromium needs this for the Copy button's clipboard write.
  await context.grantPermissions(['clipboard-write']);
  await signIn(page, OWNER_EMAIL);
  await expect(page).toHaveURL('/');
  await expect(page.getByText('You have no API keys.')).toBeVisible();

  await page.getByRole('link', { name: 'New API key' }).click();
  await expect(page).toHaveURL('/api-keys/generate');
  // A suggested adjective-flower name, like a browser's adjective-animal one.
  await expect(page.getByLabel('Name')).toHaveValue(/^[a-z]+-[a-z]+$/);
  await expect(page.getByRole('radio', { name: '7 days' })).toBeChecked();
  await page.getByLabel('Name').fill('e2e-ci');
  await page.getByRole('button', { name: 'Generate' }).click();

  // Masked at first; View Key shows it, Hide Key masks it again.
  const value = page.locator('.api-key-value');
  const mask = page.locator('.api-key-mask');
  await expect(value).toBeHidden();
  await expect(mask).toHaveText(/^sk-rb-v1-•{36}$/);
  const toggle = page.getByRole('button', { name: 'View Key' });
  await toggle.click();
  await expect(value).toBeVisible();
  await expect(mask).toBeHidden();
  const apiKey = await value.innerText();
  expect(apiKey).toMatch(/^sk-rb-v1-[23456789abcdefghijkmnpqrstuvwxyz]{36}$/);
  await page.getByRole('button', { name: 'Hide Key' }).click();
  await expect(value).toBeHidden();
  await expect(page.getByRole('button', { name: 'View Key' })).toBeVisible();

  await expect(page.getByText(/expires at/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Back to the workspace' })).toHaveCount(0);

  // By class, not by name: the name changes to "Copied!" once clicked.
  const copy = page.locator('.code-copy-button');
  await expect(copy).toBeVisible();
  // Copied in full even while it is masked.
  await copy.click();
  await expect(copy).toHaveText('Copied!');
  expect(await pasteClipboardText(page)).toBe(apiKey);
  await expect(copy).toHaveText('Copy', { timeout: 5000 });

  // The workspace only counts the keys; the list is on /api-keys.
  await page.goto('/');
  await expect(page.getByText('You have 1 API key.')).toBeVisible();
  await page.getByRole('link', { name: '1 API key' }).click();
  await expect(page).toHaveURL('/api-keys');
  await expect(page.getByRole('cell', { name: 'e2e-ci' })).toBeVisible();
  await expect(page.getByText(`${apiKey.slice(0, 13)}…`)).toBeVisible();
  await expect(page.getByText(apiKey)).toHaveCount(0);
});

const NO_JS_OWNER_EMAIL = 'e2e-apikey-no-js-owner@example.com';

test('without JavaScript, a new API key shows in full, with no buttons that cannot work', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await signIn(page, NO_JS_OWNER_EMAIL);
    await page.goto('/api-keys/generate');
    await page.getByLabel('Name').fill('e2e-no-js');
    await page.getByRole('radio', { name: '1 day' }).check();
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.locator('.api-key-value')).toHaveText(/^sk-rb-v1-[23456789abcdefghijkmnpqrstuvwxyz]{36}$/);
    await expect(page.locator('.api-key-mask')).toBeHidden();
    await expect(page.locator('.code-copy-button')).toBeHidden();
    await expect(page.locator('.api-key-toggle')).toBeHidden();
  } finally {
    await context.close();
  }
});
