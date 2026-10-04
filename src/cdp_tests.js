import test from 'node:test';
import assert from 'node:assert/strict';

const { describe } = test;

// Set before ./config is first required, since config freezes what it read.
process.env.BROWSERFLEET_URL = 'http://browserfleet.test';

const { cdpBrowserHandle } = await import('./cdp.js');
const { generateBrowserHandle } = await import('./handle.js');

// The path segment is a browser handle, not an id, and the two are unrelated now
// that the mapping is stored rather than derived. HANDLE is what a client sends;
// UPSTREAM_ID is what the stubbed lookup resolves it to and what the relay must dial.
const HANDLE = generateBrowserHandle();
const UPSTREAM_ID = 'br-42';
const CDP_PATH = `/cdp/${HANDLE}`;

describe('cdpBrowserHandle', () => {
  test('returns the handle from a CDP upgrade path', () => {
    assert.equal(cdpBrowserHandle(CDP_PATH), HANDLE);
  });

  test('ignores a query string', () => {
    assert.equal(cdpBrowserHandle(`${CDP_PATH}?token=x`), HANDLE);
  });

  // The relay answers 400 for a malformed handle and 404 for a path that was
  // never ours, so the shape match has to succeed here and leave the verdict on
  // the handle itself to the caller.
  test('returns the raw segment even when it is not a valid handle', () => {
    assert.equal(cdpBrowserHandle('/cdp/..%2f..%2fetc'), '..%2f..%2fetc');
    assert.equal(cdpBrowserHandle(`/cdp/${'x'.repeat(400)}`), 'x'.repeat(400));
  });

  test('returns null for any path that is not a CDP upgrade path', () => {
    for (const path of [
      `${CDP_PATH}/`,
      `${CDP_PATH}/extra`,
      '/cdp/',
      `/cdp/a/${HANDLE}`,
      `/CDP/${HANDLE}`,
      `/api/v1/browsers/${HANDLE}/cdp`,
      '/cdp',
      '/',
      ''
    ]) {
      assert.equal(cdpBrowserHandle(path), null, `for ${JSON.stringify(path)}`);
    }
  });
});

import http from 'node:http';
import crypto from 'node:crypto';
import { consola } from 'consola/basic';
import { WebSocket, WebSocketServer } from 'ws';

const {
  mountCdpRelay,
  RELAY_SOCKET_OPTIONS,
  CDP_MAX_PAYLOAD,
  capturePageScreenshot,
  listBrowserPages,
  navigateBrowserToUrl,
  checkCdpConnection
} = await import('./cdp.js');

// The relay logs every connection it opens and closes. Silenced so the suite's
// own output stays readable; the logging case below replaces the methods
// directly, which bypasses the level.
consola.level = -999;

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (condition, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return true;
    }
    await settle(10);
  }
  return false;
};

// A stub standing in for the browserfleet server's own CDP endpoint. Records
// the path the relay dialed, and hands each accepted socket to the test.
const startUpstream = (onConnection) =>
  new Promise((resolve) => {
    const dialed = [];
    const wss = new WebSocketServer({ port: 0, perMessageDeflate: false, maxPayload: 0 });
    wss.on('connection', (socket, req) => {
      dialed.push(req.url);
      onConnection?.(socket);
    });
    wss.once('listening', () =>
      resolve({
        port: wss.address().port,
        dialed,
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close(done);
          })
      })
    );
  });

// Stands in for the database read. Injected so relay tests stay socket-only:
// resolving a handle is the model's job and is covered in
// src/models/browsers_tests.js.
const defaultLookup = async ({ handle }) => ({ data: handle === HANDLE ? UPSTREAM_ID : null });

// Stands in for the browserfleet server's existence endpoint. Injected so
// relay tests stay socket-only; the fetch is covered in
// src/fleet_tests.js.
const defaultBrowserExists = async () => ({ data: true });

// Records every lookup the relay attempts, so a test can assert that a handle
// failing the local MAC check never reaches the database at all.
const recordingLookup = (respond = defaultLookup) => {
  const lookups = [];
  return {
    lookups,
    browserIdForHandle: async (params) => {
      lookups.push(params.handle);
      return respond(params);
    }
  };
};

