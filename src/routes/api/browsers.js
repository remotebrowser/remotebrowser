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
import {
  generateBrowserName,
  browsersReady,
  launchRefusal,
  launchableOses,
  startBrowser,
  SCREEN_RESOLUTIONS,
  DEFAULT_SCREEN_RESOLUTION_CHOICE,
  SCREEN_SCALES,
  DEFAULT_SCREEN_SCALE_CHOICE
} from '../browsers/launch.js';
import { terminateBrowser } from '../browsers/terminate.js';
import { suspendBrowserInstance, resumeBrowserInstance } from '../browsers/suspend.js';
import { setBrowserProxy, clearBrowserProxy, typeBrowserText, useBrowserMouse, readBrowserMouse } from '../../vms.js';
import {
  BROWSER_APPS,
  DEFAULT_BROWSER_APP,
  DEFAULT_OS,
  OSES,
  guestOf,
  normalizeExtensions,
  normalizeProxyUrl,
  maskProxyUrl,
  resolveBrowserApp,
  parseMouseActions,
  resolveOs,
  textToKeys
} from '../../vm/index.js';

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
// e.g. the allow and deny lists. The rest are only for a launch, as they apply
// when the browser starts. They match the web UI's launch form, with the same
// choices and limits.
const SETTINGS = new Set(['proxy']);
const LAUNCH_SETTINGS = new Set([
  ...SETTINGS,
  'name',
  'description',
  'os',
  'browser',
  'webgl',
  'screen_resolution',
  'screen_scale',
  'extensions'
]);

// Returns the settings, or the response that says what is wrong with them. An
// empty body means no settings, so a bare POST still launches a browser.
const readSettings = async (c, { launch = false } = {}) => {
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
  const unknown = Object.keys(body).find((key) => !(launch ? LAUNCH_SETTINGS : SETTINGS).has(key));
  if (unknown) {
    return { response: c.json({ error: `Unknown setting: ${unknown}.` }, 400) };
  }
  const settings = {};
  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) {
      return { response: c.json({ error: 'The name must be a string of 1 to 80 characters.' }, 400) };
    }
    settings.name = name;
  }
  if ('description' in body) {
    const description = typeof body.description === 'string' ? body.description.trim() : null;
    if (description === null || description.length > 140) {
      return { response: c.json({ error: 'The description must be a string of up to 140 characters.' }, 400) };
    }
    settings.description = description;
  }
  if ('screen_resolution' in body) {
    const choice = SCREEN_RESOLUTIONS.find((resolution) => resolution.value === body.screen_resolution);
    if (!choice) {
      const values = SCREEN_RESOLUTIONS.map((resolution) => resolution.value).join(', ');
      return { response: c.json({ error: `The screen_resolution must be one of ${values}.` }, 400) };
    }
    // The default is the image's own, so it sets nothing, as in the web UI.
    settings.screenResolution =
      choice.value === DEFAULT_SCREEN_RESOLUTION_CHOICE ? null : { width: choice.width, height: choice.height };
  }
  if ('screen_scale' in body) {
    const choice = SCREEN_SCALES.find((scale) => scale.scale === body.screen_scale);
    if (!choice) {
      const values = SCREEN_SCALES.map((scale) => scale.scale).join(', ');
      return { response: c.json({ error: `The screen_scale must be one of ${values}.` }, 400) };
    }
    settings.screenScale = choice.value === DEFAULT_SCREEN_SCALE_CHOICE ? null : choice.scale;
  }
  if ('os' in body) {
    settings.os = resolveOs(body.os);
    if (!settings.os) {
      return { response: c.json({ error: `The os must be one of ${Object.keys(OSES).join(', ')}.` }, 400) };
    }
  }
  if ('browser' in body) {
    settings.browser = resolveBrowserApp(body.browser);
    if (!settings.browser) {
      return {
        response: c.json({ error: `The browser must be one of ${Object.keys(BROWSER_APPS).join(', ')}.` }, 400)
      };
    }
  }
  if ('webgl' in body) {
    if (typeof body.webgl !== 'boolean') {
      return { response: c.json({ error: 'The webgl setting must be true or false.' }, 400) };
    }
    settings.webgl = body.webgl;
  }
  if ('extensions' in body) {
    try {
      settings.extensions = normalizeExtensions(body.extensions);
    } catch (error) {
      return { response: c.json({ error: `${error.message}.` }, 400) };
    }
  }
  if ('proxy' in body) {
    if (body.proxy !== null && typeof body.proxy !== 'string') {
      return { response: c.json({ error: 'The proxy must be a URL, or null to connect directly.' }, 400) };
    }
    try {
      // Normalized here, so a bad URL is refused before anything changes.
      settings.proxy = normalizeProxyUrl(body.proxy);
    } catch (error) {
      return { response: c.json({ error: `${error.message}.` }, 400) };
    }
  }
  return { settings };
};

// Secrets in the stored config are masked already.
const configResponse = (browser, config) => ({ browser_id: browser.publicId, proxy: config.proxy ?? null });

