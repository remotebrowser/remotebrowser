import { Hono } from 'hono';
import { requireUser } from '../../../middleware/auth.js';
import { requireWorkspaceRole } from '../../../middleware/workspace.js';
import { getBrowserInstanceByPublicId } from '../../../models/browsers.js';
import { nextFrame } from '../../../screencast.js';

export const routes = new Hono();

// Long poll: a still page sends no frame, so the wait ends with 204.
routes.get('/:browserId/pages/:pageId/frame', requireUser, requireWorkspaceRole('User'), async (c) => {
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
  const after = Number.parseInt(c.req.query('after') ?? '0', 10);
  const result = await nextFrame({
    browserId: instance.data.internalBrowserId,
    pageId: c.req.param('pageId'),
    after: Number.isSafeInteger(after) && after > 0 ? after : 0,
    signal: c.req.raw.signal
  });
  c.header('Cache-Control', 'no-store');
  if (result.error === 'NO_SUCH_PAGE') {
    return c.text('Not found', 404);
  }
  if (result.error) {
    return c.text('The live view is unavailable.', 502);
  }
  if (!result.data) {
    return c.body(null, 204);
  }
  c.header('X-Frame-Seq', String(result.data.seq));
  // The response body needs a Uint8Array with its own ArrayBuffer, so copy the Buffer.
  return c.body(new Uint8Array(result.data.data), 200, { 'Content-Type': 'image/jpeg' });
});