// The relay under test, on a real HTTP server, with the upstream URL injected so
// it points at the stub's ephemeral port rather than at config.browserFleetUrl.
const startRelay = ({ cdpUrlFor, browserIdForHandle = defaultLookup, browserExists = defaultBrowserExists }) =>
  new Promise((resolve) => {
    const server = http.createServer((_req, res) => res.writeHead(426).end());
    const relay = mountCdpRelay({ server, cdpUrlFor, browserIdForHandle, browserExists });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: async () => {
          await relay.close();
          await new Promise((done) => server.close(done));
        }
      })
    );
  });

const upstreamUrlFor =
  (port) =>
  ({ browserId }) =>
    `ws://127.0.0.1:${port}/api/v1/browsers/${browserId}/cdp`;

// Resolves with the open socket, or rejects with the HTTP status the relay
// answered the upgrade with.
const connect = (port, path) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { perMessageDeflate: false, maxPayload: 0 });
    socket.once('open', () => resolve(socket));
    socket.once('unexpected-response', (_req, res) => {
      res.resume();
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
    });
    socket.once('error', reject);
  });

const nextMessage = (socket) =>
  new Promise((resolve) => socket.once('message', (data, isBinary) => resolve({ data, isBinary })));

const nextClose = (socket) =>
  new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason })));

// Each case builds its own stub upstream, relay and client, and tears all three
// down; a socket left open would keep the test process alive.
const withRelay = async (run, { onUpstreamConnection, browserIdForHandle, browserExists } = {}) => {
  const upstream = await startUpstream(onUpstreamConnection);
  const opened = [];
  /** @type {{port: number, close: () => Promise<void>} | undefined} */
  let relay;
  // Everything after the upstream is listening has to be torn down from a
  // finally that covers startRelay too: a leaked listening server keeps the test
  // process alive long past the failure that caused it.
  try {
    relay = await startRelay({ cdpUrlFor: upstreamUrlFor(upstream.port), browserIdForHandle, browserExists });
    await run({
      upstream,
      relay,
      connect: async (path = CDP_PATH) => {
        const socket = await connect(relay.port, path);
        opened.push(socket);
        return socket;
      }
    });
  } finally {
    for (const socket of opened) {
      socket.terminate();
    }
    await relay?.close();
    await upstream.close();
  }
};

// Captures the first upstream socket so a test can drive the browser end.
const upstreamSocket = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, onUpstreamConnection: (socket) => resolve(socket) };
};

