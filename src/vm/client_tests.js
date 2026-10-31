import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PGLITE_DATA_DIR = 'memory://';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const { createVmClient } = await import('./client.js');
const { hostArch } = await import('./qemu.js');
const { MACHINE_VERSION } = await import('./qemu.js');
const { fileStamp } = await import('./snapshot.js');
const { writeSuspendedPreviews } = await import('./previews.js');
const { consola } = await import('consola/basic');

// Stands in for spawning QEMU. `fails(argv)` returns a log line for a QEMU
// that exits at once; otherwise the VM comes up and its port opens.
const startStub = (fails = () => null) => {
  const starts = [];
  const open = new Set();
  const start = async (argv, logFile) => {
    starts.push(argv);
    const error = fails(argv);
    if (error) {
      writeFileSync(logFile, `${error}\n`);
      return { pid: 4242, exited: Promise.resolve(1) };
    }
    writeFileSync(valueAfter(argv, '-pidfile'), '4242\n');
    open.add(valueAfter(argv, '-netdev').match(/127\.0\.0\.1:(\d+)-/)[1]);
    return { pid: 4242, exited: new Promise(() => {}) };
  };
  const portOpen = async (port) => open.has(String(port));
  return { starts, start, portOpen };
};

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tempDataDir = () => mkdtempSync(path.join(tmpdir(), 'rb-vm-tests-'));

const client = (overrides = {}) =>
  createVmClient({
    arch: 'x86_64',
    accel: 'kvm',
    // No image or snapshot, unless a test saves them with launcher().
    dataDir: tempDataDir(),
    memory: '2G',
    cpus: 2,
    freePort: portsFrom([34567, 34568]),
    isAlive: async () => false,
    cdpRetry: { attempts: 2, delayMs: 0, timeoutMs: 1000 },
    stopGraceMs: 0,
    browserStartTimeoutMs: 100,
    ...overrides
  });

// Hands out the given ports in turn, then fresh ones, as the OS would.
const portsFrom = (ports) => {
  const queue = [...ports];
  let next = 50000;
  return async () => queue.shift() ?? (next += 1);
};

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

// An image build of `os`, as its buildImage leaves it.
const savedImage = (dataDir, { content = '', os = 'debian-13' } = {}) => {
  const build = path.join(dataDir, 'images', os, 'x86_64-aaaa');
  mkdirSync(build, { recursive: true });
  for (const ext of ['qcow2', 'kernel', 'initrd']) {
    writeFileSync(path.join(build, `chromium.${ext}`), content);
  }
  return path.join(build, 'chromium.qcow2');
};

// The VM dirs in the data dir, if any.
const machines = (dataDir) => {
  try {
    return readdirSync(path.join(dataDir, 'machines'));
  } catch {
    return [];
  }
};

// A VM dir as a running VM leaves it.
const fakeVmDir = (dataDir, browserId, { pid = 4242, port = 34567 } = {}) => {
  const dir = path.join(dataDir, 'machines', browserId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'qemu.pid'), `${pid}\n`);
  writeFileSync(path.join(dir, 'cdp-port'), String(port));
  return dir;
};

test('browserExists is true while the VM state dir exists', async () => {
  const dataDir = tempDataDir();
  fakeVmDir(dataDir, 'Qabc12345');
  const vm = client({ dataDir });
  assert.equal(await vm.browserExists('Qabc12345'), true);
  assert.equal(await vm.browserExists('Qmissing1'), false);
  assert.equal(await vm.browserExists('a/../b'), false);
});

test('browserIsRunning checks that the QEMU in the pidfile owns this VM', async () => {
  const dataDir = tempDataDir();
  const dir = fakeVmDir(dataDir, 'Qabc12345', { pid: 4242 });
  const seen = [];
  const isAlive = async (pid, marker) => {
    seen.push([pid, marker]);
    return true;
  };
  assert.equal(await client({ dataDir, isAlive }).browserIsRunning('Qabc12345'), true);
  assert.deepEqual(seen, [[4242, dir]]);
  assert.equal(await client({ dataDir, isAlive: async () => false }).browserIsRunning('Qabc12345'), false);
  assert.equal(await client({ dataDir, isAlive }).browserIsRunning('Qmissing1'), false);
});

test('stopBrowser terminates QEMU, escalates to SIGKILL, and removes the overlay', async () => {
  const dataDir = tempDataDir();
  const dir = fakeVmDir(dataDir, 'Qabc12345');
  const signals = [];
  const vm = client({
    dataDir,
    isAlive: async () => !signals.includes('SIGKILL'),
    kill: (_pid, sig) => signals.push(sig)
  });
  await vm.stopBrowser('Qabc12345');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(existsSync(dir), false);
});

test('stopBrowser cleans up a VM whose QEMU already exited', async () => {
  const dataDir = tempDataDir();
  const dir = fakeVmDir(dataDir, 'Qabc12345');
  const signals = [];
  await client({ dataDir, kill: (_pid, sig) => signals.push(sig) }).stopBrowser('Qabc12345');
  assert.deepEqual(signals, []);
  assert.equal(existsSync(dir), false);
});

