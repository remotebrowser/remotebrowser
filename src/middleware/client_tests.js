import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';

const { describe } = test;

const exporter = new InMemorySpanExporter();
new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();

// Import client only after registration. logging.js registers its own OTLP
// provider at import time, and the first global registration wins, so importing
// it statically would leave these spans pointed at the ambient exporter.
const { client } = await import('./client.js');

const setupApp = () => {
  const app = new Hono();
  // Hono's default onError logs the error to stderr; silence it for the throwing-handler case.
  app.onError((err, c) => c.text('Internal Server Error', 500));
  app.use('*', client);
  app.get('/whoami', (c) => c.json({ ip: c.get('ipAddress') }));
  app.get('/health', (c) => c.text('OK'));
  app.get('/team/:teamId/members', (c) => c.text('roster'));
  app.get('/account/:browserId{B[23456789abc]{5}}', (c) => c.text('browser'));
  app.get('/missing', (c) => c.text('nope', 404));
  app.get('/broken', (c) => c.text('boom', 500));
  app.get('/throws', () => {
    throw new Error('handler exploded');
  });
  return app;
};

// Spy on every log level, tagged with its type.
const captureConsola = () => {
  const calls = [];
  const originals = {};
  for (const type of ['log', 'warn', 'error']) {
    originals[type] = consola[type];
    consola[type] = (...args) => {
      calls.push({ type, args, activeSpanId: trace.getActiveSpan()?.spanContext().spanId });
    };
  }
  return {
    calls,
    restore: () => {
      for (const [type, fn] of Object.entries(originals)) {
        consola[type] = fn;
      }
    }
  };
};

// Each case wants a clean slate; the exporter accumulates across requests.
const request = async (path, options) => {
  exporter.reset();
  const capture = captureConsola();
  try {
    const res = await setupApp().request(path, options);
    return { res, calls: capture.calls, spans: exporter.getFinishedSpans() };
  } finally {
    capture.restore();
  }
};

describe('client address', () => {
  test('ignores a spoofed X-Forwarded-For header', async () => {
    const { res } = await request('/whoami', { headers: { 'X-Forwarded-For': '6.6.6.6' } });
    assert.deepEqual(await res.json(), { ip: null });
  });

  test('uses the socket peer', async () => {
    const env = { incoming: { socket: { remoteAddress: '::ffff:203.0.113.7' } } };
    const res = await setupApp().request('/whoami', { headers: { 'X-Forwarded-For': '6.6.6.6' } }, env);
    assert.deepEqual(await res.json(), { ip: '203.0.113.7' });
  });

  test('is null when no real socket connection is available', async () => {
    const { res } = await request('/whoami');
    assert.deepEqual(await res.json(), { ip: null });
  });
});

describe('access log', () => {
  test('logs the parameterised route rather than the concrete path', async () => {
    const { calls } = await request('/team/abc123/members');
    assert.equal(calls.length, 1);
    const [message] = calls[0].args;
    assert.equal(message, 'GET /team/:teamId/members 200');
    assert.doesNotMatch(message, /abc123/);
  });

  test('reports the user agent as an attribute, not in the message', async () => {
    const { calls } = await request('/whoami', { headers: { 'User-Agent': 'curl/8.5.0' } });
    const [message, attributes] = calls[0].args;
    assert.doesNotMatch(message, /curl\/8\.5\.0/);
    assert.deepEqual(attributes, {
      'http.response.status_code': 200,
      'user_agent.original': 'curl/8.5.0'
    });
  });

  test('omits the client address and user agent when they are unavailable', async () => {
    const { calls } = await request('/whoami');
    const [, attributes] = calls[0].args;
    assert.deepEqual(attributes, { 'http.response.status_code': 200 });
  });

  test('emits at INFO for a success', async () => {
    const { calls } = await request('/whoami');
    assert.equal(calls[0].type, 'log');
  });

  test('emits at WARN for a client error', async () => {
    const { calls } = await request('/missing');
    assert.equal(calls[0].type, 'warn');
    assert.equal(calls[0].args[0], 'GET /missing 404');
  });

  test('emits at ERROR for a server error', async () => {
    const { calls } = await request('/broken');
    assert.equal(calls[0].type, 'error');
    assert.equal(calls[0].args[0], 'GET /broken 500');
  });

  // Collapse unmatched requests to a wildcard so bots probing URLs can't bloat the logs.
  test('collapses an unmatched request to a wildcard instead of echoing the path', async () => {
    const { calls } = await request('/nope/deadbeef');
    const [message] = calls[0].args;
    assert.equal(message, 'GET /* 404');
    assert.doesNotMatch(message, /deadbeef/);
  });

  // This is the mechanism behind log/span correlation: the OTel logs SDK
  // stamps trace and span ids onto records emitted while a span is active.
  test('runs inside the request span so the record inherits its trace context', async () => {
    const { calls, spans } = await request('/whoami');
    assert.equal(spans.length, 1);
    assert.equal(calls[0].activeSpanId, spans[0].spanContext().spanId);
  });
});

