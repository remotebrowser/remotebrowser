import test from 'node:test';
import assert from 'node:assert/strict';
import { consola } from 'consola/basic';

const { countActiveBrowsers, browserLimitFor, describeBrowserCapacity } = await import('./browser.js');
const { nextBrowserStatus, createBrowserStatusScheduler } = await import('./browser.js');
const { config } = await import('./config.js');

test('countActiveBrowsers counts every non-terminated status', () => {
  const instances = [{ status: 'starting' }, { status: 'running' }, { status: 'error' }, { status: 'terminated' }];
  assert.equal(countActiveBrowsers(instances), 3);
});

test('countActiveBrowsers is 0 for an empty or all-terminated list', () => {
  assert.equal(countActiveBrowsers([]), 0);
  assert.equal(countActiveBrowsers([{ status: 'terminated' }, { status: 'terminated' }]), 0);
});

test('browserLimitFor picks the personal limit for a personal workspace', () => {
  assert.equal(browserLimitFor({ isPersonal: true }), config.maxPersonalBrowsers);
});

test('browserLimitFor picks the team limit for a shared workspace', () => {
  assert.equal(browserLimitFor({ isPersonal: false }), config.maxTeamBrowsers);
});

test('describeBrowserCapacity reports not at capacity while under the limit', () => {
  const workspace = { isPersonal: true };
  const instances = Array.from({ length: config.maxPersonalBrowsers - 1 }, () => ({ status: 'running' }));
  const capacity = describeBrowserCapacity({ workspace, instances });
  assert.equal(capacity.used, config.maxPersonalBrowsers - 1);
  assert.equal(capacity.limit, config.maxPersonalBrowsers);
  assert.equal(capacity.atCapacity, false);
});

test('describeBrowserCapacity reports at capacity once used reaches the limit', () => {
  const workspace = { isPersonal: true };
  const instances = Array.from({ length: config.maxPersonalBrowsers }, () => ({ status: 'running' }));
  const capacity = describeBrowserCapacity({ workspace, instances });
  assert.equal(capacity.atCapacity, true);
});

test('describeBrowserCapacity ignores terminated instances when checking capacity', () => {
  const workspace = { isPersonal: true };
  const instances = Array.from({ length: config.maxPersonalBrowsers }, () => ({ status: 'terminated' }));
  const capacity = describeBrowserCapacity({ workspace, instances });
  assert.equal(capacity.used, 0);
  assert.equal(capacity.atCapacity, false);
});

test('describeBrowserCapacity uses the team limit for a shared workspace', () => {
  const workspace = { isPersonal: false };
  const capacity = describeBrowserCapacity({ workspace, instances: [] });
  assert.equal(capacity.limit, config.maxTeamBrowsers);
});

const instance = (over = {}) => ({
  browserInstanceId: 'B1',
  status: 'running',
  internalBrowserId: 'foobar',
  ...over
});

const captureErrors = () => {
  const original = consola.error;
  const messages = [];
  consola.error = (...args) => messages.push(args.map(String).join(' '));
  return {
    messages,
    restore: () => {
      consola.error = original;
    }
  };
};

// Stands in for the real setInterval/clearInterval: records every timer a
// scheduler starts (its callback and delay) instead of actually waiting, and
// lets a test fire one on demand via calls[i].callback(). Ids are just the
// call's own index, which is all clearIntervalFn needs to mark it cleared.
const fakeTimers = () => {
  const calls = [];
  return {
    calls,
    setIntervalFn: (callback, ms) => {
      calls.push({ callback, ms, cleared: false });
      return calls.length - 1;
    },
    clearIntervalFn: (id) => {
      calls[id].cleared = true;
    }
  };
};

const fakeClock = (start = 0) => {
  let current = start;
  return { now: () => current, advanceBy: (ms) => (current += ms) };
};

test('nextBrowserStatus moves starting to running once the CDP connection succeeds', () => {
  assert.equal(nextBrowserStatus({ currentStatus: 'starting', cdpConnected: true }), 'running');
});

test('nextBrowserStatus leaves a not-yet-provisioned starting instance alone on failure', () => {
  // A freshly launched browser has no CDP endpoint to dial yet - failing here
  // just means "still starting", not "dead".
  assert.equal(nextBrowserStatus({ currentStatus: 'starting', cdpConnected: false }), null);
});

