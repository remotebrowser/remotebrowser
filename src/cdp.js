import { consola } from 'consola/basic';
import { WebSocket, WebSocketServer } from 'ws';
import { browserCdpUrl, browserExists } from './vms.js';
import { isWellFormedBrowserHandle } from './handle.js';
import { browserIdForHandle as resolveBrowserHandle, getBrowserInstanceByPublicId } from './models/browsers.js';
import { authenticateApiKey } from './middleware/apikey.js';
import { onRecheckApiSessions } from './routes/api/sessions.js';

// Not a Hono route: a websocket upgrade needs the raw socket from the server's 'upgrade' event.

// Matches only the path shape; the segment stays unvalidated so callers can tell a bad handle (400) from a wrong path (404).
const CDP_PATH_PATTERN = /^\/cdp\/([^/]+)$/;

// The REST API's CDP endpoint names a browser by its public id and needs a Bearer API key.
const API_CDP_PATH_PATTERN = /^\/api\/v1\/browsers\/([^/]+)\/cdp$/;

// What the REST API promises when the browser cannot be reached: the upgrade is
// accepted, then closed with this code.
const UNREACHABLE_CLOSE_CODE = 4502;

// Closes an open API session whose key no longer works: deleted, expired, or
// its creator left the workspace. Like HTTP 401.
const REVOKED_CLOSE_CODE = 4401;

// A minute keeps revocation prompt without a database check on every message.
const API_SESSION_CHECK_INTERVAL = 60 * 1000;

// Cap frames at 32 MB: enough for base64 screenshots and large DOM/network payloads,
// while rejecting an oversized frame before ws buffers it whole (a client could otherwise OOM the process).
const CDP_MAX_PAYLOAD = 32 * 1024 * 1024;

// Both relay ends share the cap; ws closes the connection on a larger frame. No per-message
// compression since it would just be redone per hop.
const RELAY_SOCKET_OPTIONS = Object.freeze({ perMessageDeflate: false, maxPayload: CDP_MAX_PAYLOAD });

// Pause the feeding side once a peer's send buffer holds this much; otherwise a slow peer grows memory without bound.
const SEND_BUFFER_HIGH_WATER_MARK = 1024 * 1024;

// A dialing or idle CDP connection that stalls this long is treated as dead.
const CDP_TIMEOUT = 10000;

// Reserved codes that may not go in a close frame; forward those drops as codeless closes instead.
const UNSENDABLE_CLOSE_CODES = new Set([1005, 1006]);

