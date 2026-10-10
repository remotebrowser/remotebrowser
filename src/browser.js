import { consola } from 'consola/basic';
import { config } from './config.js';
import { createBrowserMonitor } from './workers/monitor.js';
import { browserCdpUrl, browserExists } from './fleet.js';
import {
  updateBrowserInstanceStatus,
  listProvisionedBrowserInstances,
  listActiveBrowserInstances,
  markBrowserInstanceTerminated
} from './models/browsers.js';

// Shared browser logic: capacity, status transitions, and the monitor registry.

// Only 'terminated' frees a slot; starting/running/error still hold one.
const countActiveBrowsers = (instances) => instances.filter((instance) => instance.status !== 'terminated').length;

const browserLimitFor = (workspace) => (workspace.isPersonal ? config.maxPersonalBrowsers : config.maxTeamBrowsers);

/** @param {{workspace: {isPersonal: boolean}, instances: Array<{status: string}>}} params `instances` must be the full unfiltered list, even if the caller filters it for display. @returns {{used: number, limit: number, atCapacity: boolean}} */
const describeBrowserCapacity = ({ workspace, instances }) => {
  const limit = browserLimitFor(workspace);
  const used = countActiveBrowsers(instances);
  return { used, limit, atCapacity: used >= limit };
};

// Pure: pick the next status from a CDP check. null means no change, so callers
// skip the write. Failed startups stay 'starting'; 'terminated' is never revisited.
const nextBrowserStatus = ({ currentStatus, cdpConnected }) => {
  if (currentStatus === 'terminated') {
    return null;
  }
  const desired = cdpConnected ? 'running' : { running: 'error', error: 'terminated' }[currentStatus];
  return desired && desired !== currentStatus ? desired : null;
};

// Only this registry writes status rows; workers just report over postMessage.

// A worker exit may be a CDP blip, so drop the monitor only once the fleet says
// the browser is gone. The fleet can be down too, so give up after about 1 hour.
const RESTART_BACKOFF = 2000;
const MAX_RESTART_BACKOFF = 30000;
const MAX_RESTARTS = 122;

// 'ready' proves the CDP connection opened, which is exactly what 'running' means.
// 'gone' is the fleet confirming the browser no longer exists.
const STATUS_FOR_STATE = { ready: 'running', disconnected: 'error', error: 'error', gone: 'terminated' };

// Navigations are surfaced on stdout for now; nothing consumes them yet.
const logNavigation = ({ internalBrowserId, pageId, url }) => {
  consola.log('Browser navigated', {
    'event.domain': 'browser-monitor',
    'rb.browser_id': internalBrowserId,
    'browser.page_id': pageId,
    'browser.url': url
  });
};

const writeStatus = ({ workspaceId, browserInstanceId, state }) => {
  const toStatus = STATUS_FOR_STATE[state];
  if (!toStatus) {
    return;
  }
  void updateBrowserInstanceStatus({ workspaceId, browserInstanceId, toStatus }).then((written) => {
    if (written?.error) {
      consola.error(`Unable to update the status of browser ${browserInstanceId}: ${written.error}`, {
        'event.domain': 'browser-monitor'
      });
    }
  });
};