describe('mountCdpRelay', () => {
  // Handle resolved to upstream id; id confirmed; then upstream dialed.
  test('resolves the handle, verifies the browser exists, and dials the upstream id it names', async () => {
    const checked = [];
    await withRelay(
      async ({ upstream, connect }) => {
        await connect(CDP_PATH);
        assert.deepEqual(checked, [UPSTREAM_ID], 'the existence check must use the resolved internal id');
        assert.deepEqual(upstream.dialed, [`/api/v1/browsers/${UPSTREAM_ID}/cdp`]);
      },
      {
        browserExists: async ({ browserId }) => {
          checked.push(browserId);
          return { data: true };
        }
      }
    );
  });

  // Handle resolves to stopped browser; probe turns opaque close into 410.
  test('answers 410 and does not dial when the browser no longer exists', async () => {
    const checked = [];
    await withRelay(
      async ({ upstream, relay }) => {
        await assert.rejects(connect(relay.port, CDP_PATH), (error) => {
          assert.equal(error.statusCode, 410);
          return true;
        });
        assert.deepEqual(checked, [UPSTREAM_ID]);
        assert.deepEqual(upstream.dialed, []);
      },
      {
        browserExists: async ({ browserId }) => {
          checked.push(browserId);
          return { data: false };
        }
      }
    );
  });

  test('answers 503 when the existence check itself fails', async () => {
    await withRelay(
      async ({ upstream, relay }) => {
        await assert.rejects(connect(relay.port, CDP_PATH), (error) => {
          assert.equal(error.statusCode, 503);
          return true;
        });
        assert.deepEqual(upstream.dialed, []);
      },
      { browserExists: async () => ({ error: 'NETWORK' }) }
    );
  });

  // Whole point of handle: short upstream id alone cannot reach a browser.
  test('refuses a bare upstream browser id in place of a handle', async () => {
    await withRelay(async ({ upstream, relay }) => {
      for (const segment of [UPSTREAM_ID, 'foobar', 'B7k2m']) {
        await assert.rejects(
          connect(relay.port, `/cdp/${segment}`),
          (error) => {
            assert.equal(error.statusCode, 400, `for ${segment}`);
            return true;
          },
          `for ${segment}`
        );
      }
      assert.deepEqual(upstream.dialed, [], 'nothing without a valid handle may reach the upstream');
    });
  });

  // Valid MAC = this app issued it; missing mapping = revoked; answer 410.
  test('answers 410 for a well-formed handle that no longer resolves', async () => {
    await withRelay(async ({ upstream, relay }) => {
      const stranger = generateBrowserHandle();
      await assert.rejects(connect(relay.port, `/cdp/${stranger}`), (error) => {
        assert.equal(error.statusCode, 410);
        return true;
      });
      assert.deepEqual(upstream.dialed, []);
    });
  });

  // MAC exists to reject junk without a database read; proving skip is the point.
  test('does not look anything up when the MAC check fails', async () => {
    const recorder = recordingLookup();
    await withRelay(
      async ({ relay }) => {
        for (const segment of ['foobar', UPSTREAM_ID, `${HANDLE.slice(0, -1)}${HANDLE.at(-1) === 'a' ? 'b' : 'a'}`]) {
          await assert.rejects(connect(relay.port, `/cdp/${segment}`), (error) => {
            assert.equal(error.statusCode, 400, `for ${segment}`);
            return true;
          });
        }
        assert.deepEqual(recorder.lookups, [], 'no handle should have reached the lookup');
      },
      { browserIdForHandle: recorder.browserIdForHandle }
    );
  });

  // Resolve is first await; client can leave mid-lookup; catch early to avoid ghost dials.
  test('does not dial or crash when the client disappears during the handle lookup', async () => {
    let lookupStarted = false;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await withRelay(
      async ({ upstream, relay }) => {
        const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${CDP_PATH}`);
        socket.on('error', () => {});
        assert.ok(await waitUntil(() => lookupStarted), 'the lookup should have started');
        socket.terminate();
        await settle(50);
        release();
        await settle(100);
        assert.deepEqual(upstream.dialed, [], 'no browser may be dialed for a client that already left');
        // Server must still serve, not have died on unhandled error; probed via ws not fetch.
        await assert.rejects(connect(relay.port, '/nope'), (error) => {
          assert.equal(error.statusCode, 404, 'the server must still be up');
          return true;
        });
      },
      {
        browserIdForHandle: async () => {
          lookupStarted = true;
          await gate;
          return { data: UPSTREAM_ID };
        }
      }
    );
  });

  test('answers 503 when the handle lookup itself fails', async () => {
    await withRelay(
      async ({ upstream, relay }) => {
        await assert.rejects(connect(relay.port, CDP_PATH), (error) => {
          assert.equal(error.statusCode, 503);
          return true;
        });
        assert.deepEqual(upstream.dialed, []);
      },
      { browserIdForHandle: async () => ({ error: 'NETWORK' }) }
    );
  });

  test('refuses a handle whose MAC has been tampered with', async () => {
    await withRelay(async ({ upstream, relay }) => {
      const tampered = `${HANDLE.slice(0, -1)}${HANDLE.at(-1) === 'a' ? 'b' : 'a'}`;
      await assert.rejects(connect(relay.port, `/cdp/${tampered}`), (error) => {
        assert.equal(error.statusCode, 400);
        return true;
      });
      assert.deepEqual(upstream.dialed, []);
    });
  });

  test('relays a text message from the client to the browser unchanged', async () => {
    const browser = upstreamSocket();
    await withRelay(
      async ({ connect }) => {
        const client = await connect();
        const socket = await browser.promise;
        const received = nextMessage(socket);
        client.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
        const { data, isBinary } = await received;
        assert.equal(isBinary, false, 'a text frame must stay a text frame');
        assert.equal(data.toString(), '{"id":1,"method":"Page.enable"}');
      },
      { onUpstreamConnection: browser.onUpstreamConnection }
    );
  });

  test('relays a text message from the browser to the client unchanged', async () => {
    const browser = upstreamSocket();
    await withRelay(
      async ({ connect }) => {
        const client = await connect();
        const socket = await browser.promise;
        const received = nextMessage(client);
        socket.send(JSON.stringify({ id: 1, result: {} }));
        const { data, isBinary } = await received;
        assert.equal(isBinary, false);
        assert.equal(data.toString(), '{"id":1,"result":{}}');
      },
      { onUpstreamConnection: browser.onUpstreamConnection }
    );
  });

  // Not valid UTF-8; relay would replace with U+FFFD if forwarded as text.
  test('relays a binary message byte for byte in both directions', async () => {
    const browser = upstreamSocket();
    const payload = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x00, 0x7f, 0xc3, 0x28]);
    await withRelay(
      async ({ connect }) => {
        const client = await connect();
        const socket = await browser.promise;

        const atBrowser = nextMessage(socket);
        client.send(payload, { binary: true });
        const upward = await atBrowser;
        assert.equal(upward.isBinary, true, 'a binary frame must stay binary');
        assert.ok(upward.data.equals(payload), 'bytes must survive client -> browser exactly');

        const atClient = nextMessage(client);
        socket.send(payload, { binary: true });
        const downward = await atClient;
        assert.equal(downward.isBinary, true);
        assert.ok(downward.data.equals(payload), 'bytes must survive browser -> client exactly');
      },
      { onUpstreamConnection: browser.onUpstreamConnection }
    );
  });

  test('relays a message far larger than a single TCP segment', async () => {
    const browser = upstreamSocket();
    const payload = crypto.randomBytes(2 * 1024 * 1024);
    await withRelay(
      async ({ connect }) => {
        const client = await connect();
        const socket = await browser.promise;
        const received = nextMessage(socket);
        client.send(payload, { binary: true });
        const { data } = await received;
        assert.equal(data.length, payload.length);
        assert.ok(data.equals(payload));
      },
      { onUpstreamConnection: browser.onUpstreamConnection }
    );
  });

  // CDP messages (base64 screenshots) are large, but an unbounded frame could OOM the process; 32 MB is the cap.
  test('configures its sockets with a 32 MB payload limit and no compression', () => {
    assert.equal(RELAY_SOCKET_OPTIONS.maxPayload, 32 * 1024 * 1024);
    assert.equal(CDP_MAX_PAYLOAD, 32 * 1024 * 1024);
    assert.equal(RELAY_SOCKET_OPTIONS.perMessageDeflate, false);
  });

  // A frame past the cap must be dropped by ws (close 1009), not buffered; otherwise a client can OOM the process.
  test('closes the client when a frame exceeds the payload limit', async () => {
    await withRelay(async ({ connect }) => {
      const client = await connect();
      const closed = nextClose(client);
      client.send(Buffer.alloc(CDP_MAX_PAYLOAD + 1));
      const { code } = await closed;
      assert.equal(code, 1009);
    });
  });

  // Backpressure: browser stops reading; relay buffer fills; must pause client.
  test('stops reading from the client while the browser is not draining', async () => {
    const browser = upstreamSocket();
    await withRelay(
      async ({ connect }) => {
        const client = await connect();
        const socket = await browser.promise;
        socket.pause();
        for (let index = 0; index < 64; index += 1) {
          client.send(Buffer.alloc(256 * 1024, index), { binary: true });
        }
        // Long enough that 16 MiB would drain into relay if no backpressure.
        await settle(300);
        assert.ok(
          client.bufferedAmount > 0,
          `the relay must stop reading, leaving the client unable to flush; bufferedAmount=${client.bufferedAmount}`
        );
        socket.resume();
        assert.ok(
          await waitUntil(() => client.bufferedAmount === 0),
          'the client must flush once the browser reads again'
        );
      },
      { onUpstreamConnection: browser.onUpstreamConnection }
    );
  });

  // Integrity: nothing dropped or reordered by pause and resume.
  test('delivers a paused-then-resumed burst intact and in order', async () => {
    const COUNT = 24;
    const chunk = 128 * 1024;
    const browser = upstreamSocket();
    await withRelay(
      async ({ connect }) => {
        const client = await connect();
        const socket = await browser.promise;
        socket.pause();
        const seen = [];
        const done = new Promise((resolve) => {
          socket.on('message', (data) => {
            seen.push(data);
            if (seen.length === COUNT) {
              resolve();
            }
          });
        });
        for (let index = 0; index < COUNT; index += 1) {
          client.send(Buffer.alloc(chunk, index), { binary: true });
        }
        socket.resume();
        await done;
        assert.equal(seen.length, COUNT);
        for (let index = 0; index < COUNT; index += 1) {
          assert.ok(seen[index].equals(Buffer.alloc(chunk, index)), `message ${index} must arrive intact and in order`);
        }
      },
      { onUpstreamConnection: browser.onUpstreamConnection }
    );
  });

  test('propagates the close code and reason from the client to the browser', async () => {
    const browser = upstreamSocket();
    await withRelay(
      async ({ connect }) => {
        const client = await connect();
        const socket = await browser.promise;
        const closed = nextClose(socket);
        client.close(4321, 'client done');
        const { code, reason } = await closed;
        assert.equal(code, 4321);
        assert.equal(reason.toString(), 'client done');
      },
      { onUpstreamConnection: browser.onUpstreamConnection }
    );
  });

  test('propagates the close code and reason from the browser to the client', async () => {
    const browser = upstreamSocket();
    await withRelay(
      async ({ connect }) => {
        const client = await connect();
        const socket = await browser.promise;
        const closed = nextClose(client);
        socket.close(4009, 'browser gone');
        const { code, reason } = await closed;
        assert.equal(code, 4009);
        assert.equal(reason.toString(), 'browser gone');
      },
      { onUpstreamConnection: browser.onUpstreamConnection }
    );
  });

  // 1006 not sendable on wire; abrupt drop must become a close peer can receive.
  test('closes the client when the browser drops the connection abruptly', async () => {
    const browser = upstreamSocket();
    await withRelay(
      async ({ connect }) => {
        const client = await connect();
        const socket = await browser.promise;
        const closed = nextClose(client);
        socket.terminate();
        const { code } = await closed;
        assert.ok(code >= 1000, `expected a real close code, got ${code}`);
      },
      { onUpstreamConnection: browser.onUpstreamConnection }
    );
  });

  test('answers 502 without upgrading when the browser cannot be reached', async () => {
    // Bound to a port nothing is listening on, so the dial is refused.
    const relay = await startRelay({ cdpUrlFor: () => 'ws://127.0.0.1:1/api/v1/browsers/foobar/cdp' });
    try {
      await assert.rejects(connect(relay.port, CDP_PATH), (error) => {
        assert.equal(error.statusCode, 502, 'the client must see a status line, not a mystery close code');
        return true;
      });
    } finally {
      await relay.close();
    }
  });

  test('answers 400 for a handle that is malformed', async () => {
    await withRelay(async ({ upstream, relay }) => {
      for (const handle of ['..%2f..%2fetc', 'foo%20bar', 'x'.repeat(400), 'foo%3Fx%3D1', HANDLE.toUpperCase()]) {
        await assert.rejects(
          connect(relay.port, `/cdp/${handle}`),
          (error) => {
            assert.equal(error.statusCode, 400, `for ${handle}`);
            return true;
          },
          `for ${handle}`
        );
      }
      assert.deepEqual(upstream.dialed, [], 'a malformed handle must never reach the upstream');
    });
  });

  test('answers 503 when no upstream URL can be built', async () => {
    const relay = await startRelay({ cdpUrlFor: () => null });
    try {
      await assert.rejects(connect(relay.port, CDP_PATH), (error) => {
        assert.equal(error.statusCode, 503);
        return true;
      });
    } finally {
      await relay.close();
    }
  });

  // Low-cardinality body with identifier as attribute; handle (a credential) never logged.
  test('logs the resolved browser id as an attribute, and never the handle', async () => {
    const browser = upstreamSocket();
    const calls = [];
    const original = consola.log;
    consola.log = (...args) => calls.push(args);
    try {
      await withRelay(
        async ({ connect }) => {
          const client = await connect(CDP_PATH);
          await browser.promise;
          client.close(1000, 'done');
          assert.ok(await waitUntil(() => calls.length >= 2), `expected an open and a close line, got ${calls.length}`);
        },
        { onUpstreamConnection: browser.onUpstreamConnection }
      );
    } finally {
      consola.log = original;
    }
    const [opened, closed] = calls;
    assert.equal(opened[0], 'CDP relay opened');
    assert.equal(opened[1]['rb.browser_id'], UPSTREAM_ID);
    assert.equal(opened[1]['event.domain'], 'cdp');
    assert.equal(closed[0], 'CDP relay closed');
    assert.equal(closed[1]['ws.close_code'], 1000);
    assert.equal(closed[1]['ws.close_initiator'], 'client');
    for (const [message, attributes] of calls) {
      assert.ok(!message.includes(UPSTREAM_ID), `the id must not be in the message body: ${message}`);
      const serialized = `${message} ${JSON.stringify(attributes)}`;
      assert.ok(!serialized.includes(HANDLE), `the handle is a credential and must never be logged: ${serialized}`);
    }
  });

  // Exception in 'upgrade' listener is uncatchable; guard prevents one bad upgrade killing the server.
  test('answers 500 and keeps serving when resolving the upstream throws', async () => {
    const relay = await startRelay({
      cdpUrlFor: () => {
        throw new Error('resolver exploded');
      }
    });
    try {
      await assert.rejects(connect(relay.port, CDP_PATH), (error) => {
        assert.equal(error.statusCode, 500);
        return true;
      });
      // Still listening, rather than having taken the process with it.
      const res = await fetch(`http://127.0.0.1:${relay.port}/anything`);
      assert.equal(res.status, 426);
    } finally {
      await relay.close();
    }
  });

  test('answers 404 for a path that is not the CDP endpoint', async () => {
    await withRelay(async ({ relay }) => {
      await assert.rejects(connect(relay.port, `/browsers/${HANDLE}`), (error) => {
        assert.equal(error.statusCode, 404);
        return true;
      });
    });
  });
});

// CDP scriptable stub: responders[method] called per matching message; unscripted returns error.
const CDP_ERROR = Symbol('cdpError');
const cdpError = (message) => ({ [CDP_ERROR]: message });

const startCdpStub = (responders) =>
  new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, perMessageDeflate: false, maxPayload: 0 });
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const { id, method, params, sessionId } = JSON.parse(raw.toString());
        const responder = responders[method];
        if (!responder) {
          socket.send(JSON.stringify({ id, error: { message: `unscripted method ${method}` } }));
          return;
        }
        const outcome = responder(params);
        if (outcome && typeof outcome === 'object' && CDP_ERROR in outcome) {
          socket.send(JSON.stringify({ id, error: { message: outcome[CDP_ERROR] } }));
          return;
        }
        socket.send(JSON.stringify({ id, sessionId, result: outcome }));
      });
    });
    wss.once('listening', () =>
      resolve({
        port: wss.address().port,
        wss,
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close(done);
          })
      })
    );
  });

