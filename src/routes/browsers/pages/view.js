import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { requireUser } from '../../../middleware/auth.js';
import { requireWorkspaceRole } from '../../../middleware/workspace.js';
import { getBrowserInstanceByPublicId, updateBrowserInstanceStatus } from '../../../models/browsers.js';
import { capturePageScreenshot } from '../../../cdp.js';
import { nextBrowserStatus } from '../../../browser.js';

export const routes = new Hono();

// NO_SUCH_PAGE means the tab is gone but the browser is still reachable.
const screenshotImpliesConnected = (screenshotResult) =>
  !screenshotResult.error || screenshotResult.error === 'NO_SUCH_PAGE';

// Update status via the existing screenshot dial, fire-and-forget.
const reportOpportunisticStatus = ({ workspaceId, browserInstanceId, currentStatus, screenshotResult }) => {
  const toStatus = nextBrowserStatus({
    currentStatus,
    cdpConnected: screenshotImpliesConnected(screenshotResult)
  });
  if (toStatus === null) {
    return;
  }
  void updateBrowserInstanceStatus({ workspaceId, browserInstanceId, toStatus }).then((written) => {
    if (written.error) {
      consola.error(`Unable to update the status of browser ${browserInstanceId}: ${written.error}`);
    }
  });
};

routes.get('/:browserId/pages/:pageId/view', requireUser, requireWorkspaceRole('User'), async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const pageId = c.req.param('pageId');
  const instance = await getBrowserInstanceByPublicId({
    workspaceId: workspace.id,
    publicId: c.req.param('browserId'),
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  if (instance.error || !instance.data) {
    return c.text('Not found', 404);
  }
  // Same signal the browser's own page (src/routes/browsers/show.js) uses:
  // empty until recordProvisionedBrowser() writes it back.
  if (!instance.data.internalBrowserId) {
    return c.text('The browser is still starting.', 503);
  }
  // ?t= varies the <img> URL per poll so browsers don't skip re-fetching.
  const screenshot = await capturePageScreenshot({ browserId: instance.data.internalBrowserId, pageId });
  reportOpportunisticStatus({
    workspaceId: workspace.id,
    browserInstanceId: instance.data.browserInstanceId,
    currentStatus: instance.data.status,
    screenshotResult: screenshot
  });
  if (screenshot.error === 'NO_SUCH_PAGE') {
    return c.text('This page is no longer open.', 404);
  }
  if (screenshot.error) {
    consola.error('capturePageScreenshot failed:', screenshot.error);
    return c.text('Unable to capture a screenshot of this page.', 502);
  }
  // Never cache this screenshot; Pragma/Expires cover old HTTP/1.0 caches.
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  // body() needs plain-ArrayBuffer-backed Uint8Array; copy the Buffer.
  return c.body(new Uint8Array(screenshot.data), 200, { 'Content-Type': 'image/png' });
});
