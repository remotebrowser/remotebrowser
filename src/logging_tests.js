import test from 'node:test';
import assert from 'node:assert/strict';

const { describe } = test;

import { buildLogRecord, resolveSeverity, resolveExporterOptions, resolveHeaders, resource } from './logging.js';

test('buildLogRecord joins the message with string args and tags with the consola tag', () => {
  const { message, attributes } = buildLogRecord({ message: 'hello', args: ['world'], tag: 'app' });
  assert.equal(message, 'hello world');
  assert.deepEqual(attributes, { 'log.tag': 'app' });
});

test('buildLogRecord moves plain object args into attributes instead of the message', () => {
  const { message, attributes } = buildLogRecord({
    message: 'GET /whoami 200 3ms',
    args: [{ 'client.address': '203.0.113.7' }],
    tag: 'consola'
  });
  assert.equal(message, 'GET /whoami 200 3ms');
  assert.deepEqual(attributes, { 'log.tag': 'consola', 'client.address': '203.0.113.7' });
});

test('buildLogRecord folds an Error arg message into the message text, not attributes', () => {
  const { message, attributes } = buildLogRecord({
    message: 'fetch failed',
    args: [new Error('boom')],
    tag: 'consola'
  });
  assert.equal(message, 'fetch failed boom');
  assert.deepEqual(attributes, { 'log.tag': 'consola' });
});

test('buildLogRecord defaults the tag to "consola" when none is set', () => {
  const { attributes } = buildLogRecord({ message: 'x', args: [] });
  assert.deepEqual(attributes, { 'log.tag': 'consola' });
});

test('resolveSeverity maps every consola type to its OTel severity', () => {
  const expected = {
    fatal: ['FATAL', 0],
    error: ['ERROR', 0],
    fail: ['ERROR', 3],
    warn: ['WARN', 1],
    log: ['INFO', 2],
    info: ['INFO', 3],
    success: ['INFO', 3],
    ready: ['INFO', 3],
    start: ['INFO', 3],
    box: ['INFO', 3],
    debug: ['DEBUG', 4],
    trace: ['TRACE', 5]
  };
  for (const [type, [text, level]] of Object.entries(expected)) {
    assert.equal(resolveSeverity({ type, level }).text, text, `type ${type}`);
  }
});

test('resolveSeverity keeps consola.log at INFO rather than WARN', () => {
  const { number, text } = resolveSeverity({ type: 'log', level: 2 });
  assert.equal(text, 'INFO');
  assert.equal(number, 9);
});

test('resolveSeverity distinguishes error from fatal despite the shared level', () => {
  assert.equal(resolveSeverity({ type: 'error', level: 0 }).text, 'ERROR');
  assert.equal(resolveSeverity({ type: 'fatal', level: 0 }).text, 'FATAL');
});