const cdpUrlForPort = (port) => () => `ws://127.0.0.1:${port}/api/v1/browsers/anything/cdp`;

describe('listBrowserPages', () => {
  test('returns the full target info of every page target, in the order Target.getTargets reports them', async () => {
    const stub = await startCdpStub({
      'Target.getTargets': () => ({
        targetInfos: [
          { targetId: 'page1', type: 'page', title: 'Example', url: 'https://example.com/', attached: true },
          { targetId: 'worker1', type: 'service_worker', title: '', url: 'https://example.com/sw.js' },
          { targetId: 'page2', type: 'page', title: 'NPR Text', url: 'https://text.npr.org/', attached: false }
        ]
      })
    });
    try {
      const result = await listBrowserPages({ browserId: 'anything', cdpUrlFor: cdpUrlForPort(stub.port) });
      assert.deepEqual(result, {
        data: [
          { targetId: 'page1', type: 'page', title: 'Example', url: 'https://example.com/', attached: true },
          { targetId: 'page2', type: 'page', title: 'NPR Text', url: 'https://text.npr.org/', attached: false }
        ]
      });
    } finally {
      await stub.close();
    }
  });

  test('returns an empty array when the browser has no page target', async () => {
    const stub = await startCdpStub({
      'Target.getTargets': () => ({ targetInfos: [{ targetId: 'worker1', type: 'service_worker' }] })
    });
    try {
      const result = await listBrowserPages({ browserId: 'anything', cdpUrlFor: cdpUrlForPort(stub.port) });
      assert.deepEqual(result, { data: [] });
    } finally {
      await stub.close();
    }
  });

  test('reports a CDP command error rather than the raw protocol response', async () => {
    const stub = await startCdpStub({ 'Target.getTargets': () => cdpError('Inspected target navigated or closed') });
    try {
      const result = await listBrowserPages({ browserId: 'anything', cdpUrlFor: cdpUrlForPort(stub.port) });
      assert.equal(result.error, 'Inspected target navigated or closed');
    } finally {
      await stub.close();
    }
  });

  test('reports an error when nothing is listening at the resolved URL', async () => {
    const stub = await startCdpStub({});
    const port = stub.port;
    await stub.close();
    const result = await listBrowserPages({ browserId: 'anything', cdpUrlFor: cdpUrlForPort(port) });
    assert.ok(result.error, 'expected a connection failure to be reported as an error');
  });

  test('reports an error rather than dialing when the origin is unconfigured', async () => {
    const result = await listBrowserPages({ browserId: 'anything', cdpUrlFor: () => null });
    assert.equal(result.error, 'CDP_URL_UNAVAILABLE');
  });
});

