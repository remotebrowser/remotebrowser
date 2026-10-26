import path from 'node:path';
import { BlockList } from 'node:net';
import { delay } from './host.js';

// Each VM's tinyproxy can forward the browser's traffic to an upstream proxy,
// e.g. for a fixed egress IP address. The host writes the proxy URL, or
// "direct", into this guest file through the guest agent, and
// tinyproxy-upstream.path in vm/files applies it. See tinyproxy-config there
// for how the guest reads it.
const GUEST_PROXY_FILE = '/etc/remotebrowser/proxy/upstream';
const DIRECT = 'direct';

const MAX_PROXY_URL_LENGTH = 512;
const DEFAULT_PORTS = { 'http:': '80', 'socks4:': '1080', 'socks5:': '1080' };
// tinyproxy puts the user and password in the Upstream line as they are,
// without decoding, so only chars that need no escaping there.
const CREDENTIAL = /^[-A-Za-z0-9._~!$&*+,;=]*$/;
const HOSTNAME = /^[a-z0-9][-a-z0-9.]*$/;

// No real proxy can be at these: the guest's loopback is tinyproxy itself, and
// link-local is where a cloud keeps its metadata service. Private ranges stay
// allowed, since an egress proxy often sits on the private network.
const REFUSED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) {
  REFUSED_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}

// Names that always mean the guest itself.
const LOOPBACK_NAME = /(^|\.)localhost$/;

// A numeric last label means an address in some other form, which a resolver
// reads as 127.0.0.1. Only a plain dotted quad passes, so the range check sees
// the address that will be used.
const NUMERIC_LABEL = /^(0x[0-9a-f]*|[0-9]+)$/;
const DOTTED_QUAD = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const REFUSED_HOST_ERROR = 'The proxy host must not be a loopback, link-local, or reserved address';

// Checked by spelling only, since tinyproxy resolves the name again later.
const checkProxyHost = (hostname) => {
  const name = hostname.replace(/\.$/, '');
  if (NUMERIC_LABEL.test(name.split('.').at(-1) ?? '')) {
    if (!DOTTED_QUAD.test(name)) {
      throw new Error('The proxy host must be a host name or a plain IPv4 address, e.g. 203.0.113.7');
    }
    if (REFUSED_ADDRESSES.check(name, 'ipv4')) {
      throw new Error(REFUSED_HOST_ERROR);
    }
  } else if (LOOPBACK_NAME.test(name)) {
    throw new Error(REFUSED_HOST_ERROR);
  }
};

const decode = (part) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
};

/**
 * Checks an upstream proxy URL, such as `http://user:password@host:8080` or
 * `socks5://host:1080`, and returns it in the form the guest takes. Empty or
 * null means no upstream proxy. Throws an Error that says what is wrong.
 * @param {string | null | undefined} input
 * @returns {string | null}
 */
const normalizeProxyUrl = (input) => {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof input !== 'string') {
    throw new Error('The proxy URL must be a string');
  }
  const text = input.trim();
  if (text === '') {
    return null;
  }
  if (text.length > MAX_PROXY_URL_LENGTH) {
    throw new Error('The proxy URL is too long');
  }
  /** @type {URL} */
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('The proxy URL is not a valid URL');
  }
  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (!defaultPort) {
    throw new Error('The proxy URL must start with http://, socks4://, or socks5://');
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('The proxy URL must not have a path, query, or fragment');
  }
  // Only http: is a special scheme, which lowercases the host already.
  const hostname = url.hostname.toLowerCase();
  if (!HOSTNAME.test(hostname)) {
    throw new Error('The proxy host must be a host name or an IPv4 address');
  }
  checkProxyHost(hostname);
  const user = decode(url.username);
  const password = decode(url.password);
  if (user === null || password === null || !CREDENTIAL.test(user) || !CREDENTIAL.test(password)) {
    throw new Error('The proxy user and password may only have letters, digits, and - . _ ~ ! $ & * + , ; =');
  }
  if (!user && password) {
    throw new Error('The proxy URL has a password but no user');
  }
  // The guest takes credentials only as user:password@, even with no password.
  const credentials = user ? `${user}:${password}@` : '';
  return `${url.protocol}//${credentials}${hostname}:${url.port || defaultPort}`;
};

/**
 * Writes the upstream proxy into the guest, which restarts tinyproxy with it.
 * That also ends the browser's open connections, so none keep the old route.
 * The guest agent may not answer yet right after the VM starts, so this
 * retries.
 * @param {{dir: string, proxy: string | null, connectQmp: Function, attempts?: number}} params
 */
const writeGuestProxy = async ({ dir, proxy, connectQmp, attempts = 20 }) => {
  const content = Buffer.from(`${normalizeProxyUrl(proxy) ?? DIRECT}\n`);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const agent = await connectQmp(path.join(dir, 'qga.sock'), { agent: true, timeoutMs: 3000 });
      try {
        // The guest rejects a file without its closing newline, so a partial
        // write leaves the browser offline, not going out directly.
        const handle = await agent.execute('guest-file-open', { path: GUEST_PROXY_FILE, mode: 'w' });
        try {
          const { count } = await agent.execute('guest-file-write', {
            handle,
            'buf-b64': content.toString('base64')
          });
          if (count !== content.length) {
            throw new Error(`wrote ${count} of ${content.length} bytes`);
          }
        } finally {
          await agent.execute('guest-file-close', { handle });
        }
        return;
      } finally {
        agent.close();
      }
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await delay(500);
      }
    }
  }
  throw new Error(
    `unable to set the upstream proxy: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError }
  );
};

export { GUEST_PROXY_FILE, normalizeProxyUrl, writeGuestProxy };
