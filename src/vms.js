import { DEFAULT_OS, vms, isWellFormedBrowserId } from './vm/index.js';

// The facade over the in-process QEMU VM manager (src/vm/). It turns
// thrown errors into `{ error }` results, so callers never need a try block.

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

// Runs a VM call as `{ data }` or `{ error }`. A malformed id never reaches the
// VM manager, since it ends up in file paths.
const attempt = async (browserId, run) => {
  if (!isWellFormedBrowserId(browserId)) {
    return { error: 'INVALID_BROWSER_ID' };
  }
  try {
    return { data: await run() };
  } catch (error) {
    return { error: errorMessage(error) };
  }
};

// For changes, which have no result to report.
const changeBrowser = (browserId, change) =>
  attempt(browserId, async () => {
    await change();
    return true;
  });

// For reads where a missing answer is as good as a failed one.
const orFallback = async (browserId, run, fallback) => {
  const result = await attempt(browserId, run);
  return result.error ? fallback : (result.data ?? fallback);
};

/**
 * Starts a browser in a local VM of `os` (see src/vm/os.js), optionally with
 * an upstream `proxy` URL (see src/vm/proxy.js), a `screenResolution`, the
 * screen size (see src/vm/screen-resolution.js), and a `screenScale` in
 * percent (see src/vm/screen-scale.js).
 * @param {{os?: string, proxy?: string | null, screenResolution?: {width: number, height: number} | null, screenScale?: number | null}} [params]
 * @returns {Promise<{data?: {browserId: string}, error?: string}>}
 */
const startBrowser = async ({ os = DEFAULT_OS, proxy = null, screenResolution = null, screenScale = null } = {}) => {
  try {
    const { browserId } = await vms.launchBrowser({ os, proxy, screenResolution, screenScale });
    if (!isWellFormedBrowserId(browserId)) {
      return { error: 'INVALID_BROWSER_ID' };
    }
    return { data: { browserId } };
  } catch (error) {
    return { error: errorMessage(error) };
  }
};

/**
 * Whether a browser can be started now, on any OS. That needs a VM snapshot,
 * which the server saves in the background at startup.
 * @returns {Promise<{data?: boolean, error?: string}>}
 */
const canStartBrowser = async () => {
  try {
    return { data: await vms.canLaunchBrowser() };
  } catch (error) {
    return { error: errorMessage(error) };
  }
};

/**
 * The OSes that a browser can be started on now, as names from src/vm/os.js.
 * @returns {Promise<{data?: string[], error?: string}>}
 */
const listLaunchableOses = async () => {
  try {
    return { data: await vms.launchableOses() };
  } catch (error) {
    return { error: errorMessage(error) };
  }
};

/**
 * Checks that a browser id still names a live browser. The CDP relay calls this
 * before dialing, so a stopped browser is refused cleanly instead of failing
 * with an unexplained close code. A missing browser is `{ data: false }`; a
 * failure of the check itself is an error, so the caller answers 503.
 * @param {{browserId: string}} params
 * @returns {Promise<{data?: boolean, error?: string}>}
 */
const browserExists = async ({ browserId }) =>
  isWellFormedBrowserId(browserId) ? attempt(browserId, () => vms.browserIsRunning(browserId)) : { data: false };

/**
 * Stops a browser, removing its VM. Called when a collaborator
 * terminates it. Already stopped or never started is success: no browser is
 * left running either way.
 * @param {{browserId: string}} params
 * @returns {Promise<{data?: true, error?: string}>}
 */
const stopBrowser = async ({ browserId }) => {
  if (typeof browserId !== 'string' || browserId === '') {
    return { data: true };
  }
  // A non-empty id that fails the shape check is corruption, not an unprovisioned browser.
  return attempt(browserId, async () => {
    // A browser that is already gone is the caller's goal already being true.
    if (await vms.browserExists(browserId)) {
      await vms.stopBrowser(browserId);
    }
    return true;
  });
};

/**
 * Suspends a browser: its VM saves its memory to disk and stops, which frees
 * that memory. A failed suspend leaves the browser running. `previews`, a
 * picture of each page taken just before, are kept to show while it is
 * suspended.
 * @param {{browserId: string, previews?: {pageId: string, title: string, url: string, data: Buffer}[]}} params
 * @returns {Promise<{data?: true, error?: string}>}
 */
const suspendBrowser = ({ browserId, previews = [] }) =>
  changeBrowser(browserId, () => vms.suspendBrowser(browserId, { previews }));

/**
 * Resumes a suspended browser where it was. A failed resume keeps it
 * suspended, so it can be tried again.
 * @param {{browserId: string}} params
 * @returns {Promise<{data?: true, error?: string}>}
 */