/** Extracts the browser handle from a CDP upgrade URL. @param {string} requestUrl raw req.url, query string and all @returns {string | null} the raw path segment, or null if not a CDP path */
const cdpBrowserHandle = (requestUrl) => {
  const [pathname] = String(requestUrl).split(/[?#]/, 1);
  const match = CDP_PATH_PATTERN.exec(pathname);
  return match ? match[1] : null;
};

/** Extracts the public browser id from a REST API CDP upgrade URL. @param {string} requestUrl raw req.url @returns {string | null} */
const apiCdpBrowserId = (requestUrl) => {
  const [pathname] = String(requestUrl).split(/[?#]/, 1);
  const match = API_CDP_PATH_PATTERN.exec(pathname);
  return match ? match[1] : null;
};

// The API path's lookup: the key must be valid, and the browser must belong to its workspace.
const authorizeApiBrowser = async ({ authorization, publicId }) => {
  const authenticated = await authenticateApiKey(authorization);
  if (authenticated.error) return { error: authenticated.error };
  const browser = await getBrowserInstanceByPublicId({ workspaceId: authenticated.data.workspace.id, publicId });
  if (browser.error) return { error: browser.error };
  return { data: browser.data ? browser.data.internalBrowserId || null : null };
};

// Replies with a real status line before the handshake is accepted; after a 101 only an opaque close code is possible.
const refuseUpgrade = (socket, status, reason, headers = '') => {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\n${headers}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  socket.destroy();
};

const closePeer = (peer, code, reason) => {
  if (peer.readyState !== WebSocket.OPEN && peer.readyState !== WebSocket.CONNECTING) {
    return;
  }
  if (!code || UNSENDABLE_CLOSE_CODES.has(code)) {
    peer.close();
    return;
  }
  peer.close(code, reason);
};

// Pumps one relay direction; round-trips ws's isBinary flag, or binary payloads get mangled by UTF-8 validation.
const forward = (from, to) => {
  let paused = false;
  const resumeWhenDrained = () => {
    if (paused && to.bufferedAmount <= SEND_BUFFER_HIGH_WATER_MARK) {
      paused = false;
      from.resume();
    }
  };
  from.on('message', (data, isBinary) => {
    if (to.readyState !== WebSocket.OPEN) {
      return;
    }
    // The callback fires once this payload has reached the socket, which is the
    // point the buffer has room again.
    to.send(data, { binary: isBinary }, resumeWhenDrained);
    if (!paused && to.bufferedAmount > SEND_BUFFER_HIGH_WATER_MARK) {
      paused = true;
      from.pause();
    }
  });
  // Forward pings too: ws answers them itself, which would fake liveness and let a proxy drop an idle-looking connection.
  from.on('ping', (data) => {
    if (to.readyState === WebSocket.OPEN) {
      to.ping(data);
    }
  });
  from.on('pong', (data) => {
    if (to.readyState === WebSocket.OPEN) {
      to.pong(data);
    }
  });
  from.on('close', (code, reason) => closePeer(to, code, reason));
  // Swallow errors so an unhandled 'error' event cannot crash the process; the 'close' after it propagates shutdown to the peer.
  from.on('error', () => {});
};

/** Relays a CDP websocket to a browser in a local VM; `server` is typed narrowly because @hono/node-server's serve() returns a union covering an HTTP/2 server too. @param {{server: {on: (event: 'upgrade', listener: (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void) => unknown}, cdpUrlFor?: (params: {browserId: string}) => string | null | Promise<string | null>, browserIdForHandle?: (params: {handle: string}) => Promise<{data?: string | null, error?: string}>, browserExists?: (params: {browserId: string}) => Promise<{data?: boolean, error?: string}>}} params @returns {{close: () => Promise<void>}} */
const mountCdpRelay = ({
  server,
  cdpUrlFor = browserCdpUrl,
  browserIdForHandle = resolveBrowserHandle,
  browserExists: checkBrowserExists = browserExists,
  authorizeApiBrowser: authorizeApi = authorizeApiBrowser,
  apiSessionCheckInterval = API_SESSION_CHECK_INTERVAL
}) => {
  const wss = new WebSocketServer({ noServer: true, ...RELAY_SOCKET_OPTIONS });
  /** @type {Set<WebSocket>} */
  const sockets = new Set();

  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  // A session can run for hours, so it checks its key again with the header it opened with.
  /** @type {Set<{client: WebSocket, upstream: WebSocket, authorization: string | undefined, publicId: string, browserId: string}>} */
  const apiSessions = new Set();

  const checkApiSession = async (session) => {
    /** @type {{data?: string | null, error?: string}} */
    let authorized;
    try {
      authorized = await authorizeApi({ authorization: session.authorization, publicId: session.publicId });
    } catch (error) {
      authorized = { error: String(error) };
    }
    if (authorized.error && authorized.error !== 'UNAUTHORIZED') {
      // A failed check is not a revoked key: keep the session, and try again next time.
      consola.warn('API could not check the key of a CDP session', {
        'event.domain': 'api',
        'rb.browser_id': session.browserId,
        'error.type': String(authorized.error)
      });
      return;
    }
    if (authorized.data === session.browserId) {
      return;
    }
    apiSessions.delete(session);
    consola.info('API closed a CDP session whose key no longer works', {
      'event.domain': 'api',
      'rb.browser_id': session.browserId
    });
    session.client.close(REVOKED_CLOSE_CODE, 'API key no longer valid');
    // Not left to the close handshake: nothing more may reach the browser.
    session.upstream.terminate();
  };

  // One check at a time; a request that comes in during one runs right after it.
  let checking = null;
  let checkAgain = false;
  const checkApiSessions = () => {
    if (checking) {
      checkAgain = true;
      return checking;
    }
    checking = Promise.all([...apiSessions].map(checkApiSession)).finally(() => {
      checking = null;
      if (checkAgain) {
        checkAgain = false;
        void checkApiSessions();
      }
    });
    return checking;
  };
  const checkTimer = setInterval(() => void checkApiSessions(), apiSessionCheckInterval);
  checkTimer.unref();
  const stopListening = onRecheckApiSessions(() => void checkApiSessions());

  // For the API path: the client gets the documented close code instead of a status line.
  const closeAsUnreachable = (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => {
      client.close(UNREACHABLE_CLOSE_CODE, 'Browser unreachable');
    });
  };

  // apiSession is set for the REST API path: { authorization, publicId }.
  const relay = ({ req, socket, head, browserId, upstreamUrl, apiSession = null }) => {
    const closeCodeOnFailure = Boolean(apiSession);
    const upstream = new WebSocket(upstreamUrl, {
      ...RELAY_SOCKET_OPTIONS,
      handshakeTimeout: CDP_TIMEOUT
    });
    track(upstream);

    /** @type {'dialing' | 'relaying' | 'aborted'} */
    let state = 'dialing';
    const startedAt = Date.now();

    // Covers the client vanishing mid-dial or ws rejecting its handshake; otherwise the upstream dials for nobody.
    const abortDial = () => {
      if (state !== 'dialing') {
        return;
      }
      state = 'aborted';
      upstream.terminate();
    };
    socket.once('close', abortDial);
    socket.once('error', abortDial);

    const giveUp = (error) => {
      if (state !== 'dialing') {
        return;
      }
      state = 'aborted';
      socket.off('close', abortDial);
      socket.off('error', abortDial);
      consola.warn('CDP relay could not reach the browser', {
        'event.domain': 'cdp',
        'rb.browser_id': browserId,
        'error.type': String(error)
      });
      if (closeCodeOnFailure) {
        closeAsUnreachable(req, socket, head);
      } else {
        refuseUpgrade(socket, 502, 'Bad Gateway');
      }
    };

    upstream.once('open', () => {
      if (state !== 'dialing') {
        upstream.terminate();
        return;
      }
      // Nothing may reach the browser before the client exists; pause() is a no-op while CONNECTING, so this is where it first takes effect.
      upstream.pause();
      wss.handleUpgrade(req, socket, head, (client) => {
        state = 'relaying';
        socket.off('close', abortDial);
        socket.off('error', abortDial);
        track(client);
        if (apiSession) {
          const session = { client, upstream, browserId, ...apiSession };
          apiSessions.add(session);
          client.once('close', () => apiSessions.delete(session));
        }
        forward(client, upstream);
        forward(upstream, client);
        upstream.resume();

        consola.log('CDP relay opened', { 'event.domain': 'cdp', 'rb.browser_id': browserId });
        // Whichever side goes first ends the relay; the log is emitted once.
        let logged = false;
        const logClose = (initiator) => (code) => {
          if (logged) {
            return;
          }
          logged = true;
          consola.log('CDP relay closed', {
            'event.domain': 'cdp',
            'rb.browser_id': browserId,
            'ws.close_code': code,
            'ws.close_initiator': initiator,
            'cdp.duration_ms': Date.now() - startedAt
          });
        };
        client.once('close', logClose('client'));
        upstream.once('close', logClose('browser'));
      });
    });

    upstream.once('error', giveUp);
    // A handshake that fails without an error event, or an upstream that dies
    // mid-dial, would leave the client waiting forever.
    upstream.once('close', () => giveUp('closed before the handshake completed'));
  };

  // The handle path: an unguessable handle in the URL is the only credential.
  // Returns the internal browser id, or null once the upgrade has been refused.
  const resolveHandle = async (socket, handle) => {
    // The public path carries an unguessable handle, never the bare id; the local MAC check rejects foreign handles with no database read.
    if (!isWellFormedBrowserHandle(handle)) {
      refuseUpgrade(socket, 400, 'Bad Request');
      return null;
    }
    const resolved = await browserIdForHandle({ handle });
    if (resolved.error) {
      consola.warn('CDP relay could not resolve a browser handle', {
        'event.domain': 'cdp',
        'error.type': String(resolved.error)
      });
      refuseUpgrade(socket, 503, 'Service Unavailable');
      return null;
    }
    // A valid MAC means this app issued the handle, so a missing mapping was
    // revoked: answer 410, the same as for a handle that never existed.
    if (!resolved.data) {
      refuseUpgrade(socket, 410, 'Gone');
      return null;
    }
    return resolved.data;
  };

  // The REST API path: a Bearer API key, and a browser in that key's workspace.
  const resolveApiBrowser = async (req, socket, publicId) => {
    const authorized = await authorizeApi({ authorization: req.headers.authorization, publicId });
    if (authorized.error === 'UNAUTHORIZED') {
      refuseUpgrade(socket, 401, 'Unauthorized', 'WWW-Authenticate: Bearer\r\n');
      return null;
    }
    if (authorized.error) {
      consola.warn('API could not check a key for a CDP connection', {
        'event.domain': 'api',
        'error.type': String(authorized.error)
      });
      refuseUpgrade(socket, 503, 'Service Unavailable');
      return null;
    }
    // Not in this workspace, or not provisioned yet: either way there is nothing to reach.
    if (!authorized.data) {
      refuseUpgrade(socket, 404, 'Not Found');
      return null;
    }
    return authorized.data;
  };

  const startRelay = async (req, socket, head, hasClientGone) => {
    // Nothing catches throws inside an 'upgrade' listener; fail only the one bad upgrade, never the whole server.
    try {
      const handle = cdpBrowserHandle(req.url);
      const apiBrowserId = handle === null ? apiCdpBrowserId(req.url) : null;
      if (handle === null && apiBrowserId === null) {
        refuseUpgrade(socket, 404, 'Not Found');
        return;
      }
      const viaApi = apiBrowserId !== null;
      const browserId = viaApi
        ? await resolveApiBrowser(req, socket, apiBrowserId)
        : await resolveHandle(socket, handle);
      if (browserId === null) {
        return;
      }
      // Ask the server before dialing: a stopped browser gets a clean status here instead of an opaque close code later.
      const probe = await checkBrowserExists({ browserId });
      if (probe.error) {
        consola.warn('CDP relay could not verify the browser exists', {
          'event.domain': 'cdp',
          'rb.browser_id': browserId,
          'error.type': String(probe.error)
        });
        refuseUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      if (!probe.data) {
        consola.warn('CDP relay refused a browser the server no longer has', {
          'event.domain': 'cdp',
          'rb.browser_id': browserId
        });
        // The REST API answers 404 for any browser that does not exist.
        if (viaApi) {
          refuseUpgrade(socket, 404, 'Not Found');
        } else {
          refuseUpgrade(socket, 410, 'Gone');
        }
        return;
      }
      // The awaits above let the client leave; hasClientGone() sees half-closed sockets that destroyed/writable checks miss.
      if (hasClientGone()) {
        // Destroy the half-closed socket or it leaks and server.close() never finishes.
        socket.destroy();
        return;
      }
      const upstreamUrl = await cdpUrlFor({ browserId });
      // Resolving can take a while (CDP discovery retries); the client may have left since.
      if (hasClientGone()) {
        socket.destroy();
        return;
      }
      if (!upstreamUrl) {
        if (viaApi) {
          closeAsUnreachable(req, socket, head);
        } else {
          refuseUpgrade(socket, 503, 'Service Unavailable');
        }
        return;
      }
      relay({
        req,
        socket,
        head,
        browserId,
        upstreamUrl,
        apiSession: viaApi ? { authorization: req.headers.authorization, publicId: apiBrowserId } : null
      });
    } catch (error) {
      consola.error('CDP relay failed to start', {
        'event.domain': 'cdp',
        'error.type': String(error)
      });
      refuseUpgrade(socket, 500, 'Internal Server Error');
    }
  };

  server.on('upgrade', (req, socket, head) => {
    // Attach this before the first await: a listener-less error event throws, and the client can vanish during lookups.
    socket.on('error', () => {});
    // Watch 'end' as well as 'close': a half-closed socket looks alive but will never finish the handshake.
    let clientGone = false;
    const markClientGone = () => {
      clientGone = true;
    };
    socket.once('end', markClientGone);
    socket.once('close', markClientGone);
    // Not awaited, and it never rejects: startRelay catches everything, because an
    // unhandled rejection here would be as fatal as a throw.
    void startRelay(req, socket, head, () => clientGone);
  });

  return {
    close: async () => {
      clearInterval(checkTimer);
      stopListening();
      apiSessions.clear();
      for (const socket of sockets) {
        socket.terminate();
      }
      sockets.clear();
      await new Promise((resolve) => {
        wss.close(() => resolve(undefined));
      });
    }
  };
};

// --- A CDP client for driving a browser directly ------------------------------
// Unlike the relay above, which only forwards bytes, this speaks the protocol
// itself, using the internal browserId (never the public handle).

const openCdpConnection = (url) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { ...RELAY_SOCKET_OPTIONS, handshakeTimeout: CDP_TIMEOUT });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });

// Commands run one at a time, so a single id-matched listener pairs each response with its command; other events are ignored.
const sendCdpCommand = (socket, id, method, params, sessionId) =>
  new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      /** @type {any} */
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.id !== id) {
        return;
      }
      socket.off('message', onMessage);
      if (message.error) {
        reject(new Error(message.error.message || `${method} failed`));
      } else {
        resolve(message.result);
      }
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const withTimeout = (promise, ms, message) => {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const cdpErrorMessage = (error) => (error instanceof Error ? error.message : String(error));

// Opens a session with a `send` helper plus the raw socket; connect failures are logged here, the one place still holding the dialed URL.
const withCdpSession = async (url) => {
  let socket;
  try {
    socket = await withTimeout(openCdpConnection(url), CDP_TIMEOUT, 'CONNECT_TIMEOUT');
  } catch (error) {
    consola.error('CDP connect failed', {
      'event.domain': 'cdp',
      'rb.cdp_url': url,
      'error.type': cdpErrorMessage(error)
    });
    throw error;
  }
  let nextId = 0;
  const send = (method, params, sessionId) =>
    withTimeout(sendCdpCommand(socket, (nextId += 1), method, params, sessionId), CDP_TIMEOUT, `${method}_TIMEOUT`);
  return { socket, send };
};

// The same quality as the screencast frames (SCREENCAST_OPTIONS in screencast.js).
const SCREENSHOT_QUALITY = 60;

/** Captures a JPEG screenshot of one page target over CDP; an unknown pageId is a caller-facing miss, not a protocol error. @param {{browserId: string, pageId: string, cdpUrlFor?: (params: {browserId: string}) => string | null | Promise<string | null>}} params @returns {Promise<{data?: Buffer, error?: string}>} */
const capturePageScreenshot = async ({ browserId, pageId, cdpUrlFor = browserCdpUrl }) => {
  const url = await cdpUrlFor({ browserId });
  if (!url) {
    return { error: 'CDP_URL_UNAVAILABLE' };
  }
  /** @type {{socket: WebSocket, send: (method: string, params: any, sessionId?: string) => Promise<any>}} */
  let session;
  try {
    session = await withCdpSession(url);
  } catch (error) {
    return { error: cdpErrorMessage(error) };
  }
  try {
    const { targetInfos } = await session.send('Target.getTargets', {});
    const page = Array.isArray(targetInfos)
      ? targetInfos.find((target) => target.type === 'page' && target.targetId === pageId)
      : undefined;
    if (!page) {
      return { error: 'NO_SUCH_PAGE' };
    }
    const { sessionId } = await session.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const { data } = await session.send(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: SCREENSHOT_QUALITY },
      sessionId
    );
    return { data: Buffer.from(data, 'base64') };
  } catch (error) {
    consola.error('CDP command failed while capturing a page screenshot', {
      'event.domain': 'cdp',
      'rb.browser_id': browserId,
      'rb.page_id': pageId,
      'error.type': cdpErrorMessage(error)
    });
    return { error: cdpErrorMessage(error) };
  } finally {
    session.socket.terminate();
  }
};

