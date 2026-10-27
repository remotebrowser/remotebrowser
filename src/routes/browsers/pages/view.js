import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { requireUser } from '../../../middleware/auth.js';
import { requireWorkspaceRole } from '../../../middleware/workspace.js';
import { getBrowserInstanceByPublicId, updateBrowserInstanceStatus } from '../../../models/browsers.js';
import { getScreenshot, getSuspendedScreenshot, requestScreenshot } from '../../../screenshots.js';
import { nextBrowserStatus } from '../../../browser.js';
import { readSuspendedPreview } from '../../../vms.js';

export const routes = new Hono();

// NO_SUCH_PAGE means the tab is gone but the browser is still reachable.
const screenshotImpliesConnected = (screenshotResult) =>
  !screenshotResult.error || screenshotResult.error === 'NO_SUCH_PAGE';

// Update status from the capture a miss queued, fire-and-forget. Only a success
// counts: a capture can fail on a busy page, so the monitor decides when a
// browser is unreachable.
const reportOpportunisticStatus = ({ workspaceId, browserInstanceId, currentStatus, screenshotResult }) => {
  if (!screenshotImpliesConnected(screenshotResult)) {
    return;
  }
  const toStatus = nextBrowserStatus({ currentStatus, cdpConnected: true });
  if (toStatus === null) {
    return;
  }
  void updateBrowserInstanceStatus({ workspaceId, browserInstanceId, toStatus }).then((written) => {
    if (written.error) {
      consola.error(`Unable to update the status of browser ${browserInstanceId}: ${written.error}`);
    }
  });
};

// A 1x1 transparent PNG served while the cache warms; the next poll swaps in
// the real frame. PNG, not JPEG: JPEG has no transparency.
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

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
  const browserId = instance.data.internalBrowserId;
  // Read the in-memory frame, else the one saved on disk; a miss queues a
  // capture and answers with a placeholder, so the request never waits on a
  // CDP dial.
  const frame = await getScreenshot(browserId, pageId);
  if (!frame) {
    void requestScreenshot(browserId, pageId).then((screenshotResult) =>
      reportOpportunisticStatus({
        workspaceId: workspace.id,
        browserInstanceId: instance.data.browserInstanceId,
        currentStatus: instance.data.status,
        screenshotResult
      })
    );
  }
  // Never cache this screenshot; Pragma/Expires cover old HTTP/1.0 caches.
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  // body() needs plain-ArrayBuffer-backed Uint8Array; copy the Buffer.
  return frame
    ? c.body(new Uint8Array(frame.data), 200, { 'Content-Type': 'image/jpeg' })
    : c.body(new Uint8Array(TRANSPARENT_PNG), 200, { 'Content-Type': 'image/png' });
});

// The picture of a page saved when its browser was suspended. It goes away
// once the browser resumes.
routes.get('/:browserId/pages/:pageId/suspended', requireUser, requireWorkspaceRole('User'), async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const instance = await getBrowserInstanceByPublicId({
    workspaceId: workspace.id,
    publicId: c.req.param('browserId'),
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  if (instance.error || !instance.data?.internalBrowserId) {
    return c.text('Not found', 404);
  }
  const image = await readSuspendedPreview({
    browserId: instance.data.internalBrowserId,
    pageId: c.req.param('pageId')
  });
  if (!image) {
    return c.text('Not found', 404);
  }
  c.header('Cache-Control', 'no-store');
  return c.body(new Uint8Array(image), 200, { 'Content-Type': 'image/jpeg' });
});

// The first page's frame, for thumbnails that only know the browser.
routes.get('/:browserId/view', requireUser, requireWorkspaceRole('User'), async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const instance = await getBrowserInstanceByPublicId({
    workspaceId: workspace.id,
    publicId: c.req.param('browserId'),
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  if (instance.error || !instance.data) {
    return c.text('Not found', 404);
  }
  if (!instance.data.internalBrowserId) {
    return c.text('The browser is still starting.', 503);
  }
  const browserId = instance.data.internalBrowserId;
  // A suspended VM cannot list its pages, so it is never captured.
  const frame =
    instance.data.status === 'suspended' ? await getSuspendedScreenshot(browserId) : await getScreenshot(browserId);
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  return frame
    ? c.body(new Uint8Array(frame.data), 200, { 'Content-Type': 'image/jpeg' })
    : c.body(new Uint8Array(TRANSPARENT_PNG), 200, { 'Content-Type': 'image/png' });
});
