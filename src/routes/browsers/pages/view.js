import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { requireUser } from '../../../middleware/auth.js';
import { requireWorkspaceRole } from '../../../middleware/workspace.js';
import { getBrowserInstanceByPublicId, updateBrowserInstanceStatus } from '../../../models/browsers.js';
import { getScreenshot, getSuspendedScreenshot, requestScreenshot } from '../../../screenshots.js';
import { nextBrowserStatus } from '../../../browser.js';
import { readSuspendedPreview } from '../../../vms.js';
import { getScreen, hasScreen, showsScreen } from '../../../screens.js';
import { encodeFrame, viewerWidth } from '../../../screencast.js';

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

// A black screen at the default size, served until the VM screen can be
// read, so the preview has its shape from the start. SVG, so it stays tiny.
const BLACK_SCREEN = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="100%" height="100%"/></svg>'
);

// The newest picture of a live browser, from the best source that has one:
// its first page over CDP, then its VM screen over VNC. Null before its VM
// runs, or once it stops.
const liveFrame = async (browser) => {
  if (!hasScreen(browser)) {
    return null;
  }
  const browserId = browser.internalBrowserId;
  // No CDP while it starts.
  const cdpFrame = showsScreen(browser) ? null : await getScreenshot(browserId);
  return cdpFrame ?? getScreen(browserId);
};

// WebP, sized to the viewer's `w` and `dpr`, like the CDP screencast
// (screencast.js). Each width is encoded once per frame, for all viewers.
const sendLiveFrame = async (c, frame) => {
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  c.header('Pragma', 'no-cache');
  c.header('Expires', '0');
  if (!frame) {
    return c.body(new Uint8Array(BLACK_SCREEN), 200, { 'Content-Type': 'image/svg+xml' });
  }
  try {
    const body = await encodeFrame(frame, viewerWidth({ w: c.req.query('w'), dpr: c.req.query('dpr') }));
    return c.body(new Uint8Array(body), 200, { 'Content-Type': 'image/webp' });
  } catch {
    // A frame that cannot be decoded is no worse than none yet.
    return c.body(new Uint8Array(BLACK_SCREEN), 200, { 'Content-Type': 'image/svg+xml' });
  }
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
  const { internalBrowserId, status } = instance.data;
  // A suspended VM cannot list its pages, so it is never captured.
  if (status === 'suspended' && internalBrowserId) {
    const frame = await getSuspendedScreenshot(internalBrowserId);
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    c.header('Pragma', 'no-cache');
    c.header('Expires', '0');
    return frame
      ? c.body(new Uint8Array(frame.data), 200, { 'Content-Type': 'image/jpeg' })
      : c.body(new Uint8Array(TRANSPARENT_PNG), 200, { 'Content-Type': 'image/png' });
  }
  return sendLiveFrame(c, await liveFrame(instance.data));
});

// The preview of a browser with no page to show: while it starts, or until
// CDP lists a page. Black until the VM screen can be read over VNC.
routes.get('/:browserId/screen', requireUser, requireWorkspaceRole('User'), async (c) => {
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
  return sendLiveFrame(c, await liveFrame(instance.data));
});