describe('request span', () => {
  test('is a SERVER span named after the method and route', async () => {
    const { spans } = await request('/team/abc123/members');
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, 'GET /team/:teamId/members');
    assert.equal(spans[0].kind, SpanKind.SERVER);
  });

  // A regex-constrained parameter would otherwise put the whole character
  // class into the span name, which is unreadable in a waterfall.
  test('names the span after the bare parameter when the route constrains it with a regex', async () => {
    const { spans, calls } = await request('/account/Babc23');
    assert.equal(spans[0].name, 'GET /account/:browserId');
    assert.equal(spans[0].attributes['http.route'], '/account/:browserId');
    assert.equal(spans[0].attributes['url.path'], '/account/Babc23');
    assert.equal(calls[0].args[0], 'GET /account/:browserId 200');
  });

  test('carries the concrete path in url.path and the pattern in http.route', async () => {
    const { spans } = await request('/team/abc123/members', { headers: { 'User-Agent': 'curl/8.5.0' } });
    const { attributes } = spans[0];
    assert.equal(attributes['url.path'], '/team/abc123/members');
    assert.equal(attributes['http.route'], '/team/:teamId/members');
    assert.equal(attributes['http.request.method'], 'GET');
    assert.equal(attributes['http.response.status_code'], 200);
    assert.equal(attributes['user_agent.original'], 'curl/8.5.0');
  });

  test('records a duration, which is what Logfire charts latency from', async () => {
    const { spans } = await request('/whoami');
    const [seconds, nanos] = spans[0].duration;
    assert.ok(seconds + nanos / 1e9 > 0, 'expected a positive span duration');
  });

  test('omits http.route when nothing matched and names the span after the method alone', async () => {
    const { spans } = await request('/nope/deadbeef');
    assert.equal(spans[0].name, 'GET');
    assert.equal('http.route' in spans[0].attributes, false);
    assert.equal(spans[0].attributes['url.path'], '/nope/deadbeef');
  });

  // Semconv reserves ERROR for 5xx on a server span: marking 4xx would make
  // every stale bookmark look like an outage.
  test('leaves the status unset for a client error', async () => {
    const { spans } = await request('/missing');
    assert.equal(spans[0].status.code, SpanStatusCode.UNSET);
  });

  test('sets an ERROR status for a server error', async () => {
    const { spans } = await request('/broken');
    assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
  });

  // Hono converts a throwing handler into a 500 response before the middleware
  // sees it, so next() resolves rather than throwing - the span is errored by
  // the status code, not by recordException.
  test('errors the span when a handler throws, via the 500 Hono turns it into', async () => {
    const { res, spans, calls } = await request('/throws');
    assert.equal(res.status, 500);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].status.code, SpanStatusCode.ERROR);
    assert.equal(spans[0].attributes['http.response.status_code'], 500);
    assert.equal(calls[0].type, 'error');
  });

  test('redacts query values so a sign-in nonce never reaches the exporter', async () => {
    const { spans } = await request('/whoami?nonce=SECRET123');
    assert.equal(spans[0].attributes['url.query'], 'nonce=REDACTED');
    assert.doesNotMatch(JSON.stringify(spans[0].attributes), /SECRET123/);
  });
});

describe('/health', () => {
  test('still sets ipAddress for downstream handlers', async () => {
    const app = new Hono();
    app.use('*', client);
    app.get('/health', (c) => c.json({ hasIpAddress: c.var.ipAddress !== undefined }));
    const res = await app.request('/health');
    assert.deepEqual(await res.json(), { hasIpAddress: true });
  });

  test('creates no server span', async () => {
    const { res, spans } = await request('/health');
    assert.equal(res.status, 200);
    assert.equal(spans.length, 0);
  });

  test('writes no access log line', async () => {
    const { calls } = await request('/health');
    assert.equal(calls.length, 0);
  });
});
