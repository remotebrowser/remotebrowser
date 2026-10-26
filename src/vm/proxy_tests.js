import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { GUEST_PROXY_FILE, normalizeProxyUrl, maskProxyUrl, writeGuestProxy } from './proxy.js';

test('normalizeProxyUrl takes http and socks proxies, with or without credentials', () => {
  assert.equal(normalizeProxyUrl('http://proxy.example.com:8080'), 'http://proxy.example.com:8080');
  assert.equal(normalizeProxyUrl('  http://Proxy.Example.com:8080/  '), 'http://proxy.example.com:8080');
  assert.equal(normalizeProxyUrl('socks5://SOCKS.example.com:1080'), 'socks5://socks.example.com:1080');
  assert.equal(normalizeProxyUrl('socks4://203.0.113.9:1080'), 'socks4://203.0.113.9:1080');
  assert.equal(
    normalizeProxyUrl('http://brd-customer-x_1-zone:p!a$s*w=d@proxy.example.com:8080'),
    'http://brd-customer-x_1-zone:p!a$s*w=d@proxy.example.com:8080'
  );
  // tinyproxy does not decode, so the guest gets the chars themselves.
  assert.equal(
    normalizeProxyUrl('http://user:pa%2Bss@proxy.example.com:8080'),
    'http://user:pa+ss@proxy.example.com:8080'
  );
  // The guest takes credentials only as user:password@.
  assert.equal(normalizeProxyUrl('http://user@proxy.example.com:8080'), 'http://user:@proxy.example.com:8080');
});

test('normalizeProxyUrl fills in the default port', () => {
  assert.equal(normalizeProxyUrl('http://proxy.example.com'), 'http://proxy.example.com:80');
  assert.equal(normalizeProxyUrl('http://proxy.example.com:80'), 'http://proxy.example.com:80');
  assert.equal(normalizeProxyUrl('socks5://proxy.example.com'), 'socks5://proxy.example.com:1080');
});

test('normalizeProxyUrl treats nothing as no upstream proxy', () => {
  assert.equal(normalizeProxyUrl(null), null);
  assert.equal(normalizeProxyUrl(undefined), null);
  assert.equal(normalizeProxyUrl(''), null);
  assert.equal(normalizeProxyUrl('   '), null);
});

