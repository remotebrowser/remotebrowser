import { consola } from 'consola/basic';
import { browserCdpUrl } from './fleet.js';
import { createScreenshotPool } from './workers/screenshot.js';

// A cached frame older than this is served once and refreshed in the background.
const SCREENSHOT_MAX_AGE = 3000;

// A frame nobody read for this long is dropped; the next read queues a capture.
const SCREENSHOT_INACTIVE = 10 * 60 * 1000;

// The frame key: browser and page ids joined with ':', which neither can contain.
const screenshotKey = ({ browserId, pageId }) => `${browserId}:${pageId}`;

// The state these functions share: the frame cache, the in-flight captures, and the worker pool.
/** @type {{screenshots: Map<string, {browserId: string, pageId: string, data: Buffer, timestamp: number}>, inFlight: Map<string, Promise<{ok?: true, error?: string}>>, pool: {capture: Function, close: Function} | null}} */
const cache = {
  screenshots: new Map(),
  inFlight: new Map(),
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

// Serve the cached frame; a missing or stale one also queues a fresh capture.
const getScreenshot = (browserId, pageId) => {
  const cached = cache.screenshots.get(screenshotKey({ browserId, pageId }));
  if (!cached) {
    void requestScreenshot(browserId, pageId);
    return null;
  }
  if (Date.now() - cached.timestamp > SCREENSHOT_MAX_AGE) {
    void requestScreenshot(browserId, pageId);
  }
  return cached;
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
};

export { getScreenshot, requestScreenshot, stopScreenshots, cleanupScreenshots, cache };