// null, not 'running': the value would not actually change. Returning null
// here is what tells refreshBrowserStatuses to skip the write entirely instead
// of writing the same status on every healthy poll.
test('nextBrowserStatus makes no write when a running instance is still healthy', () => {
  assert.equal(nextBrowserStatus({ currentStatus: 'running', cdpConnected: true }), null);
});

test('nextBrowserStatus demotes running to error once the CDP connection fails', () => {
  assert.equal(nextBrowserStatus({ currentStatus: 'running', cdpConnected: false }), 'error');
});

test('nextBrowserStatus recovers an error instance back to running if it answers again', () => {
  assert.equal(nextBrowserStatus({ currentStatus: 'error', cdpConnected: true }), 'running');
});

test('nextBrowserStatus gives up on an error instance that still cannot be reached', () => {
  assert.equal(nextBrowserStatus({ currentStatus: 'error', cdpConnected: false }), 'terminated');
});

test('nextBrowserStatus never revives a terminated instance', () => {
  assert.equal(nextBrowserStatus({ currentStatus: 'terminated', cdpConnected: true }), null);
  assert.equal(nextBrowserStatus({ currentStatus: 'terminated', cdpConnected: false }), null);
});

// A fresh scheduler per test, fully injected - never a real timer, a real
// clock, or a real network/database call.
const buildScheduler = ({
  instances = [],
  checkCdpConnection = async () => ({ data: true }),
  updateBrowserInstanceStatus = async () => ({ data: true }),
  intervalMs,
  idleTimeoutMs,
  now
} = {}) => {
  const timers = fakeTimers();
  const listCalls = [];
  const scheduler = createBrowserStatusScheduler({
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(now !== undefined ? { now } : {}),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    listBrowserInstancesByWorkspace: async (params) => {
      listCalls.push(params);
      return { data: instances };
    },
    checkCdpConnection,
    updateBrowserInstanceStatus
  });
  return { ...scheduler, timers: timers.calls, listCalls };
};

test('scheduleBrowserStatusCheck starts exactly one repeating timer per workspace', () => {
  const s = buildScheduler();
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  assert.equal(s.timers.length, 1, 'a workspace already being watched must not get a second timer');
  assert.equal(s.timers[0].ms, 13000, 'checks run every 13 seconds');
});

test('scheduleBrowserStatusCheck starts a separate timer per distinct workspace', () => {
  const s = buildScheduler();
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  s.scheduleBrowserStatusCheck({ workspaceId: 'Twxyz' });
  assert.equal(s.timers.length, 2);
});

test('scheduling an already-watched workspace again refreshes its idle window instead of starting a new timer', () => {
  const clock = fakeClock();
  const s = buildScheduler({ now: clock.now, idleTimeoutMs: 60000 });
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  clock.advanceBy(59000);
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  assert.equal(s.timers.length, 1, 'still just the one timer');
});

test('a tick lists the workspace it was scheduled for', async () => {
  const s = buildScheduler();
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  await s.timers[0].callback();
  assert.equal(s.listCalls[0].workspaceId, 'Tabcd');
});

test('a tick checks only starting, running, and error instances', async () => {
  const checked = [];
  const s = buildScheduler({
    instances: [
      instance({ browserInstanceId: 'B1', status: 'starting' }),
      instance({ browserInstanceId: 'B2', status: 'running' }),
      instance({ browserInstanceId: 'B3', status: 'error' }),
      instance({ browserInstanceId: 'B4', status: 'terminated' })
    ],
    checkCdpConnection: async ({ browserId }) => {
      checked.push(browserId);
      return { data: true };
    }
  });
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  await s.timers[0].callback();
  assert.deepEqual(checked, ['foobar', 'foobar', 'foobar'], 'the terminated instance must never be dialed');
});