test('normalizeProxyUrl refuses what tinyproxy cannot take', () => {
  const refused = [
    ['proxy.example.com:8080', /not a valid URL|must start with/],
    ['https://proxy.example.com:443', /must start with http:\/\//],
    ['ftp://proxy.example.com:21', /must start with/],
    ['http://proxy.example.com:8080/path', /path, query, or fragment/],
    ['http://proxy.example.com:8080?a=1', /path, query, or fragment/],
    ['http://[::1]:8080', /host name or an IPv4 address/],
    ['http://localhost:8119', /loopback, link-local, or reserved/],
    ['http://127.0.0.1:8119', /loopback, link-local, or reserved/],
    ['http://0.0.0.0:8119', /loopback, link-local, or reserved/],
    ['http://us%40er:pass@proxy.example.com:8080', /may only have/],
    ['http://user:pa%23ss@proxy.example.com:8080', /may only have/],
    ['http://user:pa%0Ass@proxy.example.com:8080', /may only have/],
    ['http://:pass@proxy.example.com:8080', /password but no user/],
    [`http://${'a'.repeat(510)}.com:80`, /too long/],
    [42, /./]
  ];
  for (const [input, message] of refused) {
    assert.throws(() => normalizeProxyUrl(/** @type {any} */ (input)), message, String(input));
  }
});

// A guest agent that records commands and answers like qemu-ga would.
const fakeAgent = ({ fail = () => null, written } = {}) => {
  const commands = [];
  const connectQmp = async (socketPath, options) => ({
    execute: async (command, args) => {
      commands.push({ socket: path.basename(socketPath), agent: options.agent, command, args });
      const error = fail(command, commands.length);
      if (error) {
        throw error;
      }
      if (command === 'guest-file-open') {
        return 7;
      }
      if (command === 'guest-file-write') {
        const length = Buffer.from(args['buf-b64'], 'base64').length;
        return { count: written ?? length, eof: false };
      }
      return {};
    },
    close: () => {}
  });
  return { commands, connectQmp };
};

const writtenText = (commands) =>
  Buffer.from(commands.find(({ command }) => command === 'guest-file-write').args['buf-b64'], 'base64').toString();

test('writeGuestProxy writes the proxy URL as one line into the guest file', async () => {
  const { commands, connectQmp } = fakeAgent();
  await writeGuestProxy({ dir: '/vm', proxy: 'http://u:p@proxy.example.com:8080', connectQmp });
  assert.deepEqual(
    commands.map(({ socket, agent, command }) => [socket, agent, command]),
    [
      ['qga.sock', true, 'guest-file-open'],
      ['qga.sock', true, 'guest-file-write'],
      ['qga.sock', true, 'guest-file-close']
    ]
  );
  assert.deepEqual(commands[0].args, { path: GUEST_PROXY_FILE, mode: 'w' });
  assert.equal(commands[2].args.handle, 7);
  assert.equal(writtenText(commands), 'http://u:p@proxy.example.com:8080\n');
});

test('writeGuestProxy writes "direct" to clear the proxy', async () => {
  const { commands, connectQmp } = fakeAgent();
  await writeGuestProxy({ dir: '/vm', proxy: null, connectQmp });
  assert.equal(writtenText(commands), 'direct\n');
});

test('writeGuestProxy refuses a bad URL without reaching the guest', async () => {
  const { commands, connectQmp } = fakeAgent();
  await assert.rejects(writeGuestProxy({ dir: '/vm', proxy: 'https://proxy.example.com', connectQmp }), /must start/);
  assert.equal(commands.length, 0);
});

test('writeGuestProxy retries while the agent does not answer, and closes a file it opened', async () => {
  const { commands, connectQmp } = fakeAgent({
    fail: (command, n) => (command === 'guest-file-write' && n === 2 ? new Error('busy') : null)
  });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = /** @type {any} */ ((fn) => realSetTimeout(fn, 0));
  try {
    await writeGuestProxy({ dir: '/vm', proxy: 'http://proxy.example.com:8080', connectQmp });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.deepEqual(
    commands.map(({ command }) => command),
    [
      'guest-file-open',
      'guest-file-write',
      'guest-file-close',
      'guest-file-open',
      'guest-file-write',
      'guest-file-close'
    ]
  );
});

test('writeGuestProxy fails when the guest takes only part of the line', async () => {
  const { connectQmp } = fakeAgent({ written: 3 });
  await assert.rejects(
    writeGuestProxy({ dir: '/vm', proxy: 'http://proxy.example.com:8080', connectQmp, attempts: 1 }),
    /unable to set the upstream proxy: wrote 3 of 30 bytes/
  );
});

// No real proxy can be at these: in the guest, loopback is tinyproxy itself, and
// link-local is where a cloud keeps its metadata service.
test('normalizeProxyUrl refuses loopback, link-local, multicast, and reserved addresses', () => {
  for (const host of [
    '127.1.2.3',
    '0.0.0.0',
    '169.254.169.254',
    '169.254.1.1',
    '224.0.0.1',
    '198.18.0.1',
    '255.255.255.255'
  ]) {
    for (const scheme of ['http', 'socks4', 'socks5']) {
      assert.throws(
        () => normalizeProxyUrl(`${scheme}://${host}:1080`),
        /loopback, link-local, or reserved/,
        `${scheme} ${host}`
      );
    }
  }
});

// An egress proxy, e.g. for a fixed IP address, often sits on the same private network.
test('normalizeProxyUrl takes a proxy on a private or shared network', () => {
  for (const host of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.20', '100.64.0.1']) {
    for (const scheme of ['http', 'socks4', 'socks5']) {
      assert.equal(normalizeProxyUrl(`${scheme}://${host}:1080`), `${scheme}://${host}:1080`, `${scheme} ${host}`);
    }
  }
});

test('normalizeProxyUrl refuses names that always mean the guest itself, and takes local network names', () => {
  for (const host of ['localhost', 'proxy.localhost', 'localhost.']) {
    assert.throws(() => normalizeProxyUrl(`socks5://${host}:1080`), /loopback, link-local, or reserved/, host);
  }
  for (const host of ['squid.local', 'proxy.corp.internal', 'egress.internal']) {
    assert.equal(normalizeProxyUrl(`socks5://${host}:1080`), `socks5://${host}:1080`, host);
  }
});

// Otherwise a resolver would read these as 127.0.0.1 and slip past the range check.
test('normalizeProxyUrl refuses an address written in any form but a plain dotted quad', () => {
  for (const host of ['2130706433', '0x7f000001', '0x7f.1', '127.1', '017700000001', '1.2.3.4.5', '01.2.3.4']) {
    assert.throws(() => normalizeProxyUrl(`socks5://${host}:1080`), /loopback, link-local|plain IPv4 address/, host);
  }
  // The http: scheme rewrites such forms to a dotted quad first, which is then checked.
  assert.throws(() => normalizeProxyUrl('http://2130706433:8080'), /loopback, link-local, or reserved/);
});

test('normalizeProxyUrl takes public addresses and names', () => {
  for (const host of ['203.0.113.7', '8.8.8.8', 'proxy.example.com']) {
    assert.equal(normalizeProxyUrl(`socks5://${host}:1080`), `socks5://${host}:1080`, host);
  }
});

test('maskProxyUrl hides the password, and keeps everything else', () => {
  assert.equal(maskProxyUrl('http://user:secret@proxy.example.com:8080'), 'http://user:****@proxy.example.com:8080');
  assert.equal(maskProxyUrl('socks5://proxy.example.com:1080'), 'socks5://proxy.example.com:1080');
  // The guest form keeps the colon even with no password; there is nothing to hide.
  assert.equal(maskProxyUrl('http://user:@proxy.example.com:80'), 'http://user:@proxy.example.com:80');
  assert.equal(
    maskProxyUrl(normalizeProxyUrl('http://u:p%21w@Proxy.Example.com')),
    'http://u:****@proxy.example.com:80'
  );
  assert.equal(maskProxyUrl(null), null);
});
