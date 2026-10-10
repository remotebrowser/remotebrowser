import { consola } from 'consola/basic';
import { WebSocket } from 'ws';
import { browserCdpUrl } from './fleet.js';
import { withCdpSession } from './cdp.js';

// JPEG is much smaller than PNG; the size cap keeps big windows from flooding viewers.
// Chrome renders about 60 frames per second, so every 15th frame is about 250ms apart.
const SCREENCAST_OPTIONS = Object.freeze({
  format: 'jpeg',
  quality: 60,
  maxWidth: 1920,
  maxHeight: 1080,
  everyNthFrame: 15
});

// A viewer polls again right after each frame, so a short gap means it left.
const SCREENCAST_IDLE = 3000;

// Limits how late an idle screencast is stopped.
const IDLE_CHECK_INTERVAL = 1000;

// Do not wait long for a browser that never answers.
const STOP_TIMEOUT = 1000;

// Chrome sends frames only on repaint, so a still page needs a limit on the wait.
const FRAME_WAIT = 10000;

// Global, so a restarted screencast never repeats a number a viewer has seen.
let lastSeq = 0;

// One screencast per page, shared by all viewers.
/** @type {{screencasts: Map<string, any>}} */
const cache = {
  screencasts: new Map()
};

const screencastKey = ({ browserId, pageId }) => `${browserId}:${pageId}`;

const cdpErrorMessage = (error) => (error instanceof Error ? error.message : String(error));

// Chrome may keep streaming into a dead session if we only close the socket.
const stopUpstream = async (entry) => {
  const { socket } = entry;
  if (entry.streaming && socket?.readyState === WebSocket.OPEN) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, STOP_TIMEOUT);
    });
    const stop = entry.send('Page.stopScreencast', {}, entry.sessionId).catch(() => {});
    await Promise.race([stop, timeout]).finally(() => clearTimeout(timer));
  }
  socket?.terminate();
};

const closeScreencast = (entry, reason) => {
  if (entry.closed) {
    return Promise.resolve();
  }
  entry.closed = reason;
  clearInterval(entry.idleTimer);
  if (cache.screencasts.get(entry.key) === entry) {
    cache.screencasts.delete(entry.key);
  }
  for (const wake of entry.waiters) {
    wake({ error: reason });
  }
  return stopUpstream(entry);
};

// Chrome waits for this ack before the next frame, so it never streams faster than a viewer reads.
const ackFrame = (entry) => {
  const frameId = entry.unacked;
  if (frameId === null || !entry.send) {
    return;
  }
  entry.unacked = null;
  entry.send('Page.screencastFrameAck', { sessionId: frameId }, entry.sessionId).catch(() => {});
};

const publishFrame = (entry, data) => {
  lastSeq += 1;
  entry.frame = { seq: lastSeq, data, timestamp: Date.now() };
  for (const wake of entry.waiters) {
    wake({ data: entry.frame });
  }
};

const startScreencast = async (entry, { browserId, pageId, cdpUrlFor }) => {
  const url = await cdpUrlFor({ browserId });
  if (!url) {
    return { error: 'CDP_URL_UNAVAILABLE' };
  }
  /** @type {{socket: import('ws').WebSocket, send: (method: string, params: any, sessionId?: string) => Promise<any>}} */
  let session;
  try {
    session = await withCdpSession(url);
  } catch (error) {
    return { error: cdpErrorMessage(error) };
  }
  entry.socket = session.socket;
  // The idle check may have closed the entry during the dial.
  if (entry.closed) {
    session.socket.terminate();
    return { error: entry.closed };
  }
  session.socket.on('error', () => {});
  session.socket.once('close', () => void closeScreencast(entry, 'SCREENCAST_CLOSED'));
  try {
    const { targetInfos } = await session.send('Target.getTargets', {});
    const page = Array.isArray(targetInfos)
      ? targetInfos.find((target) => target.type === 'page' && target.targetId === pageId)
      : undefined;
    if (!page) {
      return { error: 'NO_SUCH_PAGE' };
    }
    const { sessionId } = await session.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    entry.sessionId = sessionId;
    entry.send = session.send;
    const onMessage = (raw) => {
      /** @type {any} */
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.method === 'Page.screencastFrame' && message.sessionId === sessionId) {
        // Waiters remove themselves when woken.
        const read = entry.waiters.size > 0;
        entry.unacked = message.params.sessionId;
        publishFrame(entry, Buffer.from(message.params.data, 'base64'));
        if (read) {
          ackFrame(entry);
        }
      } else if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId === sessionId) {
        // The session is gone, so there is nothing to stop.
        entry.streaming = false;
        void closeScreencast(entry, 'NO_SUCH_PAGE');
      }
    };
    session.socket.on('message', onMessage);
    // A still page may never repaint, so the first viewer needs this frame.
    const seed = await session.send(
      'Page.captureScreenshot',
      { format: SCREENCAST_OPTIONS.format, quality: SCREENCAST_OPTIONS.quality },
      sessionId
    );
    if (!entry.frame) {
      publishFrame(entry, Buffer.from(seed.data, 'base64'));
    }
    await session.send('Page.startScreencast', SCREENCAST_OPTIONS, sessionId);
    entry.streaming = true;
    return { ok: true };
  } catch (error) {
    consola.error('CDP command failed while starting a page screencast', {
      'event.domain': 'cdp',
      'rb.browser_id': browserId,
      'rb.page_id': pageId,
      'error.type': cdpErrorMessage(error)
    });
    return { error: cdpErrorMessage(error) };
  }
};