routes.post('/', async (c) => {
  const { settings, response } = await readSettings(c, { launch: true });
  if (response) return response;
  if (!(await browsersReady())) {
    return c.json({ error: 'Browsers are still being prepared. Please try again in a few minutes.' }, 503);
  }
  const os = settings.os ?? DEFAULT_OS;
  if (settings.extensions?.length && guestOf(os) === 'windows') {
    return c.json({ error: `Extensions are not available on ${os} yet.` }, 400);
  }
  if (!(await launchableOses()).includes(os)) {
    return c.json({ error: `${OSES[os].label} browsers are not available here yet. Please try again later.` }, 503);
  }
  const user = c.get('user');
  const workspace = c.get('workspace');
  const launched = await launchBrowserInstance({
    workspaceId: workspace.id,
    userId: user.id,
    browserName: settings.name ?? generateBrowserName(),
    browserDescription: settings.description ?? '',
    config: settings.proxy ? { proxy: maskProxyUrl(settings.proxy) } : null,
    os
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
    os,
    proxy: settings.proxy ?? null,
    screenResolution: settings.screenResolution ?? null,
    screenScale: settings.screenScale ?? null,
    webgl: settings.webgl ?? true,
    app: settings.browser ?? DEFAULT_BROWSER_APP,
    extensions: settings.extensions ?? []
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
  const { publicId, status, browserDescription, os, creationTimestamp } = browser.data;
  return c.json({
    browser_id: publicId,
    status,
    description: browserDescription,
    os,
    creation_timestamp: creationTimestamp
  });
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

// The body's `name` field, or the 400 response that says why the body is wrong.
const readInputBody = async (c, name) => {
  /** @type {any} */
  let body;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return { response: c.json({ error: 'The request body must be JSON.' }, 400) };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { response: c.json({ error: 'The request body must be a JSON object.' }, 400) };
  }
  const unknown = Object.keys(body).find((key) => key !== name);
  if (unknown) {
    return { response: c.json({ error: `Unknown field: ${unknown}.` }, 400) };
  }
  return { value: body[name] };
};

// Input goes only to a running browser. Returns its row, or the response.
const loadInputBrowser = async (c, refusal) => {
  const browser = await loadBrowser(c);
  if (browser.error) {
    return { response: c.json({ error: 'Unable to read the browser. Please try again.' }, 503) };
  }
  if (!browser.data) return { response: c.json(NOT_FOUND, 404) };
  if (browser.data.status !== 'running') {
    return {
      response: c.json({ error: refusal, browser_id: browser.data.publicId, status: browser.data.status }, 409)
    };
  }
  return { browser: browser.data };
};

// Any key of the workspace may type, as it may drive the browser over CDP.
routes.post('/:browserId/type', async (c) => {
  const { value: text, response } = await readInputBody(c, 'text');
  if (response) return response;
  try {
    textToKeys(text);
  } catch (error) {
    return c.json({ error: `${error.message}.` }, 400);
  }
  const loaded = await loadInputBrowser(c, 'Only a running browser can take key presses.');
  if (loaded.response) return loaded.response;
  const { browser } = loaded;
  // Typing takes as long as a person would, so the caller does not wait for it.
  void typeBrowserText(browser.internalBrowserId, text).then((typed) => {
    if (typed.error) {
      consola.error('API could not type into a browser', {
        'event.domain': 'api',
        'error.type': String(typed.error),
        'browser.public_id': browser.publicId
      });
    }
  });
  logAction(c, 'API browser typing', browser);
  return c.json({ browser_id: browser.publicId, status: 'typing' }, 202);
});

// The same rights as typing.
routes.post('/:browserId/mouse', async (c) => {
  const { value: actions, response } = await readInputBody(c, 'actions');
  if (response) return response;
  try {
    parseMouseActions(actions);
  } catch (error) {
    return c.json({ error: `${error.message}.` }, 400);
  }
  const loaded = await loadInputBrowser(c, 'Only a running browser can take mouse input.');
  if (loaded.response) return loaded.response;
  const { browser } = loaded;
  // Every event is sent at once, so the caller waits and learns of a failure.
  const used = await useBrowserMouse(browser.internalBrowserId, actions);
  if (used.error) {
    consola.error('API could not use the mouse of a browser', {
      'event.domain': 'api',
      'error.type': String(used.error),
      'browser.public_id': browser.publicId
    });
    return c.json({ error: 'Unable to use the mouse. Please try again.' }, 502);
  }
  logAction(c, 'API browser mouse', browser);
  return c.json({ browser_id: browser.publicId });
});

// Read from the guest, so it is right even after a VNC viewer moved the pointer.
routes.get('/:browserId/mouse', async (c) => {
  const loaded = await loadInputBrowser(c, 'Only a running browser has a mouse pointer.');
  if (loaded.response) return loaded.response;
  const { browser } = loaded;
  const read = await readBrowserMouse(browser.internalBrowserId);
  if (read.error || !read.data) {
    if (read.error) {
      consola.error('API could not read the mouse of a browser', {
        'event.domain': 'api',
        'error.type': String(read.error),
        'browser.public_id': browser.publicId
      });
    }
    return c.json({ error: 'Unable to read the mouse position. Please try again.' }, 502);
  }
  const { x, y, visible } = read.data;
  return c.json({ browser_id: browser.publicId, x, y, visible });
});

// The real CDP endpoint is a WebSocket upgrade, served by the relay in src/cdp.js.
routes.get('/:browserId/cdp', (c) => c.json({ error: 'This endpoint needs a WebSocket upgrade.' }, 426));