test('resolveCdpUrl rewrites the websocket URL to the forwarded loopback port', async () => {
  const dataDir = tempDataDir();
  fakeVmDir(dataDir, 'Qabc12345', { port: 34567 });
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return jsonResponse({ webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc-123' });
  };
  assert.equal(
    await client({ dataDir, fetchImpl }).resolveCdpUrl('Qabc12345'),
    'ws://127.0.0.1:34567/devtools/browser/abc-123'
  );
  assert.deepEqual(urls, ['http://127.0.0.1:34567/json/version']);
});

test('resolveCdpUrl retries a booting guest and surfaces the last failure', async () => {
  const dataDir = tempDataDir();
  fakeVmDir(dataDir, 'Qabc12345');
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 2) {
      throw new Error('connect ECONNRESET');
    }
    return jsonResponse({ webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc' });
  };
  assert.equal(
    await client({ dataDir, fetchImpl }).resolveCdpUrl('Qabc12345'),
    'ws://127.0.0.1:34567/devtools/browser/abc'
  );
  assert.equal(attempts, 2);

  const alwaysFails = client({ dataDir, fetchImpl: async () => new Response(null, { status: 500 }) });
  await assert.rejects(alwaysFails.resolveCdpUrl('Qabc12345'), /HTTP 500/);
});

test('resolveCdpUrl returns null for a malformed id', async () => {
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    return jsonResponse({});
  };
  assert.equal(await client({ fetchImpl }).resolveCdpUrl('a/../b'), null);
  assert.equal(fetched, false);
});

test('the default client runs QEMU for the host architecture', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "import('./index.js').then((m) => process.stdout.write(`${m.vms.runtime} ${m.vms.arch}`))"],
    { cwd: __dirname, env: { ...process.env, NODE_ENV: 'development' } }
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), `qemu ${hostArch()}`);
});

test('suspendBrowser pauses the VM, saves its state, and quits QEMU', async () => {
  const dataDir = tempDataDir();
  const dir = fakeVmDir(dataDir, 'Qabc12345');
  let saved = '';
  let alive = true;
  const { commands, connectQmp } = fakeQmp({
    'migrate': ({ uri }) => {
      saved = uri.replace(/^file:/, '');
      writeFileSync(saved, 'state');
      return {};
    },
    'query-migrate': { status: 'completed' },
    'quit': () => {
      alive = false;
      return {};
    }
  });
  const vm = client({ dataDir, connectQmp, isAlive: async () => alive });
  const previews = [{ pageId: 'page0', title: 'First', url: 'https://example.com/', data: Buffer.from('png') }];
  await vm.suspendBrowser('Qabc12345', { previews });
  assert.deepEqual(names(commands), ['stop', 'migrate', 'query-migrate', 'quit']);
  // The page pictures stay with the suspended VM, to show until it resumes.
  assert.deepEqual(await vm.listSuspendedPreviews('Qabc12345'), [
    { pageId: 'page0', title: 'First', url: 'https://example.com/' }
  ]);
  assert.equal((await vm.readSuspendedPreview('Qabc12345', 'page0')).toString(), 'png');
  assert.equal(saved, path.join(dir, 'suspended.state.part'));
  // Only the complete file counts; then it is compressed, and the original
  // goes.
  assert.equal(existsSync(saved), false);
  assert.equal(existsSync(path.join(dir, 'suspended.state')), false);
  assert.equal(execFileSync('zstd', ['-dc', path.join(dir, 'suspended.state.zst')], { encoding: 'utf8' }), 'state');
  assert.equal(await vm.browserIsSuspended('Qabc12345'), true);
  assert.equal(await vm.browserIsRunning('Qabc12345'), false);
});

test('suspendBrowser waits for a long save to finish', async () => {
  const dataDir = tempDataDir();
  fakeVmDir(dataDir, 'Qabc12345');
  const statuses = ['setup', 'active', 'active', 'completed'];
  let alive = true;
  const { commands, connectQmp } = fakeQmp({
    'migrate': ({ uri }) => {
      writeFileSync(uri.replace(/^file:/, ''), 'state');
      return {};
    },
    'query-migrate': () => ({ status: statuses.shift() }),
    'quit': () => {
      alive = false;
      return {};
    }
  });
  await client({ dataDir, connectQmp, isAlive: async () => alive }).suspendBrowser('Qabc12345');
  assert.equal(names(commands).filter((name) => name === 'query-migrate').length, 4);
});

test('a failed save leaves the VM running and no state file', async () => {
  const dataDir = tempDataDir();
  const dir = fakeVmDir(dataDir, 'Qabc12345');
  const { commands, connectQmp } = fakeQmp({ 'query-migrate': { status: 'failed' } });
  const vm = client({ dataDir, connectQmp, isAlive: async () => true });
  const previews = [{ pageId: 'page0', title: 'First', url: 'https://example.com/', data: Buffer.from('png') }];
  await assert.rejects(vm.suspendBrowser('Qabc12345', { previews }), /saving the VM state failed/);
  assert.deepEqual(await vm.listSuspendedPreviews('Qabc12345'), [], 'no pictures of a browser that still runs');
  assert.deepEqual(names(commands), ['stop', 'migrate', 'query-migrate', 'migrate_cancel', 'cont']);
  assert.equal(existsSync(path.join(dir, 'suspended.state')), false);
  assert.equal(await vm.browserIsSuspended('Qabc12345'), false);
});

test('suspendBrowser refuses a VM that is not running', async () => {
  const dataDir = tempDataDir();
  fakeVmDir(dataDir, 'Qabc12345');
  const { commands, connectQmp } = fakeQmp();
  await assert.rejects(client({ dataDir, connectQmp }).suspendBrowser('Qabc12345'), /is not running/);
  await assert.rejects(client({ dataDir, connectQmp }).suspendBrowser('a/../b'), /Invalid browser id/);
  assert.equal(commands.length, 0);
});

