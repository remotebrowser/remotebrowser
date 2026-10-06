import { config } from './config.js';
import { containers, isWellFormedBrowserId } from './container.js';

// The fleet facade. By default it drives the in-process container manager
// (src/container.js, podman or docker); when BROWSERFLEET_URL is set it
// delegates to an external podman-fleet server instead, which is useful for
// remote fleets and tests.

// An external fleet request that does not answer this soon is treated as dead.
const FLEET_TIMEOUT = 10000;

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

const startBrowserOnFleet = async () => {
  /** @type {Response} */
  let response;
  try {
    // No trailing slash: the server has no POST for the collection path, only
    // /{browser_id}, and answers 405 instead of redirecting.
    response = await fetch(`${config.browserFleetUrl}/api/v1/browsers`, {
      method: 'POST',
      signal: AbortSignal.timeout(FLEET_TIMEOUT)
    });
  } catch {
    return { error: 'NETWORK' };
  }
  if (!response.ok) {
    return { error: `HTTP ${response.status}` };
  }
  /** @type {any} */
  const data = await response.json().catch(() => null);
  const browserId = data && typeof data.browser_id === 'string' ? data.browser_id : '';
  if (!browserId) {
    return { error: 'MISSING_BROWSER_ID' };
  }
  // Refuse a traversal-shaped id before it is stored and used in request paths.
  if (!isWellFormedBrowserId(browserId)) {
    return { error: 'INVALID_BROWSER_ID' };
  }
  return { data: { browserId } };
};

const startBrowserLocally = async () => {
  try {
    const { browserId } = await containers.launchBrowser();
    if (!isWellFormedBrowserId(browserId)) {
      return { error: 'INVALID_BROWSER_ID' };
    }
    return { data: { browserId } };
  } catch (error) {
    return { error: errorMessage(error) };
  }
};

/**
 * Starts a browser, either on an external fleet server or in a local container.
 * @returns {Promise<{data?: {browserId: string}, error?: string}>}
 */
const startBrowser = async () => (config.browserFleetUrl ? startBrowserOnFleet() : startBrowserLocally());

const checkFleetHealth = async () => {
  /** @type {Response} */
  let response;
  try {
    response = await fetch(`${config.browserFleetUrl}/health`, {
      signal: AbortSignal.timeout(FLEET_TIMEOUT)
    });
  } catch {
    return { error: 'NETWORK' };
  }
  if (response.status !== 200) {
    return { error: `HTTP ${response.status}` };
  }
  return { data: { healthy: true } };
};

const checkLocalHealth = async () => {
  try {
    await containers.health();
    return { data: { healthy: true } };
  } catch (error) {
    return { error: errorMessage(error) };
  }
};

/**
 * Checks that a browser can be provisioned once at startup, before the server
 * binds a port. A broken fleet is fatal here, not later: every browser record
 * written after startup would just sit unprovisioned.
 * @returns {Promise<{data?: {healthy: true}, error?: string}>}
 */
const checkBrowserFleetHealth = async () => (config.browserFleetUrl ? checkFleetHealth() : checkLocalHealth());

const browserExistsOnFleet = async ({ browserId }) => {
  /** @type {Response} */
  let response;
  try {
    response = await fetch(`${config.browserFleetUrl}/api/v1/browsers/${encodeURIComponent(browserId)}`, {
      signal: AbortSignal.timeout(FLEET_TIMEOUT)
    });
  } catch {
    return { error: 'NETWORK' };
  }
  if (response.status === 404) {
    return { data: false };
  }
  if (!response.ok) {
    return { error: `HTTP ${response.status}` };
  }
  return { data: true };
};

const browserExistsLocally = async ({ browserId }) => {
  try {
    return { data: await containers.browserIsRunning(browserId) };
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
const browserExists = async ({ browserId }) => {
  if (!isWellFormedBrowserId(browserId)) {
    return { data: false };
  }
  return config.browserFleetUrl ? browserExistsOnFleet({ browserId }) : browserExistsLocally({ browserId });
};

const stopBrowserOnFleet = async ({ browserId }) => {
  /** @type {Response} */
  let response;
  try {
    response = await fetch(`${config.browserFleetUrl}/api/v1/browsers/${encodeURIComponent(browserId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(FLEET_TIMEOUT)
    });
  } catch {
    return { error: 'NETWORK' };
  }
  if (!response.ok && response.status !== 404) {
    return { error: `HTTP ${response.status}` };
  }
  return { data: true };
};

const stopBrowserLocally = async ({ browserId }) => {
  try {
    // A browser that is already gone is the caller's goal already being true.
    if (!(await containers.browserExists(browserId))) {
      return { data: true };
    }
    await containers.stopBrowser(browserId);
    return { data: true };
  } catch (error) {
    return { error: errorMessage(error) };
  }
};

/**
 * Stops a browser, removing its container. Called when a collaborator
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
  if (!isWellFormedBrowserId(browserId)) {
    return { error: 'INVALID_BROWSER_ID' };
  }
  return config.browserFleetUrl ? stopBrowserOnFleet({ browserId }) : stopBrowserLocally({ browserId });
};

// Only http/https map to a websocket scheme; anything else is a misconfiguration.
const CDP_SCHEME_FOR = { 'http:': 'ws:', 'https:': 'wss:' };

// External fleet bridge URL, built from the configured origin.
const browserCdpUrlOnFleet = ({ browserId, origin }) => {
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  const scheme = CDP_SCHEME_FOR[parsed.protocol];
  if (!scheme) {
    return null;
  }
  // Keep a base path in the origin; drop its trailing slash so the join does not
  // double it.
  const basePath = parsed.pathname.replace(/\/+$/, '');
  return `${scheme}//${parsed.host}${basePath}/api/v1/browsers/${encodeURIComponent(browserId)}/cdp`;
};

/**
 * Builds the CDP websocket URL for a browser. For an external fleet this is the
 * fleet's bridge URL; locally it is discovered from the container's CDP
 * endpoint, which needs the container to be up, so this is async. Returns null
 * when no URL can be resolved.
 * @param {{browserId: string, origin?: string}} params
 * @returns {Promise<string | null>}
 */
const browserCdpUrl = async ({ browserId, origin = config.browserFleetUrl }) => {
  if (!isWellFormedBrowserId(browserId)) {
    return null;
  }
  if (origin) {
    return browserCdpUrlOnFleet({ browserId, origin });
  }
  try {
    return await containers.resolveCdpUrl(browserId);
  } catch {
    return null;
  }
};

export { isWellFormedBrowserId, startBrowser, checkBrowserFleetHealth, browserExists, browserCdpUrl, stopBrowser };
