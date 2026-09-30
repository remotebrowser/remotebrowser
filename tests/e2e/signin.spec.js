import { test, expect } from '@playwright/test';

const TEST_EMAIL = 'e2e-test@example.com';

const requestSignInLink = async (page, email) => {
  await page.goto('/signin');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('To sign in, click the link sent to')).toBeVisible();
  await expect(page).toHaveURL(/\/signin$/);
};

const signOut = async (page) => {
  await page.getByRole('button', { name: 'Sign out' }).click();
};

const fetchLatestNonce = async (email) => {
  const response = await fetch(`http://localhost:3000/dev/nonces?email=${encodeURIComponent(email)}`);
  const { nonce } = await response.json();
  return nonce;
};

test.describe('sign-in page', () => {
  test('has an email field that can be submitted', async ({ page }) => {
    await requestSignInLink(page, TEST_EMAIL);
    await expect(page.getByText(TEST_EMAIL)).toBeVisible();
  });

  // Without htmx the browser posts the form itself, so /sent must still render
  // the full page.
  test('falls back to the /sent page without JavaScript', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      await page.goto('/signin');
      await page.getByLabel('Email').fill(TEST_EMAIL);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page).toHaveURL(/\/sent$/);
      await expect(page.getByText(TEST_EMAIL)).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('the continue page discloses the Terms of Use and Privacy Policy', async ({ page }) => {
    await requestSignInLink(page, TEST_EMAIL);
    const nonce = await fetchLatestNonce(TEST_EMAIL);
    await page.goto(`/continue?nonce=${nonce}`);

    const termsLink = page.getByRole('link', { name: 'Terms of Use' });
    await expect(termsLink).toHaveAttribute('href', '/terms');
    await expect(termsLink).toHaveAttribute('target', '_blank');
    const privacyLink = page.getByRole('link', { name: 'Privacy Policy' });
    await expect(privacyLink).toHaveAttribute('href', '/privacy-policy');
    await expect(privacyLink).toHaveAttribute('target', '_blank');
  });

  test('signs in straight to the dashboard, both for a new user and a returning one', async ({ page }) => {
    await requestSignInLink(page, TEST_EMAIL);
    let nonce = await fetchLatestNonce(TEST_EMAIL);
    await page.goto(`/continue?nonce=${nonce}`);
    await expect(page.getByLabel('Email')).toHaveValue(TEST_EMAIL);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // No terms gate to clear: signing in lands directly on the workspace's own
    // dashboard at /.
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: 'Launch a browser' })).toHaveAttribute('href', '/browsers/launch');

    await page.goto('/browsers');
    await expect(page.getByRole('link', { name: 'Launch a browser' })).toHaveAttribute('href', '/browsers/launch');

    await signOut(page);
    await expect(page).toHaveURL(/\/signin$/);

    await requestSignInLink(page, TEST_EMAIL);
    nonce = await fetchLatestNonce(TEST_EMAIL);
    await page.goto(`/continue?nonce=${nonce}`);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // The same workspace, not a second one: the pointer on the user document is
    // written once and found again on every later sign-in.
    await expect(page).toHaveURL('/');
  });

  // Signing out drops the cookie in this browser, which does nothing about a
  // copy taken somewhere else: the encrypted session cookie inside never expires
  // on its own, so without a server-side revocation marker a captured cookie
  // would keep working indefinitely. The marker is written to the user's own
  // row, and a failed write is only logged - so this has to be checked end to
  // end rather than assumed.
  test('a session cookie captured before sign-out stops working after it', async ({ page, context }) => {
    const email = 'e2e-revocation@example.com';
    await requestSignInLink(page, email);
    const nonce = await fetchLatestNonce(email);
    await page.goto(`/continue?nonce=${nonce}`);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page).toHaveURL('/');

    const captured = (await context.cookies()).find((cookie) => cookie.name === 'session');
    expect(captured, 'a session cookie should have been set').toBeTruthy();

    // Confirm the captured value really is a working credential before revoking,
    // so a later failure can't be mistaken for a bad capture.
    await context.clearCookies();
    await context.addCookies([captured]);
    await page.goto('/');
    await expect(page).toHaveURL('/');

    await signOut(page);
    await expect(page).toHaveURL(/\/signin$/);

    await context.clearCookies();
    await context.addCookies([captured]);
    await page.goto('/');
    await expect(page, 'the captured cookie must be dead after sign-out').toHaveURL(/\/signin$/);
  });
});
