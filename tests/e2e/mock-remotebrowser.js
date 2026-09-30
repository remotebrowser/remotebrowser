// Stands in for the browserfleet server (https://github.com/remotebrowser/remotebrowser)
// during the e2e run, so browsers.spec.js can watch a real request leave the app
// and the assigned id come back. Started by playwright.config.js alongside the
// app itself.
//
// MOCK_BROWSERFLEET_DELAY_MS holds the response back on purpose: the create
// route must answer before provisioning finishes (startBrowser in
// src/routes/browsers/launch.js is deliberately never awaited), and a mock that
// answers instantly could not tell the two apart.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8991;
const DELAY_MS = Number(process.env.MOCK_BROWSERFLEET_DELAY_MS) || 0;

let assigned = 0;

const respondJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// CDP URL pattern: /api/v1/browsers/:browserId/cdp
const CDP_PATH_PATTERN = /^\/api\/v1\/browsers\/([^/]+)\/cdp$/;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    respondJson(res, 200, { status: 'ok' });
    return;
  }
  // The real server has no collection-level route at /api/v1/browsers/ - that
  // path lands on its /api/v1/browsers/{browser_id} handler and comes back 405.
  // Mirrored here so a trailing slash creeping back into src/fleet.js
  // fails the e2e run instead of being quietly absorbed by a lenient mock.
  if (req.method === 'POST' && req.url === '/api/v1/browsers/') {
    respondJson(res, 405, { detail: 'Method Not Allowed' });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/v1/browsers') {
    assigned += 1;
    // ws_url is here to be ignored: the app reads browser_id and nothing else.
    const body = { browser_id: `mock-${assigned}`, ws_url: `ws://127.0.0.1:${PORT}/devtools/${assigned}` };
    console.log(`assigned ${body.browser_id}`);
    setTimeout(() => respondJson(res, 201, body), DELAY_MS);
    return;
  }
  respondJson(res, 404, { detail: 'not found' });
});

// A CDP endpoint that reports no page targets, so the app's client dials
// answer immediately: listBrowserPages/navigateBrowserToUrl get an empty
// target list back (no page to list or navigate), and checkCdpConnection just
// needs the handshake to open. Without the empty reply, every one of those
// calls sits on Target.getTargets until the 10s CDP_TIMEOUT, which
// is longer than the show page's 3s poll waits to reveal the connection info.
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.method === 'Target.getTargets') {
      socket.send(JSON.stringify({ id: message.id, result: { targetInfos: [] } }));
    }
  });
});

// Handle CDP WebSocket upgrades so checkCdpConnection succeeds.
server.on('upgrade', (req, socket, head) => {
  const [pathname] = String(req.url).split(/[?#]/, 1);
  if (!CDP_PATH_PATTERN.test(pathname)) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    wss.emit('connection', client, req);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock remotebrowser listening on 127.0.0.1:${PORT}`));
