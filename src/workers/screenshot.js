import { availableParallelism, cpus } from 'node:os';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { consola } from 'consola/basic';
import { capturePageScreenshot } from '../cdp.js';

// Both halves of a worker pair: the pool on the main thread, the capture loop in a worker.

// One worker per core, so the per-screenshot decode work is spread across the cores.
const defaultWorkerCount = () => {
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length;
  return Number.isInteger(cores) && cores > 0 ? cores : 1;
};

const workerUrl = () => new URL(import.meta.url);

/** @returns {{capture: (task: {browserId: string, pageId: string, url: string}) => Promise<{data?: Buffer, error?: string}>, close: () => Promise<void>, size: number}} */
const createScreenshotPool = () => {
  const workerCount = Math.max(1, Math.trunc(defaultWorkerCount()) || 1);
  consola.info('Screenshot pool created', { 'event.domain': 'screenshots', 'screenshots.workers': workerCount });
  /** @type {Set<import('node:worker_threads').Worker>} */
  const all = new Set();
  /** @type {Array<import('node:worker_threads').Worker>} */
  const idle = [];
  /** @type {Array<{browserId: string, pageId: string, url: string, resolve: (result: {data?: Buffer, error?: string}) => void}>} */
  const queued = [];
  /** @type {Map<import('node:worker_threads').Worker, {resolve: (result: {data?: Buffer, error?: string}) => void}>} */
  const inFlight = new Map();
  let closed = false;

  // Hands queued tasks to idle workers until one side runs out.
  const drain = () => {
    while (queued.length > 0 && idle.length > 0) {
      const worker = idle.pop();
      const task = queued.shift();
      inFlight.set(worker, task);
      worker.postMessage({ browserId: task.browserId, pageId: task.pageId, url: task.url });
    }
  };

  const release = (worker) => {
    if (closed) {
      return;
    }
    idle.push(worker);
    drain();
  };

  const drop = (worker) => {
    // A close() clears `all` first, so this only counts a real crash.
    const crashed = all.delete(worker);
    const at = idle.indexOf(worker);
    if (at !== -1) {
      idle.splice(at, 1);
    }
    const task = inFlight.get(worker);
    inFlight.delete(worker);
    if (task) {
      task.resolve({ error: 'WORKER_ERROR' });
    }
    // Keep the pool at its configured size so one crash cannot strand the queue.
    if (crashed && !closed && all.size < workerCount) {
      spawn();
      drain();
    }
  };

  const spawn = () => {
    const worker = new Worker(workerUrl());
    all.add(worker);
    idle.push(worker);
    worker.on('message', (message) => {
      const task = inFlight.get(worker);
      inFlight.delete(worker);
      if (task) {
        task.resolve(message?.error ? { error: message.error } : { data: Buffer.from(message.data) });
      }
      release(worker);
    });
    worker.on('error', (error) => {
      consola.error('Screenshot worker failed', { 'event.domain': 'screenshots', 'error.type': String(error) });
      drop(worker);
    });
    // 'error' is always followed by 'exit'; `crashed` keeps drop from counting twice.
    worker.on('exit', () => drop(worker));
    return worker;
  };

  for (let index = 0; index < workerCount; index += 1) {
    spawn();
  }

  const capture = (task) =>
    new Promise((resolve) => {
      if (closed) {
        resolve({ error: 'POOL_CLOSED' });
        return;
      }
      queued.push({ browserId: task.browserId, pageId: task.pageId, url: task.url, resolve });
      drain();
    });

  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    const workers = [...all];
    all.clear();
    idle.length = 0;
    for (const task of queued.splice(0)) {
      task.resolve({ error: 'POOL_CLOSED' });
    }
    for (const task of inFlight.values()) {
      task.resolve({ error: 'POOL_CLOSED' });
    }
    inFlight.clear();
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  };

  return { capture, close, size: workerCount };
};

// Worker half: one capture per message, replying with the PNG Buffer (never transferred).
if (!isMainThread && parentPort) {
  parentPort.on('message', async ({ browserId, pageId, url }) => {
    const result = await capturePageScreenshot({ browserId, pageId, cdpUrlFor: () => url });
    parentPort.postMessage(result.error ? { error: result.error } : { data: result.data });
  });
}

export { createScreenshotPool };
