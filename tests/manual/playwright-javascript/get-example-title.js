#!/usr/bin/env node

import { chromium } from '@playwright/test';

(async () => {
  const cdpWs = process.env.CDP_WEBSOCKET_URL;
  const browser = await chromium.connectOverCDP(cdpWs);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
  console.log(await page.title());
  await page.close();
  await browser.close();
})();
