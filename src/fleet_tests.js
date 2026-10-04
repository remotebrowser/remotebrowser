import test from 'node:test';
import assert from 'node:assert/strict';

// Set before ./config is first required, since config freezes what it read.
// The trailing slash is deliberate: it must not survive into the request URL.
// With an origin set the facade delegates to an external fleet; the in-process
// container path is covered in src/fleet_local_tests.js.
process.env.BROWSERFLEET_URL = 'http://browserfleet.test/';

const { isWellFormedBrowserId, startBrowser, checkBrowserFleetHealth, browserExists, browserCdpUrl, stopBrowser } =
  await import('./fleet.js');
const { setContainerClient, createContainerClient } = await import('./container.js');

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stubFetch = (respond) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return respond();
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
};

// Precedence: with an origin configured, every operation must go to the
// external fleet and never fall through to the local container runtime.
test('a configured BROWSERFLEET_URL takes precedence over the local container manager', async () => {
  const containerCalls = [];
  const recording = (name, result) => async () => {
    containerCalls.push(name);
    return result;
  };
  setContainerClient({
    launchBrowser: recording('launchBrowser', { browserId: 'local-should-not-be-used' }),
    browserIsRunning: recording('browserIsRunning', true),
    browserExists: recording('browserExists', true),
    stopBrowser: recording('stopBrowser', undefined),
    resolveCdpUrl: recording('resolveCdpUrl', 'ws://local-should-not-be-used'),
    health: recording('health', true)
  });
  const { restore } = stubFetch(() => jsonResponse({ browser_id: 'fleet-1' }));
  try {
    assert.deepEqual(await startBrowser(), { data: { browserId: 'fleet-1' } });
    assert.deepEqual(await checkBrowserFleetHealth(), { data: { healthy: true } });
    assert.deepEqual(await browserExists({ browserId: 'fleet-1' }), { data: true });
    assert.deepEqual(await stopBrowser({ browserId: 'fleet-1' }), { data: true });
    assert.equal(await browserCdpUrl({ browserId: 'fleet-1' }), 'ws://browserfleet.test/api/v1/browsers/fleet-1/cdp');
  } finally {
    restore();
    setContainerClient(createContainerClient());
  }
  assert.deepEqual(containerCalls, [], 'the external fleet path must not consult the local container runtime');
});

test('startBrowser posts to /api/v1/browsers and returns the id the server assigned', async () => {
  const { calls, restore } = stubFetch(() => jsonResponse({ browser_id: 'foobar', ws_url: 'ignored', extra: 1 }));
  try {
    const result = await startBrowser();
    assert.deepEqual(result, { data: { browserId: 'foobar' } });
    assert.equal(calls.length, 1);
    // Exactly this path: a trailing slash falls through to the server's
    // /api/v1/browsers/{browser_id} route and comes back 405.
    assert.equal(calls[0].url, 'http://browserfleet.test/api/v1/browsers');
    assert.equal(calls[0].opts.method, 'POST');
    assert.ok(calls[0].opts.signal, 'the request must be bounded by a timeout');
  } finally {
    restore();
  }
});

test('startBrowser returns an error when the server rejects the request', async () => {
  const { restore } = stubFetch(() => jsonResponse({ detail: 'at capacity' }, 503));
  try {
    const result = await startBrowser();
    assert.match(result.error, /503/);
    assert.equal(result.data, undefined);
  } finally {
    restore();
  }
});

test('startBrowser returns an error when the server is unreachable', async () => {
  const { restore } = stubFetch(() => {
    throw new Error('connect ECONNREFUSED');
  });
  try {
    const result = await startBrowser();
    assert.deepEqual(result, { error: 'NETWORK' });
  } finally {
    restore();
  }
});

test('startBrowser returns an error when the response carries no browser id', async () => {
  for (const body of [{}, { browser_id: '' }, { browser_id: 42 }]) {
    const { restore } = stubFetch(() => jsonResponse(body));
    try {
      const result = await startBrowser();
      assert.deepEqual(result, { error: 'MISSING_BROWSER_ID' }, `for ${JSON.stringify(body)}`);
    } finally {
      restore();
    }
  }
});

