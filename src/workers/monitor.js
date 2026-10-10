import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { consola } from 'consola/basic';
import { withCdpSession } from '../cdp.js';

// One worker per browser, and the worker is the only thing that talks to that
// browser's CDP endpoint. It never touches the database: navigations and status
// cross back to the master over postMessage, so the app keeps one pg pool.

// How long a worker gets to exit on its own before it is terminated.
const STOP_TIMEOUT = 2000;

/** Master side: one Worker per browser, reporting page navigations and status. @returns {{internalBrowserId: string, stop: () => Promise<void>}} */
const createBrowserMonitor = ({
  internalBrowserId,
  cdpUrl,
  onNavigation = () => {},
  onStatus = () => {},
  onExit = () => {}
}) => {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { cdpUrl }
  });

  worker.on('message', (message) => {
    if (!message || typeof message.type !== 'string') {
      return;
    }
    if (message.type === 'navigation') {
      onNavigation({ pageId: message.pageId, url: message.url });
    } else if (message.type === 'status') {
      onStatus({ state: message.state, error: message.error });
    }
  });
  worker.on('error', (error) => {
    consola.error('Browser monitor failed', {
      'event.domain': 'browser-monitor',
      'rb.browser_id': internalBrowserId,
      'error.type': String(error)
    });
  });
  // 'error' is always followed by 'exit'; report the exit once, from here.
  worker.on('exit', () => onExit());

  const exited = new Promise((resolve) => worker.once('exit', resolve));

  // Ask the worker to close its socket and exit; terminate() is only the
  // fallback for a worker that does not answer.
  let stopping = false;
  const stop = async () => {
    if (stopping) {
      await exited;
      return;
    }
    stopping = true;
    worker.postMessage({ type: 'stop' });
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(resolve, STOP_TIMEOUT, 'timeout');
    });
    const outcome = await Promise.race([exited, timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      await worker.terminate();
    }
  };

  return { internalBrowserId, stop };
};

// A page can rewrite its URL in a very fast loop (history.pushState); each page
// reports at most one navigation per interval, carrying the latest URL.
const NAVIGATION_INTERVAL = 500;

const runBrowserMonitor = async ({ cdpUrl }) => {
  let session;
  try {
    session = await withCdpSession(cdpUrl);
  } catch {
    parentPort.postMessage({ type: 'status', state: 'error', error: 'CONNECT_FAILED' });
    return;
  }
  const { socket, send } = session;
  // An unhandled 'error' event is fatal to the worker; the 'close' after it reports.
  socket.on('error', () => {});

  // Repeated URLs (a title change) are dropped here, not reported twice.
  const pages = new Map();
  let stopped = false;

  const flush = (targetId, page) => {
    page.timer = null;
    if (page.latest === page.sent) {
      return;
    }
    page.sent = page.latest;
    page.at = Date.now();
    parentPort.postMessage({ type: 'navigation', pageId: targetId, url: page.sent });
  };

  const track = (targetInfo) => {
    if (targetInfo?.type !== 'page') {
      return;
    }
    const { targetId, url } = targetInfo;
    // A fresh tab starts at about:blank; that is not a page anyone navigated to.
    if (typeof url !== 'string' || url === '' || url === 'about:blank') {
      return;
    }
    let page = pages.get(targetId);
    if (!page) {
      page = { sent: null, latest: null, at: 0, timer: null };
      pages.set(targetId, page);
    }
    page.latest = url;
    if (page.timer || url === page.sent) {
      return;
    }
    const wait = page.at + NAVIGATION_INTERVAL - Date.now();
    if (wait <= 0) {
      flush(targetId, page);
    } else {
      page.timer = setTimeout(flush, wait, targetId, page);
    }
  };

  // The browser pushes target changes, so there is nothing to poll and no per-page session.
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') {
      track(message.params?.targetInfo);
    } else if (message.method === 'Target.targetDestroyed') {
      const page = pages.get(message.params?.targetId);
      clearTimeout(page?.timer);
      pages.delete(message.params?.targetId);
    }
  });

  parentPort.on('message', (message) => {
    if (message?.type !== 'stop') {
      return;
    }
    stopped = true;
    // Pending reports would keep the thread alive past the stop.
    for (const page of pages.values()) {
      clearTimeout(page.timer);
    }
    socket.terminate();
    parentPort.close();
  });

  socket.on('close', () => {
    if (stopped) {
      return;
    }
    parentPort.postMessage({ type: 'status', state: 'disconnected' });
    // Let the worker exit so the master restarts it.
    parentPort.close();
  });

  try {
    await send('Target.setDiscoverTargets', { discover: true });
  } catch {
    socket.terminate();
    parentPort.postMessage({ type: 'status', state: 'error', error: 'DISCOVER_FAILED' });
    parentPort.close();
    return;
  }
  parentPort.postMessage({ type: 'status', state: 'ready' });
};

// Runs inside the worker thread.
if (!isMainThread && parentPort) {
  runBrowserMonitor(workerData).catch((error) => {
    parentPort.postMessage({ type: 'status', state: 'error', error: String(error) });
    parentPort.close();
  });
}

export { createBrowserMonitor };
