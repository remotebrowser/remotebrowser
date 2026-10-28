import { test, expect } from '@playwright/test';
import { signIn, useQemuVms } from './helpers.js';

// The REST API against a real VM, since the CDP relay needs a running browser.
useQemuVms();

const API_OWNER_EMAIL = 'e2e-apikey-api-owner@example.com';

const generateApiKey = async (page) => {
  await page.goto('/api-keys/generate');
  await page.getByLabel('Name').fill('e2e-api');
  await page.getByRole('radio', { name: '1 hour' }).check();
  await page.getByRole('button', { name: 'Generate' }).click();
  // Copy's own source, the full key, whether or not it is masked on screen.
  return page.locator('.api-key-block').getAttribute('data-copy-value');
};

// The CDP endpoint is a WebSocket upgrade with the key in its headers, which a
// page cannot send; Node's own WebSocket client (ws) can.
const openCdp = async (baseURL, browserId, apiKey) => {
  const { WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/v1/browsers/${browserId}/cdp`, baseURL.replace(/^http/, 'ws'));
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    socket.once('error', reject);
  });
};

test('the REST API launches, lists, queries, drives over CDP, and terminates a browser', async ({
  page,
  request,
  baseURL
}) => {
  await signIn(page, API_OWNER_EMAIL);
  const apiKey = await generateApiKey(page);
  const headers = { Authorization: `Bearer ${apiKey}` };

  expect((await request.get('/api/v1/browsers')).status()).toBe(401);

  const launched = await request.post('/api/v1/browsers', { headers });
  expect(launched.status()).toBe(200);
  const { browser_id: browserId, status } = await launched.json();
  expect(status).toBe('launched');

  expect(await (await request.get('/api/v1/browsers', { headers })).json()).toContain(browserId);
  expect(await (await request.get(`/api/v1/browsers/${browserId}`, { headers })).json()).toEqual({
    browser_id: browserId,
    status: 'starting',
    description: ''
  });

  // Wait for the VM to start, then for Chromium to answer.
  await expect
    .poll(
      async () => {
        try {
          const socket = await openCdp(baseURL, browserId, apiKey);
          const reply = await new Promise((resolve) => {
            socket.once('message', (data) => resolve(JSON.parse(String(data))));
            socket.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
          });
          socket.close();
          return Array.isArray(reply.result?.targetInfos);
        } catch (error) {
          return String(error);
        }
      },
      { timeout: 150000 }
    )
    .toBe(true);

  const terminated = await request.delete(`/api/v1/browsers/${browserId}`, { headers });
  expect(await terminated.json()).toEqual({ browser_id: browserId, status: 'terminated' });
  expect((await request.get(`/api/v1/browsers/${browserId}`, { headers })).status()).toBe(404);
});