test('resolveSeverity falls back to the level for an unknown type', () => {
  assert.equal(resolveSeverity({ type: 'nope', level: 0 }).text, 'ERROR');
  assert.equal(resolveSeverity({ type: 'nope', level: 1 }).text, 'WARN');
  assert.equal(resolveSeverity({ type: 'nope', level: 4 }).text, 'DEBUG');
  assert.equal(resolveSeverity({ type: undefined, level: undefined }).text, 'INFO');
});
// Env read per call (not at import) so tests can set it in-process.
const withEnv = (env, fn) => {
  const saved = {};
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

const CLEARED = {
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
  OTEL_EXPORTER_OTLP_HEADERS: undefined,
  OTEL_SERVICE_NAME: undefined
};

describe('OTEL_EXPORTER_OTLP_ENDPOINT', () => {
  test('appends the signal path to a bare base URL', () => {
    withEnv({ ...CLEARED, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }, () => {
      assert.deepEqual(resolveExporterOptions('logs'), { url: 'http://collector:4318/v1/logs' });
      assert.deepEqual(resolveExporterOptions('traces'), { url: 'http://collector:4318/v1/traces' });
    });
  });

  test('strips a trailing slash before appending the signal path', () => {
    withEnv({ ...CLEARED, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/' }, () => {
      assert.deepEqual(resolveExporterOptions('traces'), { url: 'http://collector:4318/v1/traces' });
    });
  });

  // Snippets in the wild often bake a signal path into the endpoint; keeping it
  // would concatenate into .../v1/traces/v1/logs and 404.
  test('strips a signal path that was already baked into the endpoint', () => {
    withEnv({ ...CLEARED, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/v1/traces' }, () => {
      assert.deepEqual(resolveExporterOptions('logs'), { url: 'http://collector:4318/v1/logs' });
      assert.deepEqual(resolveExporterOptions('traces'), { url: 'http://collector:4318/v1/traces' });
    });
  });
});

describe('OTEL_EXPORTER_OTLP_HEADERS', () => {
  test('passes a bearer token header through to the exporter options', () => {
    withEnv(
      {
        ...CLEARED,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://logfire-api.pydantic.dev',
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer pylf_secret_token'
      },
      () => {
        assert.deepEqual(resolveExporterOptions('logs'), {
          url: 'https://logfire-api.pydantic.dev/v1/logs',
          headers: { Authorization: 'Bearer pylf_secret_token' }
        });
      }
    );
  });

  test('parses a comma-separated list of headers', () => {
    withEnv(
      {
        ...CLEARED,
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer token, X-Custom=value'
      },
      () => {
        assert.deepEqual(resolveHeaders(), { 'Authorization': 'Bearer token', 'X-Custom': 'value' });
      }
    );
  });

  // The spec percent-encodes header values (W3C Baggage), so e.g. an equals
  // sign in a token arrives as %3D.
  test('percent-decodes header values', () => {
    withEnv({ ...CLEARED, OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20tok%3Den' }, () => {
      assert.deepEqual(resolveHeaders(), { Authorization: 'Bearer tok=en' });
    });
  });

  test('skips malformed pairs instead of failing the whole list', () => {
    withEnv({ ...CLEARED, OTEL_EXPORTER_OTLP_HEADERS: 'junk,=no-name,empty=,Authorization=Bearer ok' }, () => {
      assert.deepEqual(resolveHeaders(), { Authorization: 'Bearer ok' });
    });
  });

  test('omits the headers option when the variable is unset or has no valid pair', () => {
    withEnv({ ...CLEARED, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }, () => {
      assert.deepEqual(resolveExporterOptions('traces'), { url: 'http://collector:4318/v1/traces' });
    });
    withEnv(
      { ...CLEARED, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_EXPORTER_OTLP_HEADERS: 'junk' },
      () => {
        assert.equal(resolveHeaders(), null);
        assert.deepEqual(resolveExporterOptions('traces'), { url: 'http://collector:4318/v1/traces' });
      }
    );
  });
});

test('resolveExporterOptions returns null when OTEL_EXPORTER_OTLP_ENDPOINT is unset', () => {
  withEnv(CLEARED, () => {
    assert.equal(resolveExporterOptions('logs'), null);
    assert.equal(resolveExporterOptions('traces'), null);
  });
});

describe('resource', () => {
  test('carries the OTEL_SERVICE_NAME and resolves the environment from ENV', () => {
    withEnv({ ...CLEARED, OTEL_SERVICE_NAME: 'remotebrowser', ENV: 'staging', NODE_ENV: undefined }, () => {
      const { attributes } = resource();
      assert.equal(attributes['service.name'], 'remotebrowser');
      assert.equal(attributes['deployment.environment.name'], 'staging');
    });
  });

  test('defaults the service name to remotebrowser when OTEL_SERVICE_NAME is unset', () => {
    withEnv({ ...CLEARED, ENV: undefined, NODE_ENV: undefined }, () => {
      assert.equal(resource().attributes['service.name'], 'remotebrowser');
    });
  });

  test('falls back to NODE_ENV, then to development', () => {
    withEnv({ ...CLEARED, ENV: undefined, NODE_ENV: 'production' }, () => {
      assert.equal(resource().attributes['deployment.environment.name'], 'production');
    });
    withEnv({ ...CLEARED, ENV: undefined, NODE_ENV: undefined }, () => {
      assert.equal(resource().attributes['deployment.environment.name'], 'development');
    });
  });
});
