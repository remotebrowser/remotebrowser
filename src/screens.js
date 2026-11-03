import { captureBrowserScreen, readBrowserScreenshot, saveBrowserScreenshot } from './vms.js';

// The whole screen of a VM, while its browser starts. It is read over VNC in
// the background, so a request never waits on VNC, and a failed read keeps
// the last good frame instead of a blank one.

// Between the end of one VNC read and the start of the next, as often as the
// page asks for a frame (see screen-refresh.eta.html).
const SCREEN_INTERVAL = 700;

// A screen nobody read for this long stops being captured.
const SCREEN_IDLE = 10000;

// Saved in the VM dir like a page's frame, so it outlives the app.
const SCREEN_PAGE_ID = 'screen';

/** @type {{screens: Map<string, {frame: {data: Buffer, timestamp: number} | null, lastRead: number, timer: NodeJS.Timeout | null, first: Promise<void> | null}>, capture: Function, interval: number, idle: number}} */
const cache = {
  screens: new Map(),
  capture: (browserId) => captureBrowserScreen({ browserId }),
  interval: SCREEN_INTERVAL,
  idle: SCREEN_IDLE
};

const captureOnce = async (browserId, entry) => {
  const data = await cache.capture(browserId);
  if (data) {
    entry.frame = { data, timestamp: Date.now() };
    void saveBrowserScreenshot({ browserId, pageId: SCREEN_PAGE_ID, jpeg: data });
  }
};

// One read at a time per VM; the next is scheduled after the last one ends, so
// a slow VNC server cannot stack them up.
const scheduleNext = (browserId, entry) => {
  entry.timer = setTimeout(async () => {
    if (cache.screens.get(browserId) !== entry) {
      return;
    }
    if (Date.now() - entry.lastRead > cache.idle) {
      cache.screens.delete(browserId);
      return;
    }
    await captureOnce(browserId, entry);
    if (cache.screens.get(browserId) === entry) {
      scheduleNext(browserId, entry);
    }
  }, cache.interval);
  entry.timer.unref?.();
};

const startCapture = (browserId) => {
  const entry = { frame: null, lastRead: Date.now(), timer: null, first: null };
  cache.screens.set(browserId, entry);
  entry.first = (async () => {
    entry.frame ??= await readBrowserScreenshot({ browserId, pageId: SCREEN_PAGE_ID });
    const captured = captureOnce(browserId, entry).finally(() => {
      if (cache.screens.get(browserId) === entry) {
        scheduleNext(browserId, entry);
      }
    });
    // A frame saved by an earlier run is shown at once; without one, the
    // first read waits for VNC.
    if (!entry.frame) {
      await captured;
    }
  })().finally(() => {
    entry.first = null;
  });
  return entry;
};

/**
 * The newest frame of a running VM's screen, or null when there is none yet.
 * Each read keeps the background capture going for a while.
 * @param {string} browserId
 * @returns {Promise<{data: Buffer, timestamp: number} | null>}
 */
const getScreen = async (browserId) => {
  const entry = cache.screens.get(browserId) ?? startCapture(browserId);
  entry.lastRead = Date.now();
  // Only the first read waits, so the page starts with a picture.
  if (!entry.frame && entry.first) {
    await entry.first;
  }
  return entry.frame;
};

/**
 * Whether a browser shows its VM screen rather than its pages: while it
 * starts, before CDP answers.
 * @param {{status: string, internalBrowserId?: string | null}} browser
 * @returns {boolean}
 */
const showsScreen = ({ status, internalBrowserId }) => Boolean(internalBrowserId) && status === 'starting';

/**
 * Whether the VM screen can be read at all: its VM runs, whether or not CDP
 * answers. On Linux, it stands in for the pages until CDP lists one.
 * @param {{status: string, internalBrowserId?: string | null}} browser
 * @returns {boolean}
 */
const hasScreen = ({ status, internalBrowserId }) =>
  Boolean(internalBrowserId) && (status === 'starting' || status === 'running');

const stopScreens = () => {
  for (const entry of cache.screens.values()) {
    clearTimeout(entry.timer ?? undefined);
  }
  cache.screens.clear();
};

export { getScreen, hasScreen, showsScreen, stopScreens, cache };