// A traversal-shaped id would be stored and pasted into request paths; refuse it here.
test('startBrowser rejects a browser id that is not a safe path segment', async () => {
  for (const browserId of ['x/../../admin', '..', 'a.b', 'a%2f']) {
    const { restore } = stubFetch(() => jsonResponse({ browser_id: browserId }));
    try {
      const result = await startBrowser();
      assert.equal(result.error, 'INVALID_BROWSER_ID', `for ${JSON.stringify(browserId)}`);
      assert.equal(result.data, undefined);
    } finally {
      restore();
    }
  }
});

test('checkBrowserFleetHealth GETs /health and reports a healthy server', async () => {
  const { calls, restore } = stubFetch(() => new Response('ok', { status: 200 }));
  try {
    const result = await checkBrowserFleetHealth();
    assert.deepEqual(result, { data: { healthy: true } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://browserfleet.test/health');
    assert.equal(calls[0].opts.method, undefined);
    assert.ok(calls[0].opts.signal, 'the request must be bounded by a timeout');
  } finally {
    restore();
  }
});

// Only 200 counts: a redirect or a 204 from something that isn't the
// browserfleet server should not read as a healthy backend.
test('checkBrowserFleetHealth reports any status other than 200 as an error', async () => {
  for (const status of [204, 302, 404, 500, 503]) {
    const { restore } = stubFetch(() => new Response(null, { status }));
    try {
      const result = await checkBrowserFleetHealth();
      assert.deepEqual(result, { error: `HTTP ${status}` });
    } finally {
      restore();
    }
  }
});

test('checkBrowserFleetHealth reports an unreachable server', async () => {
  const { restore } = stubFetch(() => {
    throw new Error('connect ECONNREFUSED');
  });
  try {
    const result = await checkBrowserFleetHealth();
    assert.deepEqual(result, { error: 'NETWORK' });
  } finally {
    restore();
  }
});

test('browserExists GETs /api/v1/browsers/{id} and reports the browser as alive', async () => {
  const { calls, restore } = stubFetch(() => jsonResponse({ browser_id: 'foobar', status: 'running' }));
  try {
    const result = await browserExists({ browserId: 'foobar' });
    assert.deepEqual(result, { data: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://browserfleet.test/api/v1/browsers/foobar');
    assert.equal(calls[0].opts.method, undefined);
    assert.ok(calls[0].opts.signal, 'the request must be bounded by a timeout');
  } finally {
    restore();
  }
});

test('browserExists treats a 404 as a browser that does not exist', async () => {
  const { calls, restore } = stubFetch(() => jsonResponse({ detail: 'not found' }, 404));
  try {
    assert.deepEqual(await browserExists({ browserId: 'foobar' }), { data: false });
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('browserExists reports any status other than 2xx and 404 as an error', async () => {
  for (const status of [301, 500, 503]) {
    const { restore } = stubFetch(() => new Response(null, { status }));
    try {
      assert.deepEqual(await browserExists({ browserId: 'foobar' }), { error: `HTTP ${status}` });
    } finally {
      restore();
    }
  }
});

test('browserExists reports an unreachable server', async () => {
  const { restore } = stubFetch(() => {
    throw new Error('connect ECONNREFUSED');
  });
  try {
    assert.deepEqual(await browserExists({ browserId: 'foobar' }), { error: 'NETWORK' });
  } finally {
    restore();
  }
});

// The relay dials this URL for every CDP connection, so the scheme swap and the
// single slash between origin and path are what the whole endpoint rests on.
test('browserCdpUrl builds the upstream CDP URL from the configured origin', async () => {
  // The configured origin above carries a trailing slash; it must not survive
  // into a doubled one here.
  assert.equal(await browserCdpUrl({ browserId: 'foobar' }), 'ws://browserfleet.test/api/v1/browsers/foobar/cdp');
});

test('browserCdpUrl upgrades an https origin to wss', async () => {
  assert.equal(
    await browserCdpUrl({ browserId: 'foobar', origin: 'https://browsers.example.com' }),
    'wss://browsers.example.com/api/v1/browsers/foobar/cdp'
  );
});

// A base path in the origin belongs to the upstream server's mount point, so it
// is kept rather than replaced.
test('browserCdpUrl preserves a base path in the origin', async () => {
  assert.equal(
    await browserCdpUrl({ browserId: 'foobar', origin: 'http://gateway.test/rb' }),
    'ws://gateway.test/rb/api/v1/browsers/foobar/cdp'
  );
});

test('browserCdpUrl returns null for an origin that is not http or https', async () => {
  for (const origin of ['ftp://host', 'file:///etc', 'wss://already-ws', 'host-without-scheme']) {
    assert.equal(await browserCdpUrl({ browserId: 'foobar', origin }), null, `for ${JSON.stringify(origin)}`);
  }
});

test('stopBrowser DELETEs /api/v1/browsers/{id} and reports success', async () => {
  const { calls, restore } = stubFetch(() => new Response(null, { status: 204 }));
  try {
    const result = await stopBrowser({ browserId: 'foobar' });
    assert.deepEqual(result, { data: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://browserfleet.test/api/v1/browsers/foobar');
    assert.equal(calls[0].opts.method, 'DELETE');
    assert.ok(calls[0].opts.signal, 'the request must be bounded by a timeout');
  } finally {
    restore();
  }
});

// The fleet already having no such browser - already stopped, or never
// provisioned - is the caller's goal already being true, not a failure.
test('stopBrowser treats a 404 as success rather than an error', async () => {
  const { restore } = stubFetch(() => jsonResponse({ detail: 'not found' }, 404));
  try {
    assert.deepEqual(await stopBrowser({ browserId: 'foobar' }), { data: true });
  } finally {
    restore();
  }
});

test('stopBrowser reports any status other than 2xx and 404 as an error', async () => {
  for (const status of [401, 500, 503]) {
    const { restore } = stubFetch(() => new Response(null, { status }));
    try {
      assert.deepEqual(await stopBrowser({ browserId: 'foobar' }), { error: `HTTP ${status}` });
    } finally {
      restore();
    }
  }
});

test('stopBrowser reports an unreachable server', async () => {
  const { restore } = stubFetch(() => {
    throw new Error('connect ECONNREFUSED');
  });
  try {
    assert.deepEqual(await stopBrowser({ browserId: 'foobar' }), { error: 'NETWORK' });
  } finally {
    restore();
  }
});

// A browser terminated while still 'starting' has no internalBrowserId yet -
// there is nothing for the fleet to stop, so this must not call out at all.
test('stopBrowser is a no-op success for an empty browser id, without calling out', async () => {
  const { calls, restore } = stubFetch(() => new Response(null, { status: 500 }));
  try {
    assert.deepEqual(await stopBrowser({ browserId: '' }), { data: true });
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('isWellFormedBrowserId accepts letters, digits, underscore and hyphen', () => {
  for (const id of ['foobar', 'mock-1', 'br_2', 'A'.repeat(64)]) {
    assert.equal(isWellFormedBrowserId(id), true, `for ${id}`);
  }
});

// The id is a URL path segment, so reject anything that could escape it.
test('isWellFormedBrowserId rejects path separators and traversal characters', () => {
  for (const id of ['a/b', '..', '../admin', 'a.b', 'a%2f', 'a?b', 'a#b', 'a\\b', 'a:b']) {
    assert.equal(isWellFormedBrowserId(id), false, `for ${id}`);
  }
});

test('isWellFormedBrowserId rejects empty, over-long, and non-string input', () => {
  for (const bad of ['', 'A'.repeat(65), null, undefined, 42, {}]) {
    assert.equal(isWellFormedBrowserId(bad), false, `for ${JSON.stringify(bad)}`);
  }
});
