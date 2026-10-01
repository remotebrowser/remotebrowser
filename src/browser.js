import { consola } from 'consola/basic';
import { config } from './config.js';
import { checkCdpConnection as dialCdp } from './cdp.js';
import {
  updateBrowserInstanceStatus as writeStatus,
  listBrowserInstancesByWorkspace as listInstances
} from './models/browsers.js';

// Capacity counting and the status refresh are shared by several routes, so they live here.

// Only 'terminated' frees a slot; starting/running/error still hold one.
const countActiveBrowsers = (instances) => instances.filter((instance) => instance.status !== 'terminated').length;

const browserLimitFor = (workspace) => (workspace.isPersonal ? config.maxPersonalBrowsers : config.maxTeamBrowsers);

/** @param {{workspace: {isPersonal: boolean}, instances: Array<{status: string}>}} params `instances` must be the full unfiltered list, even if the caller filters it for display. @returns {{used: number, limit: number, atCapacity: boolean}} */
const describeBrowserCapacity = ({ workspace, instances }) => {
  const limit = browserLimitFor(workspace);
  const used = countActiveBrowsers(instances);
  return { used, limit, atCapacity: used >= limit };
};

// Only these statuses get dialed again; 'terminated' is final.
const CHECKABLE_STATUSES = new Set(['starting', 'running', 'error']);

// Checks run this often per watched workspace...
const DEFAULT_INTERVAL_MS = 13000;
// ...and a workspace nobody has loaded a page for in this long stops being
// watched - see createBrowserStatusScheduler below for why that matters.
const DEFAULT_IDLE_TIMEOUT_MS = 60000;

// Pure: pick the next status from a CDP check. null means no change, so callers
// skip the write. Failed startups stay 'starting'; 'terminated' is never revisited.
const nextBrowserStatus = ({ currentStatus, cdpConnected }) => {
  if (currentStatus === 'terminated') {
    return null;
  }
  const desired = cdpConnected ? 'running' : { running: 'error', error: 'terminated' }[currentStatus];
  return desired && desired !== currentStatus ? desired : null;
};

// One timer per actively viewed workspace, checking its browsers one at a time
// so the server is not bombarded. Timers live in memory by design. Inputs are
// injectable for tests.
const createBrowserStatusScheduler = ({
  intervalMs = DEFAULT_INTERVAL_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  listBrowserInstancesByWorkspace = listInstances,
  checkCdpConnection = dialCdp,
  updateBrowserInstanceStatus = writeStatus
} = {}) => {
  // workspaceId -> { lastSeenAt, timer }
  const watched = new Map();

  // Runs from setInterval with nothing above it to catch errors: never throw, log every failure instead.
  const tick = async (workspaceId) => {
    const entry = watched.get(workspaceId);
    if (!entry) {
      return;
    }
    if (now() - entry.lastSeenAt > idleTimeoutMs) {
      clearIntervalFn(entry.timer);
      watched.delete(workspaceId);
      return;
    }
    let listResult;
    try {
      // No repair here: a deleted workspace self-heals on the next real page visit
      // (see src/routes/homepage.js); just skip this round.
      listResult = await listBrowserInstancesByWorkspace({ workspaceId, personalWorkspaceRepair: null });
    } catch (error) {
      consola.error(`Unable to list browsers for workspace ${workspaceId}: ${String(error)}`);
      return;
    }
    if (listResult.error) {
      consola.error(`Unable to list browsers for workspace ${workspaceId}: ${listResult.error}`);
      return;
    }
    const eligible = listResult.data.filter((instance) => CHECKABLE_STATUSES.has(instance.status));
    // One dial at a time, never Promise.all: this scheduler exists to avoid
    // bombarding the server.
    for (const instance of eligible) {
      try {
        const checked = await checkCdpConnection({ browserId: instance.internalBrowserId });
        const toStatus = nextBrowserStatus({ currentStatus: instance.status, cdpConnected: Boolean(checked.data) });
        if (toStatus === null) {
          continue;
        }
        const written = await updateBrowserInstanceStatus({
          workspaceId,
          browserInstanceId: instance.browserInstanceId,
          toStatus
        });
        if (written.error) {
          consola.error(`Unable to update the status of browser ${instance.browserInstanceId}: ${written.error}`);
        }
      } catch (error) {
        consola.error(`Unable to refresh the status of browser ${instance.browserInstanceId}: ${String(error)}`);
      }
    }
  };

  // Called on every page load of GET / and GET /browsers, so a viewed workspace keeps one timer.
  const scheduleBrowserStatusCheck = ({ workspaceId }) => {
    const existing = watched.get(workspaceId);
    if (existing) {
      existing.lastSeenAt = now();
      return;
    }
    const entry = { lastSeenAt: now(), timer: null };
    entry.timer = setIntervalFn(() => tick(workspaceId), intervalMs);
    // Never keep the process alive just because someone is watching.
    entry.timer?.unref?.();
    watched.set(workspaceId, entry);
  };

  // Test seam: whether a workspace is currently watched.
  const isScheduled = (workspaceId) => watched.has(workspaceId);

  return { scheduleBrowserStatusCheck, isScheduled };
};

// The production singleton every route imports; one registry per server
// instance.
const { scheduleBrowserStatusCheck, isScheduled } = createBrowserStatusScheduler();

export {
  countActiveBrowsers,
  browserLimitFor,
  describeBrowserCapacity,
  nextBrowserStatus,
  createBrowserStatusScheduler,
  scheduleBrowserStatusCheck,
  isScheduled
};
