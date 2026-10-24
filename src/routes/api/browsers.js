import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { requireApiKey } from '../../middleware/apikey.js';
import { canTerminateBrowser } from '../../middleware/workspace.js';
import {
  launchBrowserInstance,
  listBrowserInstancesByWorkspace,
  getBrowserInstanceByPublicId,
  setBrowserInstanceConfig
} from '../../models/browsers.js';
import { generateBrowserName, browsersReady, launchRefusal, startBrowser } from '../browsers/launch.js';
import { terminateBrowser } from '../browsers/terminate.js';
import { suspendBrowserInstance, resumeBrowserInstance } from '../browsers/suspend.js';
import { canSuspendBrowsers, canSetBrowserProxy, setBrowserProxy, clearBrowserProxy } from '../../fleet.js';
import { normalizeProxyUrl, maskProxyUrl } from '../../vm/index.js';

// Documented in docs/api.md. A browser_id is the browser's public id, and a key
// reaches only the browsers of its own workspace.

export const routes = new Hono();

routes.use('*', requireApiKey);

// A browser that is starting is listed too, so a launch shows up right away.
const LISTED_STATUSES = new Set(['starting', 'running']);

const NOT_FOUND = { error: 'Browser not found.' };

const loadBrowser = async (c) => {
  const result = await getBrowserInstanceByPublicId({
    workspaceId: c.get('workspace').id,
    publicId: c.req.param('browserId')
  });
  if (result.error) {
    consola.error('API could not read a browser', { 'event.domain': 'api', 'error.type': String(result.error) });
    return { error: result.error };
  }
  return { data: result.data };
};

// The settings a launch or a config change may carry. More will join proxy,
// e.g. the allow and deny lists.
const SETTINGS = new Set(['proxy']);

// Returns the settings, or the response that says what is wrong with them. An
// empty body means no settings, so a bare POST still launches a browser.
const readSettings = async (c) => {
  const text = await c.req.text();
  if (text.trim() === '') return { settings: {} };
  /** @type {any} */
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { response: c.json({ error: 'The request body must be JSON.' }, 400) };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { response: c.json({ error: 'The request body must be a JSON object.' }, 400) };
  }
  const unknown = Object.keys(body).find((key) => !SETTINGS.has(key));
  if (unknown) {
    return { response: c.json({ error: `Unknown setting: ${unknown}.` }, 400) };
  }
  if ('proxy' in body) {
    if (!canSetBrowserProxy()) {
      return { response: c.json({ error: 'This server cannot set a proxy for its browsers.' }, 501) };
    }
    if (body.proxy !== null && typeof body.proxy !== 'string') {
      return { response: c.json({ error: 'The proxy must be a URL, or null to connect directly.' }, 400) };
    }
    try {
      // Normalized here, so a bad URL is refused before anything changes.
      return { settings: { proxy: normalizeProxyUrl(body.proxy) } };
    } catch (error) {
      return { response: c.json({ error: `${error.message}.` }, 400) };
    }
  }
  return { settings: {} };
};

// Secrets in the stored config are masked already.
const configResponse = (browser, config) => ({ browser_id: browser.publicId, proxy: config.proxy ?? null });

routes.post('/', async (c) => {
  const { settings, response } = await readSettings(c);
  if (response) return response;
  if (!(await browsersReady())) {
    return c.json({ error: 'Browsers are still being prepared. Please try again in a few minutes.' }, 503);
  }
  const user = c.get('user');
  const workspace = c.get('workspace');
  const launched = await launchBrowserInstance({
    workspaceId: workspace.id,
    userId: user.id,
    browserName: generateBrowserName(),
    browserDescription: '',
    config: settings.proxy ? { proxy: maskProxyUrl(settings.proxy) } : null
  });
  const refusal = launchRefusal(launched);
  if (refusal) {
    c.header('Retry-After', String(refusal.retryAfterSeconds));
    return c.json({ error: refusal.message }, 429);
  }
  if (launched.error) {
    consola.error('API could not launch a browser', { 'event.domain': 'api', 'error.type': String(launched.error) });
    return c.json({ error: 'Unable to launch the browser. Please try again.' }, 500);
  }
  // The proxy is set before the browser starts, so even its first request takes that route.
  void startBrowser({
    workspaceId: workspace.id,
    browserInstanceId: launched.data.browserInstanceId,
    userId: user.id,
    proxy: settings.proxy ?? null
  });
  logAction(c, 'API browser launched', launched.data);
  return c.json({ browser_id: launched.data.publicId, status: 'launched' });
});

routes.get('/', async (c) => {
  const listed = await listBrowserInstancesByWorkspace({ workspaceId: c.get('workspace').id });
  if (listed.error) {
    consola.error('API could not list the browsers', { 'event.domain': 'api', 'error.type': String(listed.error) });
    return c.json({ error: 'Unable to list the browsers. Please try again.' }, 503);
  }
  return c.json(
    listed.data.filter((browser) => LISTED_STATUSES.has(browser.status)).map((browser) => browser.publicId)
  );
});

routes.get('/:browserId', async (c) => {
  const browser = await loadBrowser(c);
  if (browser.error) return c.json({ error: 'Unable to read the browser. Please try again.' }, 503);
  if (!browser.data) return c.json(NOT_FOUND, 404);
  const { publicId, status, browserDescription } = browser.data;
  return c.json({ browser_id: publicId, status, description: browserDescription });
});

