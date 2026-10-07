import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

const { createScreenshotPool } = await import('./screenshot.js');

const { consola } = await import('consola/basic');
consola.level = -999;

const PAGE_IDS = ['p1', 'p2', 'p3'];

const startCdpStub = () =>
  new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, perMessageDeflate: false, maxPayload: 0 });
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const { id, method, params, sessionId } = message;
        if (method === 'Target.getTargets') {
          socket.send(
            JSON.stringify({
              id,
              result: { targetInfos: PAGE_IDS.map((targetId) => ({ targetId, type: 'page' })) }
            })
          );
        } else if (method === 'Target.attachToTarget') {
          socket.send(JSON.stringify({ id, result: { sessionId: `session:${params.targetId}` } }));
        } else if (method === 'Page.captureScreenshot') {
          const targetId = String(sessionId).slice('session:'.length);
          socket.send(JSON.stringify({ id, sessionId, result: { data: Buffer.from(targetId).toString('base64') } }));
        } else {
          socket.send(JSON.stringify({ id, error: { message: `unscripted method ${method}` } }));
        }
      });
    });
    wss.once('listening', () =>
      resolve({
        port: wss.address().port,
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

const cdpUrlFor = (port, browserId = 'br-1') => `ws://127.0.0.1:${port}/api/v1/browsers/${browserId}/cdp`;

test('captures every queued task on the URL it was given, spreading work across the pool', async () => {
  const stub = await startCdpStub();
  const pool = createScreenshotPool();
  try {
    const url = cdpUrlFor(stub.port);
    const pageIds = ['p1', 'p2', 'p3', 'p1', 'p2'];
    const results = await Promise.all(pageIds.map((pageId) => pool.capture({ browserId: 'br-1', pageId, url })));
    assert.deepEqual(
      results.map((result) => result.data?.toString()),
      pageIds,
      'every reply must carry the frame of the page its own task asked for'
    );
    assert.ok(results.every((result) => result.error === undefined));
  } finally {
    await pool.close();
    await stub.close();
  }
});

test('reports an error for a page the browser does not have open', async () => {
  const stub = await startCdpStub();
  const pool = createScreenshotPool();
  try {
    const result = await pool.capture({ browserId: 'br-1', pageId: 'missing', url: cdpUrlFor(stub.port) });
    assert.equal(result.error, 'NO_SUCH_PAGE');
  } finally {
    await pool.close();
    await stub.close();
  }
});

test('reports a connection error rather than hanging when nothing is listening', async () => {
  const stub = await startCdpStub();
  const port = stub.port;
  await stub.close();
  const pool = createScreenshotPool();
  try {
    const result = await pool.capture({ browserId: 'br-1', pageId: 'p1', url: cdpUrlFor(port) });
    assert.ok(result.error, 'a dead CDP endpoint must surface as an error');
  } finally {
    await pool.close();
  }
});

test('refuses new tasks once closed', async () => {
  const pool = createScreenshotPool();
  await pool.close();
  const result = await pool.capture({ browserId: 'br-1', pageId: 'p1', url: 'ws://127.0.0.1:1/cdp' });
  assert.equal(result.error, 'POOL_CLOSED');
});