/** Lists a browser's open page targets over CDP, as full TargetInfo (title and url come free) with non-page targets left out. @param {{browserId: string, cdpUrlFor?: (params: {browserId: string}) => string | null | Promise<string | null>}} params @returns {Promise<{data?: Array<{targetId: string, type: string, title: string, url: string, attached: boolean}>, error?: string}>} */
const listBrowserPages = async ({ browserId, cdpUrlFor = browserCdpUrl }) => {
  const url = await cdpUrlFor({ browserId });
  if (!url) {
    return { error: 'CDP_URL_UNAVAILABLE' };
  }
  /** @type {{socket: WebSocket, send: (method: string, params: any, sessionId?: string) => Promise<any>}} */
  let session;
  try {
    session = await withCdpSession(url);
  } catch (error) {
    return { error: cdpErrorMessage(error) };
  }
  try {
    const { targetInfos } = await session.send('Target.getTargets', {});
    const pages = Array.isArray(targetInfos) ? targetInfos.filter((target) => target.type === 'page') : [];
    return { data: pages };
  } catch (error) {
    consola.error('CDP command failed while listing browser pages', {
      'event.domain': 'cdp',
      'rb.browser_id': browserId,
      'error.type': cdpErrorMessage(error)
    });
    return { error: cdpErrorMessage(error) };
  } finally {
    session.socket.terminate();
  }
};

