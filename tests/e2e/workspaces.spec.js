import { test, expect } from '@playwright/test';

// Every test needs its own address: the specs run in parallel and
// fetchLatestNonce() below takes the newest link for an address, so two
// tests signing in as the same person would steal each other's sign-in link.
const OWNER_EMAIL = 'e2e-workspace-owner@example.com';
const COLLABORATOR_EMAIL = 'e2e-workspace-collaborator@example.com';
const ROUTING_OWNER_EMAIL = 'e2e-workspace-routing-owner@example.com';
const SWITCHER_OWNER_EMAIL = 'e2e-workspace-switcher-owner@example.com';

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

const signOut = async (page) => {
  await page.getByRole('button', { name: 'Sign out' }).click();
};

// Switches the active workspace from the /workspaces screen: every row but the active one
// carries its own Switch form, so the button is scoped to the row's workspace name.
const switchToWorkspace = async (page, workspaceName) => {
  await page.goto('/workspaces');
  await page.getByRole('row', { name: workspaceName }).getByRole('button', { name: 'Switch' }).click();
};

test.describe('workspaces', () => {
  test('owner creates a workspace, invites a collaborator by email, and the collaborator joins and appears in the roster', async ({
    page
  }) => {
    await signIn(page, OWNER_EMAIL);

    await page.goto('/workspaces');
    await page.getByRole('link', { name: 'Create a new workspace' }).click();
    await page.getByLabel('Workspace name').fill('Acme Corp');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    // Creating a workspace switches into it, so the redirect lands on its roster
    // directly rather than naming the workspace in the URL.
    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByLabel('Breadcrumb').getByRole('link', { name: 'Acme Corp' })).toBeVisible();
    await expect(page.getByLabel('Breadcrumb').getByText('Collaborators')).toBeVisible();

    await page.getByRole('link', { name: 'Invite', exact: true }).click();
    await expect(page).toHaveURL(/\/workspace\/invite$/);
    await page.getByLabel('Email', { exact: true }).fill(COLLABORATOR_EMAIL);
    await page.getByRole('button', { name: 'Send invite' }).click();
    await expect(page).toHaveURL(/\/workspace\/invite\/sent\?email=/);
    await expect(page.getByText(COLLABORATOR_EMAIL)).toBeVisible();
    await page.getByLabel('Breadcrumb').getByRole('link', { name: 'Collaborators' }).click();
    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByText(COLLABORATOR_EMAIL)).toBeVisible();

    await signOut(page);
    await expect(page).toHaveURL(/\/signin$/);

    await signIn(page, COLLABORATOR_EMAIL);

    await page.goto('/workspaces');
    // Their own personal workspace is listed alongside Acme Corp, active by default;
    // Acme Corp itself carries a Switch button since it is not yet the active workspace.
    await expect(page.getByRole('row', { name: 'Personal' }).getByText('Active')).toBeVisible();
    await expect(page.getByRole('row', { name: 'Acme Corp' }).getByRole('button', { name: 'Switch' })).toBeVisible();

    await switchToWorkspace(page, 'Acme Corp');
    await expect(page).toHaveURL('/');
    await page.goto('/workspace');
    await expect(page.getByRole('cell', { name: COLLABORATOR_EMAIL })).toBeVisible();
  });

  test('switching the active workspace moves every page at once, and no path names a workspace any more', async ({ page }) => {
    await signIn(page, ROUTING_OWNER_EMAIL);

    // Signing in lands on the workspace's own dashboard, with no workspace in the URL.
    await expect(page).toHaveURL('/');

    await page.goto('/workspaces');
    await page.getByRole('link', { name: 'Create a new workspace' }).click();
    await page.getByLabel('Workspace name').fill('Route Corp');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page).toHaveURL(/\/workspace$/);

    const breadcrumb = page.getByLabel('Breadcrumb');

    // Creating a workspace switched into it: / and /browsers are Route Corp's now.
    await page.goto('/');
    await expect(breadcrumb.getByRole('link', { name: 'Route Corp' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Launch a browser' })).toHaveAttribute('href', '/browsers/launch');
    await expect(page.getByRole('link', { name: 'Manage collaborators' })).toHaveAttribute('href', '/workspace');

    await page.goto('/browsers');
    await expect(breadcrumb.getByRole('link', { name: 'Route Corp' })).toBeVisible();
    await expect(breadcrumb.getByText('Browsers')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Launch a browser' })).toHaveAttribute('href', '/browsers/launch');

    // Switching back to the workspace moves the very same paths, with them.
    await switchToWorkspace(page, 'Personal');
    await expect(page).toHaveURL('/');
    await expect(breadcrumb.getByRole('link', { name: 'Personal' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manage collaborators' })).toHaveCount(0);

    await page.goto('/browsers');
    await expect(breadcrumb.getByRole('link', { name: 'Personal' })).toBeVisible();
    await expect(breadcrumb.getByText('Browsers')).toBeVisible();

    // A roster the workspace does not have: asking for one lands on the dashboard.
    await page.goto('/workspace');
    await expect(page).toHaveURL('/');
    await expect(breadcrumb.getByRole('link', { name: 'Personal' })).toBeVisible();

    // Same for deleting it, which the rules refuse outright.
    await page.goto('/workspace/delete');
    await expect(page).toHaveURL('/');

    // No route answers a workspace-scoped path with a workspace prefixed onto it any more.
    const stale = await page.goto('/Tabcd/browsers');
    expect(stale.status()).toBe(404);
  });

  test('the breadcrumb switcher moves workspaces from any page, and offers New workspace', async ({ page }) => {
    await signIn(page, SWITCHER_OWNER_EMAIL);

    await page.goto('/workspaces');
    await page.getByRole('link', { name: 'Create a new workspace' }).click();
    await page.getByLabel('Workspace name').fill('Crumb Corp');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page).toHaveURL(/\/workspace$/);

    // Switch back to the personal workspace from the breadcrumb, on a page that
    // isn't the dashboard - the whole point is not needing to visit /workspaces first.
    await page.goto('/browsers');
    const switcher = page.getByRole('link', { name: 'Crumb Corp' });
    await switcher.hover();
    await page.getByRole('button', { name: 'Personal' }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByLabel('Breadcrumb').getByRole('link', { name: 'Personal' })).toBeVisible();

    // New workspace, reached from the breadcrumb rather than a page visit to /workspaces.
    await page.getByRole('link', { name: 'Personal' }).hover();
    await page.getByLabel('Breadcrumb').getByRole('link', { name: 'New workspace' }).click();
    await expect(page).toHaveURL('/workspaces/create');
  });
});
