import { BlockList, isIP } from 'node:net';

// Strip inline regex constraints from route templates; count braces for nesting.
const routeTemplate = (route) => {
  if (!route || !route.includes('{')) {
    return route;
  }
  let template = '';
  let depth = 0;
  for (const character of route) {
    if (character === '{') {
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
    } else if (depth === 0) {
      template += character;
    }
  }
  return template;
};

// Collapse unmatched requests to '/*' instead of echoing the client.
const isRouteMatched = (route) => Boolean(route) && route !== '/*' && route !== '*';

// Loopback and private ranges, where a reverse proxy on the same host or network connects from.
const PRIVATE_PEERS = new BlockList();
PRIVATE_PEERS.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_PEERS.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_PEERS.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_PEERS.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_PEERS.addAddress('::1', 'ipv6');
PRIVATE_PEERS.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_PEERS.addSubnet('fe80::', 10, 'ipv6');

// Dual-stack sockets report IPv4 peers as ::ffff:a.b.c.d.
const normalizeAddress = (address) => {
  const unmapped = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  return isIP(unmapped) ? unmapped : null;
};

const isPrivatePeer = (address) => PRIVATE_PEERS.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

// Each trusted proxy appends the address it saw, so the leftmost entries may be
// forged by the client. Walk back from the socket peer only through trusted
// hops. A public peer is not one of our proxies, so its header is ignored.
const clientAddress = ({ peer, forwardedFor, trustedProxyHops = 0 }) => {
  const peerAddress = peer ? normalizeAddress(peer) : null;
  if (!peerAddress || trustedProxyHops === 0 || !isPrivatePeer(peerAddress)) {
    return peerAddress;
  }
  const chain = (forwardedFor || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  chain.push(peerAddress);
  const index = chain.length - 1 - trustedProxyHops;
  // A short chain means fewer proxies than configured; never guess past it.
  const candidate = index >= 0 ? normalizeAddress(chain[index]) : null;
  return candidate || peerAddress;
};

// Semconv's known-method set. Anything outside it collapses to _OTHER.
const KNOWN_METHODS = new Set(['CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE']);

const methodAttributes = (method) =>
  KNOWN_METHODS.has(method)
    ? { 'http.request.method': method }
    : { 'http.request.method': '_OTHER', 'http.request.method_original': method };

// The span name must stay low-cardinality, thus the parameterized route.
const requestSpanName = ({ method, route = null }) => {
  const { 'http.request.method': normalized } = methodAttributes(method);
  return isRouteMatched(route) ? `${normalized} ${route}` : normalized;
};

// Every value is redacted, not just the ones known to be sensitive.
const redactQuery = (search) => {
  const keys = [...new URLSearchParams(search).keys()];
  return keys.length > 0 ? keys.map((key) => `${key}=REDACTED`).join('&') : null;
};

// Absent values are omitted rather than filled with a placeholder.
const requestAttributes = ({ method, url, ipAddress, userAgent }) => {
  const { protocol, hostname, pathname, search } = new URL(url);
  const attributes = {
    ...methodAttributes(method),
    'url.path': pathname,
    'url.scheme': protocol.replace(/:$/, ''),
    'server.address': hostname
  };
  const query = redactQuery(search);
  if (query) {
    attributes['url.query'] = query;
  }
  if (ipAddress) {
    attributes['client.address'] = ipAddress;
  }
  if (userAgent) {
    attributes['user_agent.original'] = userAgent;
  }
  return attributes;
};

const responseAttributes = ({ route, status, contentLength }) => {
  const attributes = { 'http.response.status_code': status };
  if (isRouteMatched(route)) {
    attributes['http.route'] = route;
  }
  if (contentLength) {
    const size = Number(contentLength);
    if (Number.isFinite(size)) {
      attributes['http.response.body.size'] = size;
    }
  }
  return attributes;
};

const consolaTypeForStatus = (status) => {
  if (status >= 500) {
    return 'error';
  }
  return status >= 400 ? 'warn' : 'log';
};

export {
  clientAddress,
  routeTemplate,
  isRouteMatched,
  consolaTypeForStatus,
  requestSpanName,
  requestAttributes,
  responseAttributes
};