/** Navigates the browser's current page (its first `type: 'page'` target) right after provisioning, so something shows instead of Chrome's blank tab. @param {{browserId: string, url: string, cdpUrlFor?: (params: {browserId: string}) => string | null | Promise<string | null>}} params @returns {Promise<{data?: true, error?: string}>} */
const navigateBrowserToUrl = async ({ browserId, url, cdpUrlFor = browserCdpUrl }) => {
  const cdpUrl = await cdpUrlFor({ browserId });
  if (!cdpUrl) {
    return { error: 'CDP_URL_UNAVAILABLE' };
  }
  /** @type {{socket: WebSocket, send: (method: string, params: any, sessionId?: string) => Promise<any>}} */
  let session;
  try {
    session = await withCdpSession(cdpUrl);
  } catch (error) {
    return { error: cdpErrorMessage(error) };
  }
  try {
    const { targetInfos } = await session.send('Target.getTargets', {});
    const page = Array.isArray(targetInfos) ? targetInfos.find((target) => target.type === 'page') : undefined;
    if (!page) {
      return { error: 'NO_PAGE_TARGET' };
    }
    const { sessionId } = await session.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await session.send('Page.navigate', { url }, sessionId);
    return { data: true };
  } catch (error) {
    consola.error('CDP command failed while navigating a browser page', {
      'event.domain': 'cdp',
      'rb.browser_id': browserId,
      'error.type': cdpErrorMessage(error)
    });
    return { error: cdpErrorMessage(error) };
  } finally {
    session.socket.terminate();
  }
};