const resumeBrowser = ({ browserId }) => changeBrowser(browserId, () => vms.resumeBrowser(browserId));

/**
 * The pages a suspended browser had when it was suspended, each with a saved
 * picture. None when there are no pictures.
 * @param {{browserId: string}} params
 * @returns {Promise<{pageId: string, title: string, url: string}[]>}
 */
const listSuspendedPreviews = ({ browserId }) => orFallback(browserId, () => vms.listSuspendedPreviews(browserId), []);

/**
 * The saved picture of one page of a suspended browser, as a JPEG, or null.
 * @param {{browserId: string, pageId: string}} params
 * @returns {Promise<Buffer | null>}
 */
const readSuspendedPreview = ({ browserId, pageId }) =>
  orFallback(browserId, () => vms.readSuspendedPreview(browserId, pageId), null);

/**
 * Saves the latest frame of a page in its VM dir.
 * @param {{browserId: string, pageId: string, jpeg: Buffer}} params
 * @returns {Promise<void>}
 */
const saveBrowserScreenshot = async ({ browserId, pageId, jpeg }) => {
  // Nothing depends on the file, so a failure is ignored.
  await attempt(browserId, () => vms.saveScreenshot(browserId, pageId, jpeg));
};

/**
 * The frame of a page saved by saveBrowserScreenshot, or null.
 * @param {{browserId: string, pageId: string}} params
 * @returns {Promise<{data: Buffer, timestamp: number} | null>}
 */
const readBrowserScreenshot = ({ browserId, pageId }) =>
  orFallback(browserId, () => vms.readSavedScreenshot(browserId, pageId), null);

/**
 * Any saved picture of a VM, for when its pages cannot be listed, e.g. while
 * it is suspended, with its page and when it was taken. Null when there is
 * none.
 * @param {{browserId: string}} params
 * @returns {Promise<{pageId: string, data: Buffer, timestamp: number} | null>}
 */
const readAnyBrowserScreenshot = ({ browserId }) =>
  orFallback(browserId, () => vms.readAnySavedScreenshot(browserId), null);

/**
 * Sends a running browser's traffic through an upstream proxy, e.g.
 * `http://user:password@host:8080` (see src/vm/proxy.js).
 * @param {string} browserId
 * @param {string} proxy
 * @returns {Promise<{data?: true, error?: string}>}
 */
const setBrowserProxy = (browserId, proxy) => changeBrowser(browserId, () => vms.setProxy(browserId, proxy));

/**
 * Removes a running browser's upstream proxy, so it connects directly.
 * @param {string} browserId
 * @returns {Promise<{data?: true, error?: string}>}
 */
const clearBrowserProxy = (browserId) => changeBrowser(browserId, () => vms.clearProxy(browserId));

/**
 * Sets a running browser's screen size, e.g. `{width: 2560, height: 1440}`,
 * or the default for null (see src/vm/screen-resolution.js). The browser keeps running,
 * maximized on the new screen.
 * @param {string} browserId
 * @param {{width: number, height: number} | null} screenResolution
 * @returns {Promise<{data?: true, error?: string}>}
 */
const setBrowserScreenResolution = (browserId, screenResolution) =>
  changeBrowser(browserId, () => vms.setScreenResolution(browserId, screenResolution));

/**
 * Sets a running browser's screen scale in percent, e.g. 150, or the default
 * for null (see src/vm/screen-scale.js). The browser keeps running, and
 * follows the new scale a moment later.
 * @param {string} browserId
 * @param {number | null} screenScale
 * @returns {Promise<{data?: true, error?: string}>}
 */
const setBrowserScreenScale = (browserId, screenScale) =>
  changeBrowser(browserId, () => vms.setScreenScale(browserId, screenScale));

/**
 * Builds the CDP websocket URL for a browser. It is discovered from the VM's
 * CDP endpoint, which needs the VM to be up, so this is async. Returns null
 * when no URL can be resolved.
 * @param {{browserId: string}} params
 * @returns {Promise<string | null>}
 */
const browserCdpUrl = ({ browserId }) => orFallback(browserId, () => vms.resolveCdpUrl(browserId), null);

export {
  isWellFormedBrowserId,
  startBrowser,
  canStartBrowser,
  listLaunchableOses,
  browserExists,
  browserCdpUrl,
  stopBrowser,
  suspendBrowser,
  resumeBrowser,
  listSuspendedPreviews,
  readSuspendedPreview,
  saveBrowserScreenshot,
  readBrowserScreenshot,
  readAnyBrowserScreenshot,
  setBrowserProxy,
  clearBrowserProxy,
  setBrowserScreenResolution,
  setBrowserScreenScale
};
