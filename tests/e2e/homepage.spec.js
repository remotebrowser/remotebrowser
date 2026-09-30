import { test, expect } from '@playwright/test';

test.describe('homepage', () => {
  test('redirects an anonymous visitor to /signin', async ({ page }) => {
    const response = await page.goto('/');
    expect(response.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByLabel('Email')).toBeVisible();
  });

  test('redirects to /signin without JavaScript', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByLabel('Email')).toBeVisible();
    await context.close();
  });
});
