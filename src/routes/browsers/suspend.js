import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../render.js';
import { createCsrfToken, verifyCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import {
  requireWorkspaceRole,
  requireSubmittedWorkspace,
  buildBrowsersBreadcrumbs,
  loadWorkspaceSwitcherItems,
  canTerminateBrowser
} from '../../middleware/workspace.js';
import { transitionBrowserInstanceStatus } from '../../models/browsers.js';
import { canSuspendBrowsers, suspendBrowser, resumeBrowser } from '../../fleet.js';
import { browserMonitors } from '../../browser.js';
import { loadBrowser } from './terminate.js';
import { renderBrowser } from './show.js';

export const routes = new Hono();

// Browsers being suspended or resumed in this process. Both take seconds, and a
// second request for the same VM meanwhile would fight over its QEMU.
const busy = new Set();

const renderSuspend = async (c, data = {}) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  return eta.render('browsers/suspend', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    error: null,
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildBrowsersBreadcrumbs(workspace, data.browser.browserName),
    // Set by secureHeaders first; the inline script reads it back for CSP.
    scriptNonce: c.get('secureHeadersNonce'),
    ...data
  });
};

// Loads the browser for a suspend or resume, or answers why not.
const loadManagedBrowser = async (c) => {
  const browser = await loadBrowser(c);
  // With an external fleet there is nothing to suspend with, as if the page did not exist.
  if (!browser || !canSuspendBrowsers()) {
    return { response: c.text('Not found', 404) };
  }
  if (!canTerminateBrowser(browser, c.get('workspace'), c.get('user'))) {
    return { response: c.text('Forbidden', 403) };
  }
  return { browser };
};

const logAction = (c, event, browser) => {
  const user = c.get('user');
  consola.info(event, {
    'event.domain': 'browser',
    'user.id': user.id,
    'user.email': user.email,
    'workspace.id': c.get('workspace').id,
    'browser.public_id': browser.publicId
  });
};

routes.get('/:browserId/suspend', requireUser, requireWorkspaceRole('User'), async (c) => {
  const { browser, response } = await loadManagedBrowser(c);
  if (response) {
    return response;
  }
  // Only a running browser can be suspended; its page shows what it is instead.
  if (browser.status !== 'running') {
    return c.redirect(`/browsers/${browser.publicId}`, 303);
  }
  return c.html(renderSuspend(c, { browser }));
});

routes.post('/:browserId/suspend', requireUser, requireWorkspaceRole('User'), requireSubmittedWorkspace, async (c) => {
  const body = await c.req.parseBody();
  const { browser, response } = await loadManagedBrowser(c);
  if (response) {
    return response;
  }
  if (!verifyCsrfToken(c, body.csrf)) {
    return c.html(await renderSuspend(c, { browser, error: 'Your session expired. Please try again.' }), 403);
  }
  if (browser.status !== 'running' || busy.has(browser.internalBrowserId)) {
    return c.html(
      await renderSuspend(c, { browser, error: 'This browser is not running, so it cannot be suspended.' }),
      409
    );
  }

  const workspaceId = c.get('workspace').id;
  const { browserInstanceId, internalBrowserId } = browser;
  busy.add(internalBrowserId);
  try {
    // The monitor would take the VM going away for a crash, and mark the browser as failed.
    await browserMonitors.stopBrowserMonitor({ internalBrowserId });
    const suspended = await suspendBrowser({ browserId: internalBrowserId });
    if (suspended.error) {
      consola.error('suspendBrowser failed:', suspended.error);
      // A failed suspend leaves the VM running, so watch it again.
      void browserMonitors.startBrowserMonitor({ workspaceId, browserInstanceId, internalBrowserId });
      return c.html(
        await renderSuspend(c, { browser, error: 'Unable to suspend the browser. Please try again.' }),
        400
      );
    }
    // 'error' too: with the monitor gone, a failed screenshot may have written it meanwhile.
    const marked = await transitionBrowserInstanceStatus({
      workspaceId,
      browserInstanceId,
      fromStatuses: ['running', 'error'],
      toStatus: 'suspended'
    });
    if (!marked.data) {
      consola.error(`Browser ${browserInstanceId} was suspended, but its status could not be marked`);
    }
  } finally {
    busy.delete(internalBrowserId);
  }
  logAction(c, 'SUSPEND_BROWSER', browser);
  // htmx follows a redirect without changing the address bar, so ask it to navigate.
  if (c.req.header('HX-Request') === 'true') {
    return c.body(null, 204, { 'HX-Redirect': `/browsers/${browser.publicId}` });
  }
  return c.redirect(`/browsers/${browser.publicId}`, 303);
});

// No confirmation page: resuming loses nothing, so the button on the browser's page acts at once.
routes.post('/:browserId/resume', requireUser, requireWorkspaceRole('User'), requireSubmittedWorkspace, async (c) => {
  const body = await c.req.parseBody();
  const { browser, response } = await loadManagedBrowser(c);
  if (response) {
    return response;
  }
  if (!verifyCsrfToken(c, body.csrf)) {
    return c.html(await renderBrowser(c, { error: 'Your session expired. Please try again.' }), 403);
  }
  // Already resumed, e.g. by a double click: the page shows it running.
  if (browser.status !== 'suspended') {
    return c.redirect(`/browsers/${browser.publicId}`, 303);
  }
  if (busy.has(browser.internalBrowserId)) {
    return c.html(await renderBrowser(c, { error: 'This browser is already being resumed.' }), 409);
  }

  const workspaceId = c.get('workspace').id;
  const { browserInstanceId, internalBrowserId } = browser;
  busy.add(internalBrowserId);
  try {
    const resumed = await resumeBrowser({ browserId: internalBrowserId });
    if (resumed.error) {
      consola.error('resumeBrowser failed:', resumed.error);
      return c.html(await renderBrowser(c, { error: 'Unable to resume the browser. Please try again.' }), 400);
    }
    const marked = await transitionBrowserInstanceStatus({
      workspaceId,
      browserInstanceId,
      fromStatuses: ['suspended'],
      toStatus: 'running'
    });
    if (!marked.data) {
      consola.error(`Browser ${browserInstanceId} was resumed, but its status could not be marked`);
    }
  } finally {
    busy.delete(internalBrowserId);
  }
  // Watch the browser again; best-effort, as at launch.
  void browserMonitors.startBrowserMonitor({ workspaceId, browserInstanceId, internalBrowserId }).then((monitored) => {
    if (monitored.error) {
      consola.error(`Unable to monitor browser ${browserInstanceId}: ${monitored.error}`);
    }
  });
  logAction(c, 'RESUME_BROWSER', browser);
  // htmx follows a redirect without changing the address bar, so ask it to navigate.
  if (c.req.header('HX-Request') === 'true') {
    return c.body(null, 204, { 'HX-Redirect': `/browsers/${browser.publicId}` });
  }
  return c.redirect(`/browsers/${browser.publicId}`, 303);
});