describe('capturePageScreenshot', () => {
  const PNG_BYTES = Buffer.from('not a real png, just something to round-trip', 'utf8');

  test('attaches to the target matching pageId and returns its screenshot as a Buffer', async () => {
    const attachedTo = [];
    const stub = await startCdpStub({
      'Target.getTargets': () => ({
        targetInfos: [
          { targetId: 'page1', type: 'page' },
          { targetId: 'page2', type: 'page' }
        ]
      }),
      'Target.attachToTarget': (params) => {
        attachedTo.push(params.targetId);
        return { sessionId: 'session1' };
      },
      'Page.captureScreenshot': () => ({ data: PNG_BYTES.toString('base64') })
    });
    try {
      const result = await capturePageScreenshot({
        browserId: 'anything',
        pageId: 'page2',
        cdpUrlFor: cdpUrlForPort(stub.port)
      });
      assert.equal(result.error, undefined);
      assert.deepEqual(result.data, PNG_BYTES);
      assert.deepEqual(attachedTo, ['page2']);
    } finally {
      await stub.close();
    }
  });

  test('reports an error when no page target matches pageId', async () => {
    const stub = await startCdpStub({
      'Target.getTargets': () => ({ targetInfos: [{ targetId: 'page1', type: 'page' }] })
    });
    try {
      const result = await capturePageScreenshot({
        browserId: 'anything',
        pageId: 'page-does-not-exist',
        cdpUrlFor: cdpUrlForPort(stub.port)
      });
      assert.equal(result.error, 'NO_SUCH_PAGE');
    } finally {
      await stub.close();
    }
  });

  test('does not match a non-page target that happens to share the id', async () => {
    const stub = await startCdpStub({
      'Target.getTargets': () => ({ targetInfos: [{ targetId: 'worker1', type: 'service_worker' }] })
    });
    try {
      const result = await capturePageScreenshot({
        browserId: 'anything',
        pageId: 'worker1',
        cdpUrlFor: cdpUrlForPort(stub.port)
      });
      assert.equal(result.error, 'NO_SUCH_PAGE');
    } finally {
      await stub.close();
    }
  });

  test('reports a CDP command error rather than the raw protocol response', async () => {
    const stub = await startCdpStub({
      'Target.getTargets': () => ({ targetInfos: [{ targetId: 'page1', type: 'page' }] }),
      'Target.attachToTarget': () => cdpError('No target with given id found')
    });
    try {
      const result = await capturePageScreenshot({
        browserId: 'anything',
        pageId: 'page1',
        cdpUrlFor: cdpUrlForPort(stub.port)
      });
      assert.equal(result.error, 'No target with given id found');
    } finally {
      await stub.close();
    }
  });

  test('reports an error rather than dialing when the origin is unconfigured', async () => {
    const result = await capturePageScreenshot({ browserId: 'anything', pageId: 'page1', cdpUrlFor: () => null });
    assert.equal(result.error, 'CDP_URL_UNAVAILABLE');
  });
});

