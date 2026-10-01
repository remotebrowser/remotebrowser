import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clientAddress,
  routeTemplate,
  isRouteMatched,
  requestSpanName,
  requestAttributes,
  responseAttributes,
  consolaTypeForStatus
} from './http.js';

const { describe } = test;

describe('clientAddress', () => {
  const PROXY = '172.17.0.1';

  test('uses the socket peer when no proxy is trusted', () => {
    assert.equal(clientAddress({ peer: PROXY, forwardedFor: '6.6.6.6' }), PROXY);
  });

  test('takes the address that a single trusted proxy saw', () => {
    assert.equal(clientAddress({ peer: PROXY, forwardedFor: '203.0.113.7', trustedProxyHops: 1 }), '203.0.113.7');
  });

  // A proxy that appends to X-Forwarded-For keeps whatever the client sent on the left.
  test('ignores entries that the client forged ahead of the trusted proxy', () => {
    const forwardedFor = '6.6.6.6, 203.0.113.7';
    assert.equal(clientAddress({ peer: PROXY, forwardedFor, trustedProxyHops: 1 }), '203.0.113.7');
  });

  test('walks back through each trusted hop', () => {
    const forwardedFor = '6.6.6.6, 203.0.113.7, 10.0.0.5';
    assert.equal(clientAddress({ peer: PROXY, forwardedFor, trustedProxyHops: 2 }), '203.0.113.7');
  });

  // Reaching the app directly, bypassing the proxy, must not let a client pick its own address.
  test('ignores the header when the peer is a public address', () => {
    const forwardedFor = '6.6.6.6';
    assert.equal(clientAddress({ peer: '198.51.100.9', forwardedFor, trustedProxyHops: 1 }), '198.51.100.9');
  });

  test('falls back to the peer when the chain is shorter than the trusted hops', () => {
    assert.equal(clientAddress({ peer: PROXY, forwardedFor: '203.0.113.7', trustedProxyHops: 3 }), PROXY);
    assert.equal(clientAddress({ peer: PROXY, trustedProxyHops: 1 }), PROXY);
  });

  test('falls back to the peer when the trusted entry is not an IP address', () => {
    const forwardedFor = '<script>';
    assert.equal(clientAddress({ peer: PROXY, forwardedFor, trustedProxyHops: 1 }), PROXY);
  });

  test('unwraps IPv4-mapped IPv6 addresses', () => {
    const forwardedFor = '::ffff:203.0.113.7';
    assert.equal(clientAddress({ peer: '::ffff:172.17.0.1', forwardedFor, trustedProxyHops: 1 }), '203.0.113.7');
  });

  test('trusts a private IPv6 peer', () => {
    const forwardedFor = '2001:db8::1';
    assert.equal(clientAddress({ peer: 'fdaa::2', forwardedFor, trustedProxyHops: 1 }), '2001:db8::1');
  });

  test('is null without a peer', () => {
    assert.equal(clientAddress({ peer: undefined, forwardedFor: '6.6.6.6', trustedProxyHops: 1 }), null);
  });
});

describe('routeTemplate', () => {
  test('drops an inline regex constraint, quantifier and all', () => {
    assert.equal(routeTemplate('/accounts/:accountId{B[23456789abc]{5}}'), '/accounts/:accountId');
  });

  test('drops every constraint in a route with more than one parameter', () => {
    assert.equal(routeTemplate('/:teamId{T[abc]{6}}/accounts/:accountId{B[abc]{5}}'), '/:teamId/accounts/:accountId');
  });

  test('leaves a route without a constraint untouched', () => {
    assert.equal(routeTemplate('/team/:teamId/members'), '/team/:teamId/members');
    assert.equal(routeTemplate('/*'), '/*');
  });

  test('passes an absent route through so the unmatched case still reads as unmatched', () => {
    assert.equal(routeTemplate(null), null);
    assert.equal(routeTemplate(undefined), undefined);
  });
});

describe('isRouteMatched', () => {
  test('treats a concrete or parameterised route as matched', () => {
    assert.equal(isRouteMatched('/team/:teamId/members'), true);
    assert.equal(isRouteMatched('/health'), true);
  });

  // Hono returns middleware wildcard when nothing matched; that's what a 404 looks like.
  test('treats a bare wildcard or a missing route as unmatched', () => {
    assert.equal(isRouteMatched('/*'), false);
    assert.equal(isRouteMatched('*'), false);
    assert.equal(isRouteMatched(null), false);
    assert.equal(isRouteMatched(undefined), false);
  });
});