// A suspended VM as suspendBrowser leaves it: no QEMU, but a state file.
// Its machine runs on an image build in the data dir.
const suspendedVmDir = (dataDir, browserId, { cdp = 34567, vnc = 34568 } = {}) => {
  const dir = fakeVmDir(dataDir, browserId, { port: cdp });
  writeFileSync(path.join(dir, 'vnc-port'), String(vnc));
  const image = savedImage(dataDir);
  writeFileSync(
    path.join(dir, 'machine.json'),
    JSON.stringify({ arch: 'x86_64', accel: 'kvm', image, memory: '3G', cpus: 4 })
  );
  writeFileSync(path.join(dir, 'suspended.state'), 'state');
  return dir;
};

test('resumeBrowser starts the same machine from its state, on its old ports, and sets the clock', async () => {
  const dataDir = tempDataDir();
  const dir = suspendedVmDir(dataDir, 'Qabc12345', { cdp: 40100, vnc: 40101 });
  const { starts, start, portOpen } = startStub();
  const statuses = ['inmigrate', 'inmigrate', 'paused'];
  const { commands, connectQmp } = fakeQmp({ 'query-status': () => ({ status: statuses.shift() }) });
  // The config changed since the launch; the saved machine still wins.
  const vm = client({
    start,
    portOpen,
    dataDir,
    connectQmp,
    memory: '1G',
    cpus: 1
  });

  await writeSuspendedPreviews(dir, [{ pageId: 'page0', title: '', url: '', data: Buffer.from('png') }]);
  assert.deepEqual(await vm.resumeBrowser('Qabc12345'), { browserId: 'Qabc12345' });
  // The pages are live again, so their old pictures go.
  assert.deepEqual(await vm.listSuspendedPreviews('Qabc12345'), []);

  const args = starts[0];
  assert.equal(valueAfter(args, '-incoming'), `file:${path.join(dir, 'suspended.state')}`);
  assert.equal(valueAfter(args, '-m'), '3G');
  assert.equal(valueAfter(args, '-smp'), '4');
  assert.equal(
    valueAfter(args, '-kernel'),
    path.join(dataDir, 'images', 'debian-13', 'x86_64-aaaa', 'chromium.kernel')
  );
  assert.match(valueAfter(args, '-netdev'), /:40100-:9222$/);
  assert.equal(valueAfter(args, '-vnc'), '127.0.0.1:34201');
  assert.deepEqual(names(commands), ['query-status', 'query-status', 'query-status', 'cont', 'guest-set-time']);
  assert.deepEqual(commands.at(-1), { socket: 'qga.sock', agent: true, command: 'guest-set-time', args: undefined });
  // The state now lags the running VM; it must not be resumed from again.
  assert.equal(existsSync(path.join(dir, 'suspended.state')), false);
});

test('resumeBrowser moves to fresh ports when the old ones are taken', async () => {
  const dataDir = tempDataDir();
  const dir = suspendedVmDir(dataDir, 'Qabc12345', { cdp: 40100, vnc: 40101 });
  const { start, portOpen } = startStub((argv) =>
    argv.some((arg) => arg.includes(':40100-')) ? 'Could not set up host forwarding rule' : null
  );
  const { connectQmp } = fakeQmp({ 'query-status': { status: 'running' } });
  await client({ start, portOpen, dataDir, connectQmp, freePort: portsFrom([40200, 40201]) }).resumeBrowser(
    'Qabc12345'
  );
  assert.equal(readFileSync(path.join(dir, 'cdp-port'), 'utf8'), '40200');
  assert.equal(readFileSync(path.join(dir, 'vnc-port'), 'utf8'), '40201');
});

test('a failed resume kills QEMU and keeps the state for another try', async () => {
  const dataDir = tempDataDir();
  const dir = suspendedVmDir(dataDir, 'Qabc12345');
  const { start, portOpen } = startStub();
  const { connectQmp } = fakeQmp({ 'query-status': { status: 'internal-error' } });
  const signals = [];
  const vm = client({ start, portOpen, dataDir, connectQmp, kill: (pid, sig) => signals.push([pid, sig]) });
  await assert.rejects(vm.resumeBrowser('Qabc12345'), /Unable to resume chromium-Qabc12345: the VM is internal-error/);
  assert.deepEqual(signals, [[4242, 'SIGKILL']]);
  assert.equal(existsSync(path.join(dir, 'suspended.state')), true);
});

test('a resume still succeeds when the guest clock cannot be set', async () => {
  const dataDir = tempDataDir();
  suspendedVmDir(dataDir, 'Qabc12345');
  const { start, portOpen } = startStub();
  const { connectQmp } = fakeQmp({ 'query-status': { status: 'running' }, 'guest-set-time': new Error('no agent') });
  const vm = client({ start, portOpen, dataDir, connectQmp });
  // Retrying the agent waits between tries; skip those waits here.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    assert.deepEqual(await vm.resumeBrowser('Qabc12345'), { browserId: 'Qabc12345' });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('resumeBrowser refuses a VM that is not suspended', async () => {
  const dataDir = tempDataDir();
  fakeVmDir(dataDir, 'Qabc12345');
  const { start, starts, portOpen } = startStub();
  const vm = client({ start, portOpen, dataDir, isAlive: async () => true });
  await assert.rejects(vm.resumeBrowser('Qabc12345'), /is not suspended/);
  await assert.rejects(vm.resumeBrowser('Qmissing1'), /is not suspended/);
  assert.equal(starts.length, 0);
});

