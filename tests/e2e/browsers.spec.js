import { test, expect } from '@playwright/test';

// Its own address, since the specs run in parallel and fetchLatestNonce()
// takes the newest link for an address (see the note in workspaces.spec.js).
const OWNER_EMAIL = 'e2e-browser-owner@example.com';
const COPY_BUTTON_OWNER_EMAIL = 'e2e-browser-copy-owner@example.com';
const NO_JS_COPY_BUTTON_OWNER_EMAIL = 'e2e-browser-no-js-copy-owner@example.com';
const INSTRUCTION_IDENTITY_OWNER_EMAIL = 'e2e-browser-instruction-identity-owner@example.com';

const requestSignInLink = async (page, email) => {
  await page.goto('/signin');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('To sign in, click the link sent to')).toBeVisible();
};

const fetchLatestNonce = async (email) => {
  const response = await fetch(`http://localhost:3000/dev/nonces?email=${encodeURIComponent(email)}`);
  const { nonce } = await response.json();
  return nonce;
};

const signIn = async (page, email) => {
  await requestSignInLink(page, email);
  const nonce = await fetchLatestNonce(email);
  await page.goto(`/continue?nonce=${nonce}`);
  await page.getByRole('button', { name: 'Sign In' }).click();
};

// The remotebrowser call is deliberately not awaited (startBrowser in
// src/routes/browsers/launch.js), so the record shows up before the browser
// exists and is filled in afterwards. Both halves of that are checked here,
// which is only possible because the mock server holds its answer back for
// longer than the redirect takes.
test('launching a browser answers right away, then records the id the browserfleet server assigned', async ({
  page
}) => {
  await signIn(page, OWNER_EMAIL);
  // Signing in lands on the workspace created at sign-up, with no workspace in the URL.
  await expect(page).toHaveURL('/');

  await page.goto('/browsers/launch');
  await page.locator('#name').fill('e2e-otter');
  await page.getByRole('button', { name: 'Launch' }).click();

  await expect(page).toHaveURL(/\/browsers\/B[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);
  await expect(page.locator('article p').filter({ hasText: 'Status:' })).toContainText('starting');

  // Still mid-flight: the page is already rendered while the mock is sitting on
  // its response, which is what "returns immediately" has to mean. The panel is
  // always present now and shows the starting placeholder; the instruction
  // block only replaces it once recordProvisionedBrowser() has filled in the
  // internal browser id and handle, so its absence here proves provisioning did
  // not block the response.
  const connectionInfo = page.locator('#browser-connection-info');
  await expect(connectionInfo).toContainText('Connection details will appear here once the browser is ready.');
  expect(await connectionInfo.locator('.instruction-block').count()).toBe(0);

  // The instruction block appearing proves the assigned browser id and handle
  // were recorded once the mock server answered; the status poll refreshes the
  // panel.
  await expect(connectionInfo.locator('.instruction-block')).toBeVisible({ timeout: 15000 });
});

// The code sample has its own Copy button; clicking it should put the full
// unmasked source on the clipboard, not the masked display text.
// navigator.clipboard.readText() is itself blocked by the Permissions-Policy
// header (clipboard-read stays denied - only clipboard-write is allow-listed
// for the button's own use, see src/middleware/security.js), so this reads
// the OS clipboard back the way a person would: focus a scratch field and
// paste into it. That goes through the browser's native paste handling
// rather than the JS Clipboard API, so the policy doesn't touch it.
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

test("clicking a code sample's Copy button copies its plain-text source to the clipboard", async ({
  page,
  context
}) => {
  // A real browser auto-grants clipboard-write on a user gesture with no
  // prompt; Playwright's automated Chromium doesn't, so the write throws
  // without this - unrelated to the app's own Permissions-Policy header
  // (see security_tests.js), which only controls whether the feature is
  // available in the document at all.
  await context.grantPermissions(['clipboard-write']);
  await signIn(page, COPY_BUTTON_OWNER_EMAIL);
  await expect(page).toHaveURL('/');

  await page.goto('/browsers/launch');
  await page.locator('#name').fill('e2e-copy-otter');
  await page.getByRole('button', { name: 'Launch' }).click();
  await expect(page).toHaveURL(/\/browsers\/B[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);

  // Provisioning finishes a little after the redirect (mock-remotebrowser.js
  // holds its answer back on purpose). The panel is always present now; wait
  // for the instruction block it swaps in once browser_handle lands, which the
  // page's own status poll picks up - no manual reload needed, and this also
  // exercises the Copy button surviving that outerHTML swap.
  await expect(page.locator('#browser-connection-info .instruction-block')).toBeVisible({ timeout: 15000 });

  const copyButtons = page.locator('.code-copy-button');
  const codeBlocks = page.locator('#browser-connection-info #instruction-block-playwright-js code');
  await expect(copyButtons).toHaveCount(1);
  // Rendered with the hidden class (views/browsers/show.eta.html) and
  // revealed by code-copy.eta.html once script has run - this is what
  // proves the reveal actually happened, not just that .click() below
  // would otherwise wait on it.
  await expect(copyButtons.first()).toBeVisible();

  // The displayed code hides the whole CDP URL, so the visible text differs
  // from what Copy should put on the clipboard. The full JS source, with the
  // real URL and handle, lives in the block's data-copy-value instead.
  const expectedText = await codeBlocks
    .first()
    .evaluate((el) => el.closest('.instruction-block').dataset.copyValue);
  const handle = expectedText.match(/const handle = '([^']+)'/)[1];
  expect(handle).toMatch(/^H\w+$/);

  expect(expectedText).toContain(handle);
  expect(await codeBlocks.first().textContent()).not.toContain(handle);
  // The copy payload is the whole instruction: the prose preamble and the
  // fenced code, joined - not just the <pre> on screen.
  expect(expectedText).toContain('Use the reference code below');
  expect(expectedText).toContain('```js');
  await copyButtons.first().click();
  // Confirms the button's own feedback, not just the clipboard side effect.
  await expect(copyButtons.first()).toHaveText('Copied!');
  const clipboardText = await pasteClipboardText(page);
  // The full handle must reach the clipboard, not the masked display text.
  expect(clipboardText).toBe(expectedText);
  expect(clipboardText).toContain(handle);
  // The display masks the CDP URL, so the clipboard must carry the real one.
  expect(clipboardText).toContain('/cdp/');

  // The whole CDP URL is masked on screen; only the copied source has it.
  const displayedText = await codeBlocks.first().textContent();
  expect(displayedText).toMatch(/connectOverCDP\(\*+\)/);
  expect(displayedText).not.toContain('/cdp/');
});

// The page polls the status line every 3s; the instruction block is swapped
// only when the connection panel refreshes, and a poll that recreated it would
// make the browser replay its "new scrollable content" reveal animation even
// though the snippet never changes once the browser is running.
// code-block-refresh.eta.html splices the outgoing node back in instead of
// keeping the freshly parsed one. A brand-new node from the server would never
// carry a data-e2e-identity attribute stamped on directly via JS, so this only
// stays set across a poll if that exact node survived it.
test("the instruction block survives the page's 3s poll instead of being recreated", async ({ page }) => {
  await signIn(page, INSTRUCTION_IDENTITY_OWNER_EMAIL);
  await expect(page).toHaveURL('/');

  await page.goto('/browsers/launch');
  await page.locator('#name').fill('e2e-instruction-identity-otter');
  await page.getByRole('button', { name: 'Launch' }).click();
  await expect(page).toHaveURL(/\/browsers\/B[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);
  const browserInstanceId = new URL(page.url()).pathname.split('/').pop();

  await expect(page.locator('#browser-connection-info')).toBeVisible({ timeout: 10000 });

  const instruction = page.locator('#instruction-block-playwright-js');
  await instruction.evaluate((el) => {
    el.dataset.e2eIdentity = 'original';
  });

  // The status line hx-gets this same URL every 3s; waiting for the next
  // matching response (rather than a fixed sleep) proves an actual poll
  // round-trip happened before asserting on its effect.
  await page.waitForResponse(
    (response) => response.request().method() === 'GET' && response.url().endsWith(`/browsers/${browserInstanceId}`)
  );

  await expect(instruction).toHaveAttribute('data-e2e-identity', 'original');
});

test('the Copy button stays hidden without JavaScript, even once the browser is running', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await signIn(page, NO_JS_COPY_BUTTON_OWNER_EMAIL);
    await expect(page).toHaveURL('/');

    await page.goto('/browsers/launch');
    await page.locator('#name').fill('e2e-no-js-otter');
    await page.getByRole('button', { name: 'Launch' }).click();
    await expect(page).toHaveURL(/\/browsers\/B[23456789abcdefghijkmnpqrstuvwxyz]{6}$/);

    // No htmx without JavaScript, so nothing here auto-refreshes the way the
    // other tests rely on - reload and check for the Copy button until the
    // handle has landed and a fresh server-rendered snapshot has it.
    await expect
      .poll(
        async () => {
          await page.reload();
          return page.locator('.code-copy-button').count();
        },
        { message: 'the Copy button should appear once the server answers', timeout: 15000 }
      )
      .toBe(1);
    const copyButtons = page.locator('.code-copy-button');
    await expect(copyButtons).toHaveCount(1);
    for (const button of await copyButtons.all()) {
      // Present in the markup (the page still fully works without
      // JavaScript) but hidden - no script ran to remove that class, so a
      // no-JS visitor never sees a Copy button that couldn't do anything.
      await expect(button).toBeHidden();
    }
  } finally {
    await context.close();
  }
});