describe('navigateBrowserToUrl', () => {
  test('attaches to the one page target and navigates it to the given url', async () => {
    const attachedTo = [];
    const navigated = [];
    const stub = await startCdpStub({
      'Target.getTargets': () => ({
        targetInfos: [
          { targetId: 'worker1', type: 'service_worker' },
          { targetId: 'page1', type: 'page' }
        ]
      }),
      'Target.attachToTarget': (params) => {
        attachedTo.push(params.targetId);
        return { sessionId: 'session1' };
      },
      'Page.navigate': (params) => {
        navigated.push(params.url);
        return {};
      }
    });
    try {
      const result = await navigateBrowserToUrl({
        browserId: 'anything',
        url: 'https://google.com',
        cdpUrlFor: cdpUrlForPort(stub.port)
      });
      assert.deepEqual(result, { data: true });
      assert.deepEqual(attachedTo, ['page1']);
      assert.deepEqual(navigated, ['https://google.com']);
    } finally {
      await stub.close();
    }
  });

  test('picks the first page target when the browser has more than one', async () => {
    const attachedTo = [];
    const stub = await startCdpStub({
      'Target.getTargets': () => ({
        targetInfos: [
          { targetId: 'page1', type: 'page' },
          { targetId: 'page2', type: 'page' }
        ]
      }),
      'Target.attachToTarget': (params) => {
        attachedTo.push(params.targetId);
        return { sessionId: 'session1' };
      },
      'Page.navigate': () => ({})
    });
    try {
      await navigateBrowserToUrl({
        browserId: 'anything',
        url: 'https://google.com',
        cdpUrlFor: cdpUrlForPort(stub.port)
      });
      assert.deepEqual(attachedTo, ['page1']);
    } finally {
      await stub.close();
    }
  });

  test('reports an error when the browser has no page target', async () => {
    const stub = await startCdpStub({
      'Target.getTargets': () => ({ targetInfos: [{ targetId: 'worker1', type: 'service_worker' }] })
    });
    try {
      const result = await navigateBrowserToUrl({
        browserId: 'anything',
        url: 'https://google.com',
        cdpUrlFor: cdpUrlForPort(stub.port)
      });
      assert.equal(result.error, 'NO_PAGE_TARGET');
    } finally {
      await stub.close();
    }
  });

  test('reports a CDP command error rather than the raw protocol response', async () => {
    const stub = await startCdpStub({
      'Target.getTargets': () => ({ targetInfos: [{ targetId: 'page1', type: 'page' }] }),
      'Target.attachToTarget': () => cdpError('No target with given id found')
    });
    try {
      const result = await navigateBrowserToUrl({
        browserId: 'anything',
        url: 'https://google.com',
        cdpUrlFor: cdpUrlForPort(stub.port)
      });
      assert.equal(result.error, 'No target with given id found');
    } finally {
      await stub.close();
    }
  });

  test('reports an error when nothing is listening at the resolved URL', async () => {
    const stub = await startCdpStub({});
    const port = stub.port;
    await stub.close();
    const result = await navigateBrowserToUrl({
      browserId: 'anything',
      url: 'https://google.com',
      cdpUrlFor: cdpUrlForPort(port)
    });
    assert.ok(result.error, 'expected a connection failure to be reported as an error');
  });

  test('reports an error rather than dialing when the origin is unconfigured', async () => {
    const result = await navigateBrowserToUrl({
      browserId: 'anything',
      url: 'https://google.com',
      cdpUrlFor: () => null
    });
    assert.equal(result.error, 'CDP_URL_UNAVAILABLE');
  });
});