// A QMP session that records commands and answers like QEMU would.
const fakeQmp = (answers = {}) => {
  const commands = [];
  const connectQmp = async (socketPath, options = {}) => ({
    execute: async (command, args) => {
      commands.push({ socket: path.basename(socketPath), agent: Boolean(options.agent), command, args });
      const answer = answers[command];
      if (answer instanceof Error) {
        throw answer;
      }
      return typeof answer === 'function' ? answer(args) : (answer ?? {});
    },
    close: () => {}
  });
  return { commands, connectQmp };
};

const names = (commands) => commands.map(({ command }) => command);

// An image build of `os` and a snapshot of it in `dataDir`, as takeSnapshot
// leaves them.
const savedSnapshot = async (dataDir, { os = 'debian-13', accel = 'kvm', memory = '2G', cpus = 2 } = {}) => {
  const image = savedImage(dataDir, { content: 'disk', os });
  const snapshotDir = path.join(dataDir, 'snapshots', os);
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(path.join(snapshotDir, 'overlay.qcow2'), 'snapshot disk');
  writeFileSync(path.join(snapshotDir, 'vm.state'), 'state');
  const imageStamp = await fileStamp(image);
  writeFileSync(
    path.join(snapshotDir, 'machine.json'),
    JSON.stringify({
      os,
      arch: 'x86_64',
      accel,
      image,
      imageStamp,
      memory,
      cpus,
      version: MACHINE_VERSION
    })
  );
  return { image, snapshotDir };
};

