import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../render.js';
import { createCsrfToken, verifyCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import {
  requireWorkspaceRole,
  requireSubmittedWorkspace,
  buildBrowsersBreadcrumbs,
  loadWorkspaceSwitcherItems
} from '../../middleware/workspace.js';
import { getBrowserInstanceByPublicId, deleteBrowserInstance } from '../../models/browsers.js';
import { stopBrowser } from '../../fleet.js';
import { formString } from '../../form.js';

export const routes = new Hono();

const loadBrowser = async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const result = await getBrowserInstanceByPublicId({
    workspaceId: workspace.id,
    publicId: c.req.param('browserId'),
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  return result.error || !result.data ? null : result.data;
};

const renderTerminate = async (c, data = {}) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  return eta.render('browsers/terminate', {
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

routes.get('/:browserId/terminate', requireUser, requireWorkspaceRole('User'), async (c) => {
  const browser = await loadBrowser(c);
  return browser ? c.html(renderTerminate(c, { browser })) : c.text('Not found', 404);
});

routes.post(
  '/:browserId/terminate',
  requireUser,
  requireWorkspaceRole('User'),
  requireSubmittedWorkspace,
  async (c) => {
    const body = await c.req.parseBody();
    const browser = await loadBrowser(c);
    if (!browser) {
      return c.text('Not found', 404);
    }
    if (!verifyCsrfToken(c, body.csrf)) {
      return c.html(await renderTerminate(c, { browser, error: 'Your session expired. Please try again.' }), 403);
    }
    // The typed name is the only guard; it must match exactly.
    if (formString(body.name).trim() !== browser.browserName) {
      return c.html(
        await renderTerminate(c, { browser, error: 'That name does not match. The browser was not terminated.' }),
        400
      );
    }

    const user = c.get('user');
    const workspace = c.get('workspace');

    const stopped = await stopBrowser({ browserId: browser.internalBrowserId });
    if (stopped.error) {
      consola.error('stopBrowser failed:', stopped.error);
      return c.html(
        await renderTerminate(c, { browser, error: 'Unable to terminate the browser. Please try again.' }),
        400
      );
    }
    const removedInstance = await deleteBrowserInstance({
      workspaceId: workspace.id,
      browserInstanceId: browser.browserInstanceId
    });
    if (removedInstance.error) {
      consola.error('deleteBrowserInstance failed:', removedInstance.error);
      return c.html(
        await renderTerminate(c, { browser, error: 'Unable to terminate the browser. Please try again.' }),
        400
      );
    }

    consola.info('TERMINATE_BROWSER', {
      'event.domain': 'browser',
      'user.id': user.id,
      'user.email': user.email,
      'workspace.id': workspace.id,
      'browser.public_id': browser.publicId
    });
    return c.redirect('/browsers', 303);
  }
);