routes.delete('/:browserId', async (c) => {
  const browser = await loadBrowser(c);
  if (browser.error) return c.json({ error: 'Unable to read the browser. Please try again.' }, 503);
  if (!browser.data) return c.json(NOT_FOUND, 404);
  const user = c.get('user');
  const workspace = c.get('workspace');
  // A key acts with its creator's rights: only the browser's creator or an Admin may stop it.
  if (!canTerminateBrowser(browser.data, workspace, user)) {
    return c.json({ error: 'Only the creator of this browser, or an Admin, may terminate it.' }, 403);
  }
  const terminated = await terminateBrowser({ user, workspace, browser: browser.data });
  if (terminated.error) {
    return c.json({ error: 'Unable to terminate the browser. Please try again.' }, 502);
  }
  return c.json({ browser_id: browser.data.publicId, status: 'terminated' });
});

// Loads a browser to suspend or resume, or returns the response that says why not.
const loadManagedBrowser = async (c) => {
  // Only local VMs can be suspended; an external fleet has no such call.
  if (!canSuspendBrowsers()) {
    return { response: c.json({ error: 'This server cannot suspend or resume browsers.' }, 501) };
  }
  const browser = await loadBrowser(c);
  if (browser.error) return { response: c.json({ error: 'Unable to read the browser. Please try again.' }, 503) };
  if (!browser.data) return { response: c.json(NOT_FOUND, 404) };
  // The same rights as terminating: the browser's creator, or an Admin.
  if (!canTerminateBrowser(browser.data, c.get('workspace'), c.get('user'))) {
    return {
      response: c.json({ error: 'Only the creator of this browser, or an Admin, may suspend or resume it.' }, 403)
    };
  }
  return { browser: browser.data };
};

const logAction = (c, message, browser) => {
  consola.info(message, {
    'event.domain': 'api',
    'user.id': c.get('user').id,
    'workspace.id': c.get('workspace').id,
    'browser.public_id': browser.publicId,
    'rb.api_key': c.get('apiKeyPublicId')
  });
};

routes.post('/:browserId/suspend', async (c) => {
  const { browser, response } = await loadManagedBrowser(c);
  if (response) return response;
  const suspended = await suspendBrowserInstance({ workspaceId: c.get('workspace').id, browser });
  if (suspended.error === 'NOT_RUNNING') {
    return c.json(
      { error: 'Only a running browser can be suspended.', browser_id: browser.publicId, status: browser.status },
      409
    );
  }
  if (suspended.error) return c.json({ error: 'Unable to suspend the browser. Please try again.' }, 502);
  logAction(c, 'API browser suspended', browser);
  return c.json({ browser_id: browser.publicId, status: 'suspended' });
});

routes.post('/:browserId/resume', async (c) => {
  const { browser, response } = await loadManagedBrowser(c);
  if (response) return response;
  const resumed = await resumeBrowserInstance({ workspaceId: c.get('workspace').id, browser });
  if (resumed.error === 'NOT_SUSPENDED') {
    return c.json(
      { error: 'Only a suspended browser can be resumed.', browser_id: browser.publicId, status: browser.status },
      409
    );
  }
  if (resumed.error === 'BUSY') return c.json({ error: 'This browser is already being resumed.' }, 409);
  if (resumed.error) return c.json({ error: 'Unable to resume the browser. Please try again.' }, 502);
  logAction(c, 'API browser resumed', browser);
  return c.json({ browser_id: browser.publicId, status: 'running' });
});

routes.get('/:browserId/config', async (c) => {
  const browser = await loadBrowser(c);
  if (browser.error) return c.json({ error: 'Unable to read the browser. Please try again.' }, 503);
  if (!browser.data) return c.json(NOT_FOUND, 404);
  return c.json(configResponse(browser.data, browser.data.config));
});

// Settings left out stay as they are. Any change restarts the browser's proxy,
// which drops its open connections, so one call applies them all.
routes.patch('/:browserId/config', async (c) => {
  const { settings, response } = await readSettings(c);
  if (response) return response;
  const browser = await loadBrowser(c);
  if (browser.error) return c.json({ error: 'Unable to read the browser. Please try again.' }, 503);
  if (!browser.data) return c.json(NOT_FOUND, 404);
  const user = c.get('user');
  const workspace = c.get('workspace');
  // The same rights as suspending or terminating.
  if (!canTerminateBrowser(browser.data, workspace, user)) {
    return c.json({ error: 'Only the creator of this browser, or an Admin, may configure it.' }, 403);
  }
  let { config } = browser.data;
  if ('proxy' in settings) {
    // A suspended or starting browser has no guest to write to.
    if (browser.data.status !== 'running') {
      return c.json(
        {
          error: 'Only a running browser can be configured.',
          browser_id: browser.data.publicId,
          status: browser.data.status
        },
        409
      );
    }
    const { internalBrowserId } = browser.data;
    const applied = settings.proxy
      ? await setBrowserProxy(internalBrowserId, settings.proxy)
      : await clearBrowserProxy(internalBrowserId);
    if (applied.error) {
      consola.error('API could not change a browser proxy', {
        'event.domain': 'api',
        'error.type': String(applied.error)
      });
      return c.json({ error: 'Unable to change the proxy. Please try again.' }, 502);
    }
    config = { ...config, proxy: maskProxyUrl(settings.proxy) };
    const stored = await setBrowserInstanceConfig({
      workspaceId: workspace.id,
      browserInstanceId: browser.data.browserInstanceId,
      config
    });
    // The browser already uses the new proxy; only what GET reports is stale.
    if (stored.error) {
      consola.error('API could not store a browser config', {
        'event.domain': 'api',
        'error.type': String(stored.error)
      });
    }
    logAction(c, 'API browser configured', browser.data);
  }
  return c.json(configResponse(browser.data, config));
});

// The real CDP endpoint is a WebSocket upgrade, served by the relay in src/cdp.js.
routes.get('/:browserId/cdp', (c) => c.json({ error: 'This endpoint needs a WebSocket upgrade.' }, 426));
