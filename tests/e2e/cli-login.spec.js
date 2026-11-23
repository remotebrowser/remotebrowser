import { test, expect } from '@playwright/test';

// Its own address, since the specs run in parallel (see apikeys.spec.js).
const EMAIL = 'e2e-cli-login@example.com';
const BASE = 'http://localhost:3000';
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const postJson = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });

test('the CLI logs in through the browser, and the session can be revoked', async ({ page }) => {
  // What `remotebrowser login` does first.
  const started = await (await postJson('/api/v1/auth/device', { device_name: 'e2e-laptop' })).json();
  expect(started.verification_uri).toBe(`${BASE}/activate`);

  // Signed out, the link goes through sign-in and comes back with the code.
  await page.goto(started.verification_uri_complete);
  await expect(page).toHaveURL('/signin');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('To sign in, click the link sent to')).toBeVisible();
  const { nonce } = await (await fetch(`${BASE}/dev/nonces?email=${encodeURIComponent(EMAIL)}`)).json();
  await page.goto(`/continue?nonce=${nonce}`);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect(page).toHaveURL(`/activate?code=${started.user_code}`);
  await expect(page.getByLabel('Code')).toHaveValue(started.user_code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('e2e-laptop')).toBeVisible();
  await expect(page.getByText('30 days')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('heading', { name: 'CLI login approved' })).toBeVisible();

  const issued = await (await postJson('/api/v1/auth/token', { grant_type: GRANT, device_code: started.device_code })).json();
  expect(issued.access_token).toMatch(/^rb-cli-/);
  const auth = { Authorization: `Bearer ${issued.access_token}` };
  expect((await fetch(`${BASE}/api/v1/browsers`, { headers: auth })).status).toBe(200);

  await page.goto('/');
  await page.getByRole('link', { name: 'CLI on e2e-laptop' }).click();
  await expect(page.getByRole('heading', { name: 'CLI on e2e-laptop' })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('No active sessions for the CLI')).toBeVisible();
  expect((await fetch(`${BASE}/api/v1/browsers`, { headers: auth })).status).toBe(401);
});