// The whole point of the change: bombarding the browserfleet server with N
// simultaneous dials is exactly what moving off Promise.all was meant to stop.
test('a tick checks its instances one at a time, never two dials in flight at once', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];
  const s = buildScheduler({
    instances: [
      instance({ browserInstanceId: 'B1', status: 'running', internalBrowserId: 'br-1' }),
      instance({ browserInstanceId: 'B2', status: 'running', internalBrowserId: 'br-2' }),
      instance({ browserInstanceId: 'B3', status: 'running', internalBrowserId: 'br-3' })
    ],
    checkCdpConnection: async ({ browserId }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${browserId}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${browserId}`);
      inFlight -= 1;
      return { data: true };
    }
  });
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  await s.timers[0].callback();
  assert.equal(maxInFlight, 1, 'no two CDP dials may be in flight at the same time');
  assert.deepEqual(order, ['start:br-1', 'end:br-1', 'start:br-2', 'end:br-2', 'start:br-3', 'end:br-3']);
});

test('a tick writes the transition the CDP check implies', async () => {
  const written = [];
  const s = buildScheduler({
    instances: [instance({ browserInstanceId: 'B1', status: 'running' })],
    checkCdpConnection: async () => ({ data: false }),
    updateBrowserInstanceStatus: async (params) => {
      written.push(params);
      return { data: true };
    }
  });
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  await s.timers[0].callback();
  assert.deepEqual(written, [{ workspaceId: 'Tabcd', browserInstanceId: 'B1', toStatus: 'error' }]);
});

// Otherwise a healthy browser would get written on every tick for no reason.
test('a tick writes nothing when no instance actually changed status', async () => {
  const written = [];
  const s = buildScheduler({
    instances: [instance({ browserInstanceId: 'B1', status: 'running' })],
    checkCdpConnection: async () => ({ data: true }),
    updateBrowserInstanceStatus: async (params) => {
      written.push(params);
      return { data: true };
    }
  });
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  await s.timers[0].callback();
  assert.deepEqual(written, []);
});

test('a tick clears its own timer and forgets the workspace once nobody has viewed it recently', async () => {
  const clock = fakeClock();
  const s = buildScheduler({ now: clock.now, idleTimeoutMs: 60000 });
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  clock.advanceBy(60001);
  await s.timers[0].callback();
  assert.equal(s.timers[0].cleared, true);
  assert.equal(s.listCalls.length, 0, 'an idle workspace is never even listed, let alone checked');
  // Scheduling it again after being forgotten starts a genuinely new timer,
  // not a no-op against the one that just cleared itself.
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  assert.equal(s.timers.length, 2);
});

test('a tick keeps running while the workspace is still within its idle window', async () => {
  const clock = fakeClock();
  const s = buildScheduler({
    now: clock.now,
    idleTimeoutMs: 60000,
    instances: [instance({ browserInstanceId: 'B1', status: 'running' })]
  });
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  clock.advanceBy(59000);
  await s.timers[0].callback();
  assert.equal(s.timers[0].cleared, false);
  assert.equal(s.listCalls.length, 1);
});

// Always invoked from a bare setInterval callback (see the real
// setIntervalFn default), with nothing above it to catch a rejection.
test('a tick reports rather than throws when listing instances itself fails', async () => {
  const errors = captureErrors();
  const timers = fakeTimers();
  try {
    const scheduler = createBrowserStatusScheduler({
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      listBrowserInstancesByWorkspace: async () => ({ error: 'boom' }),
      checkCdpConnection: async () => ({ data: true }),
      updateBrowserInstanceStatus: async () => ({ data: true })
    });
    scheduler.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
    await assert.doesNotReject(timers.calls[0].callback());
    assert.match(errors.messages.join('\n'), /Tabcd/);
    assert.match(errors.messages.join('\n'), /boom/);
  } finally {
    errors.restore();
  }
});

test('a tick reports a failed check but still checks the rest of the workspace', async () => {
  const errors = captureErrors();
  const checked = [];
  const s = buildScheduler({
    instances: [
      instance({ browserInstanceId: 'B1', status: 'running', internalBrowserId: 'br-1' }),
      instance({ browserInstanceId: 'B2', status: 'running', internalBrowserId: 'br-2' })
    ],
    checkCdpConnection: async ({ browserId }) => {
      checked.push(browserId);
      if (browserId === 'br-1') {
        throw new Error('socket exploded');
      }
      return { data: true };
    }
  });
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  try {
    await assert.doesNotReject(s.timers[0].callback());
    assert.deepEqual(checked, ['br-1', 'br-2'], 'one failed dial must not stop the ones after it');
    assert.match(errors.messages.join('\n'), /B1/);
  } finally {
    errors.restore();
  }
});

test('a tick reports rather than throws when a status write is rejected', async () => {
  const errors = captureErrors();
  const s = buildScheduler({
    instances: [instance({ browserInstanceId: 'B1', status: 'running' })],
    checkCdpConnection: async () => ({ data: false }),
    updateBrowserInstanceStatus: async () => ({ error: 'boom' })
  });
  s.scheduleBrowserStatusCheck({ workspaceId: 'Tabcd' });
  try {
    await assert.doesNotReject(s.timers[0].callback());
    assert.match(errors.messages.join('\n'), /B1/);
    assert.match(errors.messages.join('\n'), /boom/);
  } finally {
    errors.restore();
  }
});