describe('checkCdpConnection', () => {
  test('reports true once the CDP websocket handshake succeeds', async () => {
    const stub = await startCdpStub({});
    try {
      const result = await checkCdpConnection({ browserId: 'anything', cdpUrlFor: cdpUrlForPort(stub.port) });
      assert.deepEqual(result, { data: true });
    } finally {
      await stub.close();
    }
  });

  // No command sent; liveness probe only; caller must close socket.
  test('closes the socket once the handshake has answered the question', async () => {
    const stub = await startCdpStub({});
    try {
      await checkCdpConnection({ browserId: 'anything', cdpUrlFor: cdpUrlForPort(stub.port) });
      assert.ok(await waitUntil(() => stub.wss.clients.size === 0), 'the probe socket should not be left open');
    } finally {
      await stub.close();
    }
  });

  test('reports false when nothing is listening at the resolved URL', async () => {
    const stub = await startCdpStub({});
    const port = stub.port;
    await stub.close();
    const result = await checkCdpConnection({ browserId: 'anything', cdpUrlFor: cdpUrlForPort(port) });
    assert.deepEqual(result, { data: false });
  });

  // Starting/unconfigured = no browser to dial; not worth distinct error.
  test('reports false without dialing when the origin is unconfigured', async () => {
    const result = await checkCdpConnection({ browserId: 'anything', cdpUrlFor: () => null });
    assert.deepEqual(result, { data: false });
  });
});