/** Reads the accessibility tree of the browser's current page (its first `type: 'page'` target, as the playground uses), so the LLM knows what is on it. @param {{browserId: string, cdpUrlFor?: (params: {browserId: string}) => string | null | Promise<string | null>}} params @returns {Promise<{data?: {url: string, title: string, nodes: any[]}, error?: string}>} */
const readPageAccessibility = async ({ browserId, cdpUrlFor = browserCdpUrl }) => {
  const url = await cdpUrlFor({ browserId });
  if (!url) {
    return { error: 'CDP_URL_UNAVAILABLE' };
  }
  /** @type {{socket: WebSocket, send: (method: string, params: any, sessionId?: string) => Promise<any>}} */
  let session;
  try {
    session = await withCdpSession(url);
  } catch (error) {
    return { error: cdpErrorMessage(error) };
  }
  try {
    const { targetInfos } = await session.send('Target.getTargets', {});
    const page = Array.isArray(targetInfos) ? targetInfos.find((target) => target.type === 'page') : undefined;
    if (!page) {
      return { error: 'NO_PAGE_TARGET' };
    }
    const { sessionId } = await session.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const { nodes } = await session.send('Accessibility.getFullAXTree', {}, sessionId);
    return { data: { url: page.url, title: page.title, nodes: Array.isArray(nodes) ? nodes : [] } };
  } catch (error) {
    consola.error('CDP command failed while reading the accessibility tree', {
      'event.domain': 'cdp',
      'rb.browser_id': browserId,
      'error.type': cdpErrorMessage(error)
    });
    return { error: cdpErrorMessage(error) };
  } finally {
    session.socket.terminate();
  }
};

/** Liveness probe: true if the CDP handshake opens; an unconfigured origin counts as false, like any failure. @param {{browserId: string, cdpUrlFor?: (params: {browserId: string}) => string | null | Promise<string | null>}} params @returns {Promise<{data: boolean}>} */
const checkCdpConnection = async ({ browserId, cdpUrlFor = browserCdpUrl }) => {
  const url = await cdpUrlFor({ browserId });
  if (!url) {
    return { data: false };
  }
  let socket;
  try {
    socket = await withTimeout(openCdpConnection(url), CDP_TIMEOUT, 'CONNECT_TIMEOUT');
  } catch {
    return { data: false };
  }
  socket.terminate();
  return { data: true };
};

export {
  cdpBrowserHandle,
  apiCdpBrowserId,
  UNREACHABLE_CLOSE_CODE,
  REVOKED_CLOSE_CODE,
  mountCdpRelay,
  RELAY_SOCKET_OPTIONS,
  CDP_MAX_PAYLOAD,
  capturePageScreenshot,
  listBrowserPages,
  navigateBrowserToUrl,
  readPageAccessibility,
  checkCdpConnection,
  withCdpSession
};