// A factory so tests can swap the worker, the fleet and the database.
const createBrowserMonitors = ({
  createMonitor = createBrowserMonitor,
  cdpUrlFor = ({ browserId }) => browserCdpUrl({ browserId }),
  exists = browserExists,
  setStatus = writeStatus,
  listBrowsers = listProvisionedBrowserInstances,
  backoff = RESTART_BACKOFF,
  maxBackoff = MAX_RESTART_BACKOFF,
  maxRestarts = MAX_RESTARTS
} = {}) => {
  /** @type {Map<string, {workspaceId: number, browserInstanceId: number, internalBrowserId: string, cdpUrl: string | null, restarts: number, stopping: boolean, monitor: {stop: () => Promise<void>} | null}>} */
  const monitors = new Map();

  const drop = (record) => {
    record.stopping = true;
    if (monitors.get(record.internalBrowserId) === record) {
      monitors.delete(record.internalBrowserId);
    }
  };

  const restart = async (record) => {
    // A stop we asked for is not a crash.
    if (record.stopping) {
      return;
    }
    record.restarts += 1;
    const { data: present, error } = await exists({ browserId: record.internalBrowserId });
    if (record.stopping) {
      return;
    }
    // Only a definite "gone" ends the monitor; a failed check proves nothing.
    if (present === false) {
      consola.info('Browser is gone; removing its monitor', {
        'event.domain': 'browser-monitor',
        'rb.browser_id': record.internalBrowserId
      });
      setStatus({ workspaceId: record.workspaceId, browserInstanceId: record.browserInstanceId, state: 'gone' });
      drop(record);
      return;
    }
    if (record.restarts > maxRestarts) {
      consola.error('Browser monitor gave up after repeated failures', {
        'event.domain': 'browser-monitor',
        'rb.browser_id': record.internalBrowserId,
        'browser.restarts': record.restarts
      });
      drop(record);
      return;
    }
    consola.warn('Browser monitor exited; restarting', {
      'event.domain': 'browser-monitor',
      'rb.browser_id': record.internalBrowserId,
      'browser.restarts': record.restarts,
      'browser.check_error': error ?? null
    });
    const timer = setTimeout(
      () => {
        if (!record.stopping) {
          spawn(record);
        }
      },
      Math.min(backoff * 2 ** (record.restarts - 1), maxBackoff)
    );
    timer.unref?.();
  };

  const spawn = (record) => {
    const { workspaceId, browserInstanceId, internalBrowserId, cdpUrl } = record;
    record.monitor = createMonitor({
      internalBrowserId,
      cdpUrl,
      onNavigation: ({ pageId, url }) => logNavigation({ internalBrowserId, pageId, url }),
      onStatus: ({ state }) => {
        // A message still in flight after a stop must not overwrite the status
        // of a browser that is being terminated.
        if (record.stopping) {
          return;
        }
        // A healthy connection clears the backoff, so only a streak of failures slows retries.
        if (state === 'ready') {
          record.restarts = 0;
        }
        setStatus({ workspaceId, browserInstanceId, state });
      },
      onExit: () => void restart(record)
    });
  };

  // Idempotent: the entry is added before the first await, so two calls cannot
  // start two workers for the same browser.
  const startBrowserMonitor = async ({ workspaceId, browserInstanceId, internalBrowserId, cdpUrl }) => {
    if (typeof internalBrowserId !== 'string' || internalBrowserId === '') {
      return { error: 'INVALID_BROWSER_ID' };
    }
    if (monitors.has(internalBrowserId)) {
      return { data: true };
    }
    const record = {
      workspaceId,
      browserInstanceId,
      internalBrowserId,
      cdpUrl: cdpUrl ?? null,
      restarts: 0,
      stopping: false,
      monitor: null
    };
    monitors.set(internalBrowserId, record);
    if (!record.cdpUrl) {
      try {
        record.cdpUrl = await cdpUrlFor({ browserId: internalBrowserId });
      } catch {
        record.cdpUrl = null;
      }
    }
    // A stop during the await already removed the slot; spawning now would leak a worker.
    if (record.stopping) {
      return { data: false };
    }
    if (!record.cdpUrl) {
      drop(record);
      return { error: 'CDP_URL_UNAVAILABLE' };
    }
    spawn(record);
    return { data: true };
  };

  // Monitors live in memory, so a restart needs one for every existing browser.
  const startAllBrowserMonitors = async () => {
    const listed = await listBrowsers();
    if (listed.error) {
      return { error: listed.error };
    }
    const results = await Promise.all(listed.data.map((browser) => startBrowserMonitor(browser)));
    return { data: { started: results.filter((result) => result.data).length, total: results.length } };
  };

  const stopBrowserMonitor = async ({ internalBrowserId }) => {
    const record = monitors.get(internalBrowserId);
    if (!record) {
      return { data: false };
    }
    drop(record);
    await record.monitor?.stop();
    return { data: true };
  };

  const stopAllBrowserMonitors = async () => {
    const running = [...monitors.values()];
    for (const record of running) {
      drop(record);
    }
    await Promise.allSettled(running.map((record) => record.monitor?.stop() ?? Promise.resolve()));
  };

  const isMonitored = (internalBrowserId) => monitors.has(internalBrowserId);
  const monitoredCount = () => monitors.size;

  return {
    startBrowserMonitor,
    startAllBrowserMonitors,
    stopBrowserMonitor,
    stopAllBrowserMonitors,
    isMonitored,
    monitoredCount
  };
};

const browserMonitors = createBrowserMonitors();

// A row with no fleet id this long after launch belongs to a launch that died.
// A cold image pull is the slowest honest start, so the bound is generous.
const STARTING_TIMEOUT = 15 * 60 * 1000;

/**
 * Frees the capacity slots of browsers that no longer exist: a launch that never
 * got a fleet id, or a browser the fleet says is gone. A failed existence check
 * proves nothing, so that row is left for the next run.
 * @returns {Promise<{data?: {checked: number, terminated: number}, error?: string}>}
 */
const reconcileBrowsers = async ({
  now = Date.now(),
  listBrowsers = listActiveBrowserInstances,
  exists = browserExists,
  terminate = markBrowserInstanceTerminated,
  startingTimeout = STARTING_TIMEOUT
} = {}) => {
  const listed = await listBrowsers();
  if (listed.error) {
    return { error: listed.error };
  }
  let terminated = 0;
  // One at a time: a local check shells out to the container runtime.
  for (const browser of listed.data) {
    const { workspaceId, browserInstanceId, internalBrowserId, createdTimestamp } = browser;
    const gone =
      internalBrowserId === ''
        ? now - createdTimestamp >= startingTimeout
        : (await exists({ browserId: internalBrowserId })).data === false;
    if (!gone) {
      continue;
    }
    const written = await terminate({ workspaceId, browserInstanceId, internalBrowserId });
    if (written.error) {
      consola.error(`Unable to mark browser ${browserInstanceId} as terminated: ${written.error}`, {
        'event.domain': 'browser-reconcile'
      });
    } else if (written.data) {
      terminated += 1;
      consola.info('Browser no longer exists; marked as terminated', {
        'event.domain': 'browser-reconcile',
        'rb.browser_instance_id': browserInstanceId,
        'rb.browser_id': internalBrowserId || null
      });
    }
  }
  return { data: { checked: listed.data.length, terminated } };
};

export {
  countActiveBrowsers,
  browserLimitFor,
  describeBrowserCapacity,
  nextBrowserStatus,
  browserMonitors,
  createBrowserMonitors,
  reconcileBrowsers
};
