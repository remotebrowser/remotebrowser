import { config } from './config.js';

// A fleet request that does not answer this soon is treated as dead.
const FLEET_TIMEOUT = 10000;

// Unreserved URL chars only: a fleet id is a path segment and must never escape it.
const BROWSER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Whether a fleet-provided id is safe to build a URL from and to store.
const isWellFormedBrowserId = (browserId) => typeof browserId === 'string' && BROWSER_ID_PATTERN.test(browserId);

/**
 * Asks the browser fleet server to start a browser.
 * @returns {Promise<{data?: {browserId: string}, error?: string}>}
 */
const startBrowser = async () => {
  if (!config.browserFleetUrl) {
    return { error: 'BROWSERFLEET_URL is not configured' };
  }
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

/**
 * Checks the fleet server's health once at startup, before the server binds a
 * port. A broken fleet is fatal here, not later: every browser record written
 * after startup would just sit unprovisioned.
 * @returns {Promise<{data?: {healthy: true}, error?: string}>}
 */
const checkBrowserFleetHealth = async () => {
  if (!config.browserFleetUrl) {
    return { error: 'BROWSERFLEET_URL is not configured' };
  }
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

/**
 * Checks that a browser id still exists on the fleet server. The CDP relay
 * calls this before dialing, so a stopped browser is refused cleanly instead of
 * failing with an unexplained close code.
 *
 * 404 means "no such browser". Any other non-2xx is an error in the check
 * itself, so the caller answers 503 rather than wrongly saying the browser is
 * gone.
 * @param {{browserId: string}} params
 * @returns {Promise<{data?: boolean, error?: string}>}
 */
const browserExists = async ({ browserId }) => {
  if (!config.browserFleetUrl) {
    return { error: 'BROWSERFLEET_URL is not configured' };
  }
  if (!isWellFormedBrowserId(browserId)) {
    return { data: false };
  }
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

/**
 * Stops a browser on the fleet server. Called when a collaborator terminates it.
 *
 * 404 is success: the browser is already stopped or never started (a 'starting'
 * browser has no fleet id yet). Either way, no browser is left running.
 * @param {{browserId: string}} params
 * @returns {Promise<{data?: true, error?: string}>}
 */
const stopBrowser = async ({ browserId }) => {
  if (!config.browserFleetUrl) {
    return { error: 'BROWSERFLEET_URL is not configured' };
  }
  if (typeof browserId !== 'string' || browserId === '') {
    return { data: true };
  }
  // A non-empty id that fails the shape check is corruption, not an unprovisioned browser.
  if (!isWellFormedBrowserId(browserId)) {
    return { error: 'INVALID_BROWSER_ID' };
  }
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

// Only http/https map to a websocket scheme; anything else is a misconfiguration.
const CDP_SCHEME_FOR = { 'http:': 'ws:', 'https:': 'wss:' };

/**
 * Builds the CDP websocket URL for a browser. Returns null when the origin or
 * id is unusable. The id comes from a handle lookup, so the schema has
 * already checked its shape and the relay can trust it.
 * @param {{browserId: string, origin?: string}} params
 * @returns {string | null}
 */
const browserCdpUrl = ({ browserId, origin = config.browserFleetUrl }) => {
  if (!origin || !isWellFormedBrowserId(browserId)) {
    return null;
  }
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

export { isWellFormedBrowserId, startBrowser, checkBrowserFleetHealth, browserExists, browserCdpUrl, stopBrowser };
