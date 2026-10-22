import { consola } from 'consola/basic';
import {
  browserCdpUrl,
  canSaveBrowserScreenshots,
  readAnyBrowserScreenshot,
  readBrowserScreenshot,
  saveBrowserScreenshot
} from './fleet.js';
import { listBrowserPages } from './cdp.js';
import { createScreenshotPool } from './workers/screenshot.js';

// A cached frame older than this is served once and refreshed in the background.
const SCREENSHOT_MAX_AGE = 3000;

// A frame nobody read for this long is dropped; the next read queues a capture.
const SCREENSHOT_INACTIVE = 10 * 60 * 1000;

// The frame key: browser and page ids joined with ':', which neither can contain.
const screenshotKey = ({ browserId, pageId }) => `${browserId}:${pageId}`;

// The state these functions share: the frame cache, the in-flight captures, and the worker pool.
/** @type {{screenshots: Map<string, {browserId: string, pageId: string, data: Buffer, timestamp: number}>, inFlight: Map<string, Promise<{ok?: true, error?: string}>>, firstPages: Map<string, string>, resolving: Set<string>, listPages: Function, pool: {capture: Function, close: Function} | null}} */
const cache = {
  screenshots: new Map(),
  inFlight: new Map(),
  // The last known first page per browser, so a read without a page id never waits on CDP.
  firstPages: new Map(),
  resolving: new Set(),
  listPages: listBrowserPages,
  pool: null
};

const capturePool = () => (cache.pool ??= createScreenshotPool());

// Capture one page over the pool; a miss is reported, not thrown.
const capturePage = async (browserId, pageId, url) => {
  const shot = await capturePool().capture({ browserId, pageId, url });
  if (shot.error || !shot.data) {
    consola.debug(`screenshot capture failed for ${browserId}:${pageId}: ${shot.error}`);
    return { error: shot.error ?? 'NO_DATA' };
  }
  cache.screenshots.set(screenshotKey({ browserId, pageId }), {
    browserId,
    pageId,
    data: shot.data,
    timestamp: Date.now()
  });
  if (canSaveBrowserScreenshots()) {
    void saveBrowserScreenshot({ browserId, pageId, jpeg: shot.data });
  }
  return { ok: true };
};

const refreshPage = async (browserId, pageId) => {
  const url = await browserCdpUrl({ browserId });
  if (!url) {
    consola.debug(`screenshot capture could not find the CDP URL of ${browserId}`);
    return { error: 'CDP_URL_UNAVAILABLE' };
  }
  return capturePage(browserId, pageId, url);
};

// Queue one capture per page, reusing an in-flight one so reads cannot stack workers.
const requestScreenshot = (browserId, pageId) => {
  const key = screenshotKey({ browserId, pageId });
  const pending = cache.inFlight.get(key);
  if (pending) {
    return pending;
  }
  const capture = refreshPage(browserId, pageId)
    .catch((error) => {
      consola.debug(`screenshot capture failed for ${browserId}:${pageId}: ${String(error)}`);
      return { error: 'CAPTURE_FAILED' };
    })
    .finally(() => {
      cache.inFlight.delete(key);
    });
  cache.inFlight.set(key, capture);
  return capture;
};

// Look up the browser's first page in the background and remember it for the next read.
const resolveFirstPage = (browserId) => {
  if (cache.resolving.has(browserId)) {
    return;
  }
  cache.resolving.add(browserId);
  void cache
    .listPages({ browserId })
    .then((listed) => {
      const first = listed.data?.[0]?.targetId;
      if (first) {
        cache.firstPages.set(browserId, first);
      } else {
        cache.firstPages.delete(browserId);
      }
    })
    .catch((error) => consola.debug(`first page lookup failed for ${browserId}: ${String(error)}`))
    .finally(() => cache.resolving.delete(browserId));
};

// A frame saved on disk outlives the app, so after a restart a page has a
// picture before its first capture. It keeps the file's time, so a stale one
// is refreshed as usual.
const readSavedFrame = async (browserId, pageId) => {
  if (!canSaveBrowserScreenshots()) {
    return null;
  }
  const saved = await readBrowserScreenshot({ browserId, pageId });
  if (!saved) {
    return null;
  }
  const key = screenshotKey({ browserId, pageId });
  // A capture may have landed during the read, and it is newer.
  const current = cache.screenshots.get(key);
  if (current) {
    return current;
  }
  const frame = { browserId, pageId, data: saved.data, timestamp: saved.timestamp };
  cache.screenshots.set(key, frame);
  return frame;
};

// Serve the cached frame, else the one saved on disk; a missing or stale one
// also queues a fresh capture. No pageId means the first page, which stays
// unknown until the background lookup finds it.
const getScreenshot = async (browserId, pageId = '') => {
  if (!pageId) {
    // Re-check each read so the thumbnail follows the first tab when it changes.
    resolveFirstPage(browserId);
    pageId = cache.firstPages.get(browserId) ?? '';
    if (!pageId) {
      return null;
    }
  }
  const cached = cache.screenshots.get(screenshotKey({ browserId, pageId }));
  if (!cached) {
    void requestScreenshot(browserId, pageId);
    return readSavedFrame(browserId, pageId);
  }
  if (Date.now() - cached.timestamp > SCREENSHOT_MAX_AGE) {
    void requestScreenshot(browserId, pageId);
  }
  return cached;
};

// A suspended VM cannot list its pages or be captured, so this never queues a
// capture. It serves the first page's frame from memory, often the last live
// one, else any picture saved in the VM dir, which is then kept in memory
// under its page, as the first page.
const getSuspendedScreenshot = async (browserId) => {
  const pageId = cache.firstPages.get(browserId);
  const cached = pageId ? cache.screenshots.get(screenshotKey({ browserId, pageId })) : undefined;
  if (cached) {
    return cached;
  }
  const saved = await readAnyBrowserScreenshot({ browserId });
  if (!saved) {
    return null;
  }
  const key = screenshotKey({ browserId, pageId: saved.pageId });
  const frame = cache.screenshots.get(key) ?? { browserId, ...saved };
  cache.screenshots.set(key, frame);
  cache.firstPages.set(browserId, saved.pageId);
  return frame;
};

// A fresh frame of every open page, in tab order, e.g. to keep a picture of a
// browser past a suspend. A page that fails to capture is left out.
const captureAllPages = async (browserId) => {
  const listed = await cache.listPages({ browserId });
  if (listed.error || !listed.data) {
    return [];
  }
  const frames = await Promise.all(
    listed.data.map(async ({ targetId: pageId, title, url }) => {
      const captured = await requestScreenshot(browserId, pageId);
      const frame = cache.screenshots.get(screenshotKey({ browserId, pageId }));
      return captured.error || !frame ? null : { pageId, title, url, data: frame.data };
    })
  );
  return frames.filter((frame) => frame !== null);
};

// Clean up frames idle for too long; deleting is safe because a later read re-queues a capture.
const cleanupScreenshots = (now = Date.now()) => {
  for (const [key, frame] of cache.screenshots) {
    if (now - frame.timestamp > SCREENSHOT_INACTIVE) {
      cache.screenshots.delete(key);
    }
  }
};

const stopScreenshots = async () => {
  const closing = cache.pool;
  cache.pool = null;
  if (closing) {
    await closing.close();
  }
  cache.screenshots.clear();
  cache.inFlight.clear();
  cache.firstPages.clear();
};

export {
  getScreenshot,
  getSuspendedScreenshot,
  requestScreenshot,
  captureAllPages,
  stopScreenshots,
  cleanupScreenshots,
  cache
};