// A client with a snapshot it can start VMs from, and a QEMU that loads it.
const launcher = async (overrides = {}, snapshot = {}) => {
  const dataDir = overrides.dataDir ?? tempDataDir();
  const { snapshotDir } = await savedSnapshot(dataDir, snapshot);
  const qmp = fakeQmp({ 'query-status': { status: 'paused' } });
  // The browser answers, as it does once the clock is set.
  const fetchImpl = async () => jsonResponse({ webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/b' });
  return {
    snapshotDir,
    commands: qmp.commands,
    vm: client({ dataDir, connectQmp: qmp.connectQmp, fetchImpl, ...overrides })
  };
};

test('launchBrowser starts QEMU from the snapshot, sets the clock, and records the CDP port', async () => {
  const dataDir = tempDataDir();
  const { starts, start, portOpen } = startStub();
  const { vm, snapshotDir, commands } = await launcher({ start, portOpen, dataDir });

  const { browserId } = await vm.launchBrowser();

  assert.match(browserId, /^Q[23456789abcdefghijkmnpqrstuvwxyz]{8}$/);
  const dir = path.join(dataDir, 'machines', browserId);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  // A copy of the snapshot's disk, never a fresh one on the image.
  assert.equal(readFileSync(path.join(dir, 'overlay.qcow2'), 'utf8'), 'snapshot disk');
  assert.equal(starts.length, 1);
  assert.equal(starts[0][0], 'qemu-system-x86_64');
  assert.equal(valueAfter(starts[0], '-name'), `chromium-${browserId}`);
  assert.equal(valueAfter(starts[0], '-incoming'), `file:${path.join(snapshotDir, 'vm.state')}`);
  assert.deepEqual(names(commands), ['query-status', 'cont', 'guest-set-time']);
  assert.equal(readFileSync(path.join(dir, 'cdp-port'), 'utf8'), '34567');
  assert.equal(readFileSync(path.join(dir, 'vnc-port'), 'utf8'), '34568');
});

test('launchBrowser sets the upstream proxy before the clock, which starts the browser', async () => {
  const { start, portOpen } = startStub();
  const { commands, connectQmp } = fakeQmp({
    'query-status': { status: 'paused' },
    'guest-file-open': 3,
    'guest-file-write': (args) => ({ count: Buffer.from(args['buf-b64'], 'base64').length })
  });
  const { vm } = await launcher({ start, portOpen, connectQmp });
  await vm.launchBrowser({ proxy: 'http://u:p@Proxy.example.com:8080' });
  assert.deepEqual(names(commands), [
    'query-status',
    'cont',
    'guest-file-open',
    'guest-file-write',
    'guest-file-close',
    'guest-set-time'
  ]);
  const write = commands.find(({ command }) => command === 'guest-file-write');
  assert.equal(Buffer.from(write.args['buf-b64'], 'base64').toString(), 'http://u:p@proxy.example.com:8080\n');
});

test('launchBrowser refuses a bad proxy URL before it starts a VM', async () => {
  const dataDir = tempDataDir();
  const { starts, start, portOpen } = startStub();
  const { vm } = await launcher({ start, portOpen, dataDir });
  await assert.rejects(vm.launchBrowser({ proxy: 'https://proxy.example.com' }), /must start with/);
  assert.equal(starts.length, 0);
  assert.deepEqual(machines(dataDir), []);
});

test('setProxy writes the upstream proxy into a running VM, and clearProxy goes direct', async () => {
  const dataDir = tempDataDir();
  fakeVmDir(dataDir, 'Qabc12345');
  const { commands, connectQmp } = fakeQmp({
    'guest-file-open': 3,
    'guest-file-write': (args) => ({
      count: Buffer.from(args['buf-b64'], 'base64').length
    })
  });
  const vm = client({ dataDir, connectQmp, isAlive: async () => true });
  await vm.setProxy('Qabc12345', 'socks5://proxy.example.com:1080');
  await vm.clearProxy('Qabc12345');
  const written = commands
    .filter(({ command }) => command === 'guest-file-write')
    .map(({ socket, args }) => [socket, Buffer.from(args['buf-b64'], 'base64').toString()]);
  assert.deepEqual(written, [
    ['qga.sock', 'socks5://proxy.example.com:1080\n'],
    ['qga.sock', 'direct\n']
  ]);
});

test('setProxy and clearProxy refuse a VM that is not running, a bad id, and a bad or empty URL', async () => {
  const dataDir = tempDataDir();
  fakeVmDir(dataDir, 'Qabc12345');
  const { commands, connectQmp } = fakeQmp();
  const vm = client({ dataDir, connectQmp, isAlive: async () => false });
  await assert.rejects(vm.setProxy('Qabc12345', 'http://proxy.example.com:8080'), /is not running/);
  await assert.rejects(vm.clearProxy('Qabc12345'), /is not running/);
  await assert.rejects(vm.setProxy('a/../b', 'http://proxy.example.com:8080'), /Invalid browser id/);
  await assert.rejects(vm.clearProxy('a/../b'), /Invalid browser id/);
  await assert.rejects(vm.setProxy('Qabc12345', 'ftp://proxy.example.com'), /must start with/);
  // Going direct takes clearProxy, never an empty URL.
  for (const empty of [null, undefined, '', '  ']) {
    await assert.rejects(vm.setProxy('Qabc12345', empty), /clear the proxy instead/);
  }
  assert.equal(commands.length, 0);
});

// What the guest agent was asked to write, as [path, text].
const guestWrites = (commands) => {
  const writes = [];
  for (const { command, args } of commands) {
    if (command === 'guest-file-open') {
      writes.push([args.path, '']);
    } else if (command === 'guest-file-write') {
      writes.at(-1)[1] = Buffer.from(args['buf-b64'], 'base64').toString();
    }
  }
  return writes;
};

const writingQmp = (answers = {}) =>
  fakeQmp({
    'guest-file-open': 3,
    'guest-file-write': (args) => ({ count: Buffer.from(args['buf-b64'], 'base64').length }),
    ...answers
  });

test('launchBrowser sets the screen before the clock, which starts the browser', async () => {
  const { start, portOpen } = startStub();
  const { commands, connectQmp } = writingQmp({ 'query-status': { status: 'paused' } });
  // The guest sets the screen on the second look.
  const looks = [];
  const readScreenSize = async (port) => {
    looks.push(port);
    return looks.length > 1 ? { width: 1376, height: 768 } : { width: 1920, height: 1080 };
  };
  const { vm } = await launcher({ start, portOpen, connectQmp, readScreenSize, browserStartTimeoutMs: 2000 });
  await vm.launchBrowser({ screenResolution: { width: 1366, height: 768 } });
  // On the VNC port, before the clock.
  assert.deepEqual(looks, [34568, 34568]);
  assert.deepEqual(names(commands).slice(0, 2), ['query-status', 'cont']);
  assert.equal(names(commands).at(-1), 'guest-set-time');
  assert.deepEqual(guestWrites(commands), [['/etc/remotebrowser/screen-resolution', '1366x768\n']]);
});

test('launchBrowser sets the screen scale before the clock, which starts the browser', async () => {
  const { start, portOpen } = startStub();
  const { commands, connectQmp } = writingQmp({ 'query-status': { status: 'paused' } });
  const { vm } = await launcher({ start, portOpen, connectQmp });
  await vm.launchBrowser({ screenScale: 150 });
  assert.equal(names(commands).at(-1), 'guest-set-time');
  assert.deepEqual(guestWrites(commands), [['/etc/remotebrowser/screen-scale', '150\n']]);
});

test('launchBrowser refuses a bad screen scale before it starts a VM', async () => {
  const dataDir = tempDataDir();
  const { starts, start, portOpen } = startStub();
  const { vm } = await launcher({ start, portOpen, dataDir });
  await assert.rejects(vm.launchBrowser({ screenScale: 110 }), /in steps of 25%/);
  assert.equal(starts.length, 0);
  assert.deepEqual(machines(dataDir), []);
});

test('launchBrowser writes nothing for the default screen resolution', async () => {
  const { start, portOpen } = startStub();
  const { vm, commands } = await launcher({ start, portOpen });
  await vm.launchBrowser();
  assert.deepEqual(guestWrites(commands), []);
});

test('launchBrowser refuses a bad screen resolution before it starts a VM', async () => {
  const dataDir = tempDataDir();
  const { starts, start, portOpen } = startStub();
  const { vm } = await launcher({ start, portOpen, dataDir });
  await assert.rejects(vm.launchBrowser({ screenResolution: { width: 5120, height: 2880 } }), /at most 3840x2160/);
  assert.equal(starts.length, 0);
  assert.deepEqual(machines(dataDir), []);
});

// A running VM whose guest sets the screen to the size last written.
// `pad` is how wide VNC shows the screen, as the GPU pads it.
const runningVm = ({ pad = (width) => width, ...overrides } = {}) => {
  const dataDir = tempDataDir();
  const dir = fakeVmDir(dataDir, 'Qabc12345');
  writeFileSync(path.join(dir, 'vnc-port'), '34568');
  const qmp = writingQmp();
  const vm = client({
    dataDir,
    connectQmp: qmp.connectQmp,
    isAlive: async () => true,
    browserStartTimeoutMs: 1000,
    readScreenSize: async (port) => {
      assert.equal(port, 34568);
      const screen = guestWrites(qmp.commands).findLast(([file]) => file.endsWith('screen-resolution'));
      const [width, height] = (screen?.[1] ?? '1920x1080').replace('default', '1920x1080').trim().split('x');
      return { width: pad(Number(width)), height: Number(height) };
    },
    ...overrides
  });
  return { vm, commands: qmp.commands };
};

test('setScreenResolution sets the screen of a running browser, and waits until it shows', async () => {
  const { vm, commands } = runningVm();
  await vm.setScreenResolution('Qabc12345', { width: 2560, height: 1440 });
  await vm.setScreenResolution('Qabc12345', null);
  assert.deepEqual(guestWrites(commands), [
    ['/etc/remotebrowser/screen-resolution', '2560x1440\n'],
    ['/etc/remotebrowser/screen-resolution', 'default\n']
  ]);
});

test('setScreenResolution fails when the guest does not set the screen', async () => {
  const dataDir = tempDataDir();
  const dir = fakeVmDir(dataDir, 'Qabc12345');
  writeFileSync(path.join(dir, 'vnc-port'), '34568');
  const vm = client({
    dataDir,
    connectQmp: writingQmp().connectQmp,
    isAlive: async () => true,
    browserStartTimeoutMs: 300,
    readScreenSize: async () => ({ width: 1920, height: 1080 })
  });
  await assert.rejects(
    vm.setScreenResolution('Qabc12345', { width: 1366, height: 768 }),
    /the screen did not change to 1366x768 \(1920x1080\)/
  );
});

test('setScreenResolution refuses a VM that is not running, a bad id, and a bad screen resolution', async () => {
  const dataDir = tempDataDir();
  fakeVmDir(dataDir, 'Qabc12345');
  const { commands, connectQmp } = fakeQmp();
  const vm = client({ dataDir, connectQmp, isAlive: async () => false });
  await assert.rejects(vm.setScreenResolution('Qabc12345', { width: 1280, height: 720 }), /is not running/);
  await assert.rejects(vm.setScreenResolution('a/../b', { width: 1280, height: 720 }), /Invalid browser id/);
  await assert.rejects(vm.setScreenResolution('Qabc12345', { width: 320, height: 240 }), /at least 640x480/);
  assert.equal(commands.length, 0);
});

test('setScreenScale sets the scale of a running browser', async () => {
  const { vm, commands } = runningVm();
  await vm.setScreenScale('Qabc12345', 200);
  await vm.setScreenScale('Qabc12345', null);
  assert.deepEqual(guestWrites(commands), [
    ['/etc/remotebrowser/screen-scale', '200\n'],
    ['/etc/remotebrowser/screen-scale', 'default\n']
  ]);
});

test('setScreenScale refuses a VM that is not running, a bad id, and a bad scale', async () => {
  const dataDir = tempDataDir();
  fakeVmDir(dataDir, 'Qabc12345');
  const { commands, connectQmp } = fakeQmp();
  const vm = client({ dataDir, connectQmp, isAlive: async () => false });
  await assert.rejects(vm.setScreenScale('Qabc12345', 150), /is not running/);
  await assert.rejects(vm.setScreenScale('a/../b', 150), /Invalid browser id/);
  await assert.rejects(vm.setScreenScale('Qabc12345', 50), /from 100% to 300%/);
  assert.equal(commands.length, 0);
});

test('launchBrowser records the machine, so a resume starts the same one', async () => {
  const dataDir = tempDataDir();
  const { start, portOpen } = startStub();
  const { vm } = await launcher({ start, portOpen, dataDir, memory: '3G', cpus: 4 }, { memory: '3G', cpus: 4 });
  const { browserId } = await vm.launchBrowser();
  const machine = JSON.parse(readFileSync(path.join(dataDir, 'machines', browserId, 'machine.json'), 'utf8'));
  // Without the snapshot's stamp and version.
  assert.deepEqual(Object.keys(machine), ['os', 'arch', 'accel', 'image', 'imageStamp', 'memory', 'cpus']);
  assert.deepEqual([machine.memory, machine.cpus], ['3G', 4]);
});

test('launchBrowser refuses, and logs why, when there is no usable snapshot', async (t) => {
  const errors = [];
  t.mock.method(consola, 'error', (message, attributes) => errors.push({ message, attributes }));
  const cases = [
    [{}, null, /No snapshot in/],
    [{}, { cpus: 4 }, /The snapshot has debian-13 x86_64 2G 4; asked for debian-13 x86_64 2G 2/],
    [{}, { accel: 'tcg' }, /saved under tcg, but VMs here run under kvm/]
  ];
  for (const [overrides, snapshot, reason] of cases) {
    const dataDir = tempDataDir();
    const { starts, start, portOpen } = startStub();
    const vm = snapshot
      ? (await launcher({ start, portOpen, dataDir, ...overrides }, snapshot)).vm
      : client({ start, portOpen, dataDir, ...overrides });
    await assert.rejects(vm.launchBrowser(), reason);
    // Never a boot from the image instead.
    assert.equal(starts.length, 0);
    assert.deepEqual(machines(dataDir), []);
    assert.match(errors.at(-1).message, /no usable snapshot/);
    assert.match(errors.at(-1).attributes['error.type'], reason);
  }
});

test('canLaunchBrowser is true only with a usable snapshot, of the OS when one is named', async () => {
  const { vm } = await launcher();
  assert.equal(await vm.canLaunchBrowser(), true);
  assert.equal(await vm.canLaunchBrowser('debian-13'), true);
  assert.equal(await vm.canLaunchBrowser('macos-15'), false);
  assert.deepEqual(await vm.launchableOses(), ['debian-13']);
  assert.equal(await client({ dataDir: tempDataDir() }).canLaunchBrowser(), false);
  assert.equal(await (await launcher({}, { accel: 'tcg' })).vm.canLaunchBrowser(), false);
});

test('launchBrowser fails, without booting, when the VM does not load from the snapshot', async () => {
  const dataDir = tempDataDir();
  const { starts, start, portOpen } = startStub();
  const signals = [];
  await savedSnapshot(dataDir);
  const { connectQmp } = fakeQmp({ 'query-status': { status: 'internal-error' } });
  const vm = client({
    start,
    portOpen,
    dataDir,
    connectQmp,
    kill: (_pid, sig) => signals.push(sig)
  });

  await assert.rejects(vm.launchBrowser(), /Unable to launch the browser.*internal-error/);

  assert.deepEqual(signals, ['SIGKILL']);
  assert.equal(starts.length, 1);
  assert.deepEqual(machines(dataDir), []);
});

test('launchBrowser never gives CDP and VNC the same port', async () => {
  const { starts, start, portOpen } = startStub();
  const { vm } = await launcher({ start, portOpen, freePort: portsFrom([40000, 40000, 40001]) });
  await vm.launchBrowser();
  assert.match(valueAfter(starts[0], '-netdev'), /:40000-:9222$/);
  assert.equal(valueAfter(starts[0], '-vnc'), '127.0.0.1:34101');
});

test('launchBrowser retries with a new port when QEMU cannot bind one', async () => {
  const { starts, start, portOpen } = startStub((argv) =>
    argv.some((arg) => arg.includes(':40001-')) ? 'Could not set up host forwarding rule' : null
  );
  const dataDir = tempDataDir();
  const { vm } = await launcher({ start, portOpen, dataDir, freePort: portsFrom([40001, 40011, 40002, 40012]) });
  const { browserId } = await vm.launchBrowser();
  assert.equal(starts.length, 2);
  assert.equal(readFileSync(path.join(dataDir, 'machines', browserId, 'cdp-port'), 'utf8'), '40002');
});

test('launchBrowser rejects with the QEMU log and leaves no state behind when QEMU fails', async () => {
  const dataDir = tempDataDir();
  const { start, portOpen } = startStub(() => 'could not load the state');
  const { vm } = await launcher({ start, portOpen, dataDir });
  await assert.rejects(vm.launchBrowser(), /Unable to launch the browser.*could not load the state/);
  assert.deepEqual(machines(dataDir), []);
});

test('launchBrowser kills a QEMU that never opens its port', async () => {
  const signals = [];
  const start = async () => ({ pid: 4242, exited: new Promise(() => {}) });
  const { vm } = await launcher({
    start,
    portOpen: async () => false,
    startTimeoutMs: 0,
    kill: (pid, sig) => signals.push([pid, sig])
  });
  await assert.rejects(vm.launchBrowser(), /did not start in time/);
  assert.deepEqual(signals, [
    [4242, 'SIGKILL'],
    [4242, 'SIGKILL'],
    [4242, 'SIGKILL']
  ]);
});

test('launchBrowser fails, and stops QEMU, when the browser does not start after the clock is set', async () => {
  const dataDir = tempDataDir();
  const { start, portOpen } = startStub();
  const signals = [];
  const { vm } = await launcher({
    start,
    portOpen,
    dataDir,
    fetchImpl: async () => Promise.reject(new Error('connection refused')),
    kill: (_pid, sig) => signals.push(sig)
  });
  await assert.rejects(vm.launchBrowser(), /the browser did not start.*connection refused/);
  assert.deepEqual(signals, ['SIGKILL']);
  assert.deepEqual(machines(dataDir), []);
});

test('resumeBrowser refuses a VM whose image build is gone or has changed, and keeps it', async () => {
  const dataDir = tempDataDir();
  const dir = suspendedVmDir(dataDir, 'Qabc12345');
  const machine = JSON.parse(readFileSync(path.join(dir, 'machine.json'), 'utf8'));
  writeFileSync(path.join(dir, 'machine.json'), JSON.stringify({ ...machine, imageStamp: '1 1' }));
  const { starts, start, portOpen } = startStub();
  const vm = client({ start, portOpen, dataDir });
  await assert.rejects(vm.resumeBrowser('Qabc12345'), /Unable to resume chromium-Qabc12345: its image .* has changed/);

  rmSync(path.join(dataDir, 'images'), { recursive: true });
  await assert.rejects(vm.resumeBrowser('Qabc12345'), /its image file .* is gone/);
  assert.equal(starts.length, 0);
  assert.equal(existsSync(path.join(dir, 'suspended.state')), true);
});

// A suspend as the fake QEMU does it: the state lands in the VM dir.
const savingQmp = () => {
  let alive = true;
  const qmp = fakeQmp({
    'migrate': ({ uri }) => {
      writeFileSync(uri.replace(/^file:/, ''), 'state '.repeat(1000));
      return {};
    },
    'query-migrate': { status: 'completed' },
    'quit': () => {
      alive = false;
      return {};
    }
  });
  return { ...qmp, isAlive: async () => alive };
};

test('without zstd, suspendBrowser still suspends, and keeps the state uncompressed', async (t) => {
  const warnings = [];
  t.mock.method(consola, 'warn', (message) => warnings.push(message));
  const dataDir = tempDataDir();
  const dir = fakeVmDir(dataDir, 'Qabc12345');
  const { connectQmp, isAlive } = savingQmp();
  const vm = client({ dataDir, connectQmp, isAlive, zstd: 'no-such-zstd' });

  await vm.suspendBrowser('Qabc12345');

  assert.equal(existsSync(path.join(dir, 'suspended.state')), true);
  assert.equal(existsSync(path.join(dir, 'suspended.state.zst')), false);
  assert.equal(await vm.browserIsSuspended('Qabc12345'), true);
  assert.match(warnings[0], /^QEMU unable to compress the suspended state/);
});

test('resumeBrowser decompresses the state, loads it, and removes both files once the VM runs', async () => {
  const dataDir = tempDataDir();
  const dir = suspendedVmDir(dataDir, 'Qabc12345');
  execFileSync('zstd', ['-q', '--rm', path.join(dir, 'suspended.state')]);
  const { start, starts, portOpen } = startStub();
  const { connectQmp } = fakeQmp({ 'query-status': { status: 'paused' } });

  await client({ start, portOpen, dataDir, connectQmp }).resumeBrowser('Qabc12345');

  assert.equal(valueAfter(starts[0], '-incoming'), `file:${path.join(dir, 'suspended.state')}`);
  assert.equal(existsSync(path.join(dir, 'suspended.state')), false);
  assert.equal(existsSync(path.join(dir, 'suspended.state.zst')), false);
});

test('a resume that cannot decompress the state keeps it, and starts no QEMU', async () => {
  const dataDir = tempDataDir();
  const dir = suspendedVmDir(dataDir, 'Qabc12345');
  execFileSync('zstd', ['-q', '--rm', path.join(dir, 'suspended.state')]);
  const { start, starts, portOpen } = startStub();
  const vm = client({ start, portOpen, dataDir, zstd: 'false' });
  await assert.rejects(vm.resumeBrowser('Qabc12345'), /Unable to resume chromium-Qabc12345: false exited/);
  assert.equal(starts.length, 0);
  assert.equal(existsSync(path.join(dir, 'suspended.state.zst')), true);
});

test('saveScreenshot keeps the newest frame of each page in the VM dir, and never makes a dir for a stopped browser', async () => {
  const dataDir = tempDataDir();
  const dir = fakeVmDir(dataDir, 'Qabc12345');
  const vm = client({ dataDir });
  // A frame that comes while one is written replaces any frame still waiting.
  await Promise.all(
    ['one', 'two', 'three'].map((frame) => vm.saveScreenshot('Qabc12345', 'PAGE1', Buffer.from(frame)))
  );
  await vm.saveScreenshot('Qabc12345', 'PAGE2', Buffer.from('other'));
  assert.equal(readFileSync(path.join(dir, 'screenshot-PAGE1.jpg'), 'utf8'), 'three');
  assert.equal(readFileSync(path.join(dir, 'screenshot-PAGE2.jpg'), 'utf8'), 'other');
  assert.equal(existsSync(path.join(dir, 'screenshot-PAGE1.jpg.part')), false);

  // A page id is only ever a file name, never a path.
  for (const pageId of ['../escape', 'a/b', '']) {
    await vm.saveScreenshot('Qabc12345', pageId, Buffer.from('bad'));
  }
  assert.deepEqual(
    readdirSync(dir)
      .filter((name) => name.startsWith('screenshot'))
      .sort(),
    ['screenshot-PAGE1.jpg', 'screenshot-PAGE2.jpg']
  );

  await vm.saveScreenshot('Qdef12345', 'PAGE1', Buffer.from('gone'));
  assert.equal(existsSync(path.join(dataDir, 'machines', 'Qdef12345')), false);
  await vm.saveScreenshot('../etc', 'PAGE1', Buffer.from('bad'));
  assert.deepEqual(readdirSync(path.join(dataDir, 'machines')), ['Qabc12345']);
});

test('readSavedScreenshot reads back the frame of a page with when it was saved, and refuses an unsafe id', async () => {
  const dataDir = tempDataDir();
  fakeVmDir(dataDir, 'Qabc12345');
  const vm = client({ dataDir });
  await vm.saveScreenshot('Qabc12345', 'PAGE1', Buffer.from('frame'));
  const saved = await vm.readSavedScreenshot('Qabc12345', 'PAGE1');
  assert.equal(saved.data.toString(), 'frame');
  // The file time, which can be a little off from the clock in either direction.
  assert.ok(Math.abs(saved.timestamp - Date.now()) < 5000);
  assert.equal(await vm.readSavedScreenshot('Qabc12345', 'PAGE2'), null);
  assert.equal(await vm.readSavedScreenshot('Qabc12345', '../qemu.pid'), null);
  assert.equal(await vm.readSavedScreenshot('../etc', 'PAGE1'), null);
});

test('launchBrowser refuses an unknown OS', async () => {
  const { starts, start, portOpen } = startStub();
  const { vm } = await launcher({ start, portOpen });
  await assert.rejects(vm.launchBrowser({ os: 'macos-15' }), /Unknown OS macos-15/);
  assert.equal(starts.length, 0);
});

test('setScreenResolution waits for the screen that VNC shows padded to 16 pixels', async () => {
  const { vm, commands } = runningVm({ pad: (width) => Math.ceil(width / 16) * 16 });
  await vm.setScreenResolution('Qabc12345', { width: 1366, height: 768 });
  assert.deepEqual(guestWrites(commands), [['/etc/remotebrowser/screen-resolution', '1366x768\n']]);
});