describe('requestSpanName', () => {
  test('is the method and the parameterised route, never the concrete path', () => {
    assert.equal(requestSpanName({ method: 'GET', route: '/teams/:teamId/members' }), 'GET /teams/:teamId/members');
  });

  test('falls back to the method alone when no route matched', () => {
    assert.equal(requestSpanName({ method: 'GET', route: '/*' }), 'GET');
    assert.equal(requestSpanName({ method: 'POST' }), 'POST');
  });

  test('uses the normalized method so an unknown one cannot inflate the name', () => {
    assert.equal(requestSpanName({ method: 'FROBNICATE', route: '/health' }), '_OTHER /health');
  });
});

describe('requestAttributes', () => {
  test('splits the URL into path, scheme and server address', () => {
    const attributes = requestAttributes({
      method: 'GET',
      url: 'https://app.example.com/teams/abc123/members',
      ipAddress: '203.0.113.7',
      userAgent: 'curl/8.5.0'
    });
    assert.deepEqual(attributes, {
      'http.request.method': 'GET',
      'url.path': '/teams/abc123/members',
      'url.scheme': 'https',
      'server.address': 'app.example.com',
      'client.address': '203.0.113.7',
      'user_agent.original': 'curl/8.5.0'
    });
  });

  // GET /continue carries a single-use sign-in nonce and the invite pages
  // carry an email address, so values are dropped wholesale rather than by a
  // denylist that the next sensitive parameter would slip past.
  test('keeps query keys but redacts every value', () => {
    const { 'url.query': query } = requestAttributes({
      method: 'GET',
      url: 'https://app.example.com/continue?nonce=SECRET123&email=someone%40example.com'
    });
    assert.equal(query, 'nonce=REDACTED&email=REDACTED');
  });

  test('never lets a query value reach the attributes', () => {
    const attributes = requestAttributes({
      method: 'GET',
      url: 'https://app.example.com/continue?nonce=SECRET123'
    });
    assert.doesNotMatch(JSON.stringify(attributes), /SECRET123/);
  });

  test('omits url.query when there is no query string', () => {
    const attributes = requestAttributes({ method: 'GET', url: 'https://app.example.com/health' });
    assert.equal('url.query' in attributes, false);
  });

  // An attribute named user_agent.original claims to hold what the client
  // sent, so a placeholder there would be a lie about the request.
  test('omits the client address and user agent when they are unavailable', () => {
    const attributes = requestAttributes({ method: 'GET', url: 'https://app.example.com/health' });
    assert.equal('client.address' in attributes, false);
    assert.equal('user_agent.original' in attributes, false);
  });

  test('collapses an unknown method to _OTHER and keeps the original', () => {
    const attributes = requestAttributes({ method: 'FROBNICATE', url: 'https://app.example.com/' });
    assert.equal(attributes['http.request.method'], '_OTHER');
    assert.equal(attributes['http.request.method_original'], 'FROBNICATE');
  });
});

describe('responseAttributes', () => {
  test('reports the status, the route and the body size', () => {
    assert.deepEqual(responseAttributes({ route: '/teams/:teamId/members', status: 200, contentLength: '4821' }), {
      'http.response.status_code': 200,
      'http.route': '/teams/:teamId/members',
      'http.response.body.size': 4821
    });
  });

  test('omits http.route entirely when no route matched', () => {
    assert.deepEqual(responseAttributes({ route: '/*', status: 404 }), { 'http.response.status_code': 404 });
  });

  test('omits the body size when Content-Length is absent or not a number', () => {
    assert.equal('http.response.body.size' in responseAttributes({ route: '/health', status: 200 }), false);
    assert.equal(
      'http.response.body.size' in responseAttributes({ route: '/health', status: 200, contentLength: '' }),
      false
    );
    assert.equal(
      'http.response.body.size' in responseAttributes({ route: '/health', status: 200, contentLength: 'chunked' }),
      false
    );
  });
});

describe('consolaTypeForStatus', () => {
  test('maps success to log, client errors to warn and server errors to error', () => {
    assert.equal(consolaTypeForStatus(200), 'log');
    assert.equal(consolaTypeForStatus(302), 'log');
    assert.equal(consolaTypeForStatus(399), 'log');
    assert.equal(consolaTypeForStatus(400), 'warn');
    assert.equal(consolaTypeForStatus(404), 'warn');
    assert.equal(consolaTypeForStatus(499), 'warn');
    assert.equal(consolaTypeForStatus(500), 'error');
    assert.equal(consolaTypeForStatus(503), 'error');
  });
});