const openScreencast = ({ browserId, pageId, cdpUrlFor }) => {
  const entry = {
    key: screencastKey({ browserId, pageId }),
    /** @type {{seq: number, data: Buffer, timestamp: number} | null} */
    frame: null,
    /** @type {Set<(result: {data?: any, error?: string}) => void>} */
    waiters: new Set(),
    lastRead: Date.now(),
    /** @type {string | false} */
    closed: false,
    /** @type {string | null} */
    unacked: null,
    /** @type {import('ws').WebSocket | null} */
    socket: null,
    sessionId: null,
    send: null,
    /** @type {Promise<{ok?: true, error?: string}>} */
    ready: null,
    idleTimer: null,
    streaming: false
  };
  entry.idleTimer = setInterval(() => {
    if (entry.waiters.size === 0 && Date.now() - entry.lastRead > SCREENCAST_IDLE) {
      void closeScreencast(entry, 'SCREENCAST_IDLE');
    }
  }, IDLE_CHECK_INTERVAL);
  entry.idleTimer.unref();
  entry.ready = startScreencast(entry, { browserId, pageId, cdpUrlFor }).then((result) => {
    if (result.error) {
      void closeScreencast(entry, result.error);
    }
    return result;
  });
  return entry;
};

/** Waits for a frame newer than `after`, starting the page's screencast if needed; no data and no error means the wait timed out. @param {{browserId: string, pageId: string, after?: number, timeout?: number, signal?: AbortSignal, cdpUrlFor?: (params: {browserId: string}) => string | null | Promise<string | null>}} params @returns {Promise<{data?: {seq: number, data: Buffer, timestamp: number}, error?: string}>} */
const nextFrame = async ({ browserId, pageId, after = 0, timeout = FRAME_WAIT, signal, cdpUrlFor = browserCdpUrl }) => {
  const key = screencastKey({ browserId, pageId });
  let entry = cache.screencasts.get(key);
  if (!entry) {
    entry = openScreencast({ browserId, pageId, cdpUrlFor });
    cache.screencasts.set(key, entry);
  }
  entry.lastRead = Date.now();
  const ready = await entry.ready;
  if (ready.error) {
    return { error: ready.error };
  }
  if (entry.frame && entry.frame.seq > after) {
    ackFrame(entry);
    return { data: entry.frame };
  }
  if (entry.closed) {
    return { error: entry.closed };
  }
  if (signal?.aborted) {
    return {};
  }
  return new Promise((resolve) => {
    const done = (result) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      entry.waiters.delete(done);
      entry.lastRead = Date.now();
      resolve(result);
    };
    const onAbort = () => done({});
    const timer = setTimeout(() => done({}), timeout);
    entry.waiters.add(done);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const stopScreencasts = async () => {
  await Promise.allSettled(
    [...cache.screencasts.values()].map((entry) => closeScreencast(entry, 'SCREENCAST_STOPPED'))
  );
};

export { nextFrame, stopScreencasts, cache, SCREENCAST_OPTIONS };
