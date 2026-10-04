import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.PGLITE_DATA_DIR = 'memory://';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const { createContainerClient, isWellFormedBrowserId, detectContainerRuntime, buildContainerCommand } =
  await import('./container.js');

// Records every runtime invocation and answers by subcommand.
const runStub = (byCommand) => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const responder = byCommand[args[0]];
    if (!responder) {
      return { code: 1, stdout: '', stderr: `unexpected ${args[0]}` };
    }
    return typeof responder === 'function' ? responder(args) : responder;
  };
  return { calls, run };
};

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const client = (overrides = {}) =>
  createContainerClient({
    runtime: 'podman',
    cdpBaseHost: () => '127.0.0.1',
    cdpRetry: { attempts: 2, delayMs: 0, timeoutMs: 1000 },
    ...overrides
  });

test('launchBrowser runs a container with the configured image and ephemeral CDP/VNC ports', async () => {
  const { calls, run } = runStub({
    run: { code: 0, stdout: 'deadbeefcafe\n', stderr: '' },
    port: (args) => ({ code: 0, stdout: args[2] === '9222' ? '0.0.0.0:32768' : '0.0.0.0:32769', stderr: '' })
  });
  const container = client({ run, containerImage: 'example/chrome:1' });

  const { browserId } = await container.launchBrowser();

  assert.match(browserId, /^P[23456789abcdefghijkmnpqrstuvwxyz]{8}$/);
  const runCall = calls.find((args) => args[0] === 'run');
  assert.equal(runCall[runCall.indexOf('--name') + 1], `chrome-${browserId}`);
  assert.equal(runCall.at(-1), 'example/chrome:1');
  assert.deepEqual(runCall.slice(runCall.indexOf('-p')), ['-p', '9222', '-p', '5900', 'example/chrome:1']);
  // Both port mappings are resolved up front, so the first CDP lookup cannot race them.
  assert.equal(calls.filter((args) => args[0] === 'port').length, 2);
});

test('launchBrowser prefixes the browser id with the runtime letter', async () => {
  const stub = () =>
    runStub({
      run: { code: 0, stdout: 'cid\n', stderr: '' },
      port: { code: 0, stdout: '0.0.0.0:32768', stderr: '' }
    });
  const { browserId: podmanId } = await client({ runtime: 'podman', run: stub().run }).launchBrowser();
  assert.match(podmanId, /^P/);
  const { browserId: dockerId } = await client({ runtime: 'docker', run: stub().run }).launchBrowser();
  assert.match(dockerId, /^D/);
});

test('launchBrowser rejects when the runtime reports a failed run', async () => {
  const { run } = runStub({ run: { code: 125, stdout: '', stderr: 'image not found' } });
  await assert.rejects(client({ run }).launchBrowser(), /Unable to launch Google Chrome/);
});

test('browserExists uses the runtime-specific existence check', async () => {
  const podman = runStub({ container: { code: 0, stdout: '', stderr: '' } });
  assert.equal(await client({ runtime: 'podman', run: podman.run }).browserExists('Pabc12345'), true);
  assert.deepEqual(podman.calls[0], ['container', 'exists', 'chrome-Pabc12345']);

  const docker = runStub({ container: { code: 0, stdout: '', stderr: '' } });
  assert.equal(await client({ runtime: 'docker', run: docker.run }).browserExists('Pabc12345'), true);
  assert.deepEqual(docker.calls[0], ['container', 'inspect', 'chrome-Pabc12345']);
});

test('browserExists treats exit 0 as present and anything else as absent', async () => {
  const present = client({ run: runStub({ container: { code: 0, stdout: '', stderr: '' } }).run });
  const absent = client({ run: runStub({ container: { code: 1, stdout: '', stderr: '' } }).run });
  assert.equal(await present.browserExists('Pabc12345'), true);
  assert.equal(await absent.browserExists('Pabc12345'), false);
});

test('browserExists refuses a malformed id without shelling out', async () => {
  const { calls, run } = runStub({});
  const container = client({ run });
  assert.equal(await container.browserExists('a/../b'), false);
  assert.equal(calls.length, 0);
});

test('browserIsRunning reads the container state', async () => {
  const running = client({ run: runStub({ inspect: { code: 0, stdout: 'true\n', stderr: '' } }).run });
  const stopped = client({ run: runStub({ inspect: { code: 0, stdout: 'false\n', stderr: '' } }).run });
  const missing = client({ run: runStub({ inspect: { code: 1, stdout: '', stderr: 'no such container' } }).run });
  assert.equal(await running.browserIsRunning('Pabc12345'), true);
  assert.equal(await stopped.browserIsRunning('Pabc12345'), false);
  assert.equal(await missing.browserIsRunning('Pabc12345'), false);
});

test('stopBrowser kills the container and rejects when the runtime fails', async () => {
  const ok = client({ run: runStub({ kill: { code: 0, stdout: 'cid', stderr: '' } }).run });
  await ok.stopBrowser('Pabc12345');

  const { run } = runStub({ kill: { code: 125, stdout: '', stderr: 'no such container' } });
  await assert.rejects(client({ run }).stopBrowser('Pabc12345'), /Unable to kill container/);
});

test('resolveCdpUrl discovers the browser websocket URL and rewrites it to the reachable host', async () => {
  const { run } = runStub({
    port: { code: 0, stdout: '0.0.0.0:32768', stderr: '' }
  });
  const fetchImpl = async () => jsonResponse({ webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc-123' });
  const container = client({ run, fetchImpl });

  assert.equal(await container.resolveCdpUrl('Pabc12345'), 'ws://127.0.0.1:32768/devtools/browser/abc-123');
});

test('resolveCdpUrl retries a cold Chrome and surfaces the last failure', async () => {
  const { calls, run } = runStub({ port: { code: 0, stdout: '0.0.0.0:32768', stderr: '' } });
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 2) {
      throw new Error('connect ECONNREFUSED');
    }
    return jsonResponse({ webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc' });
  };
  const container = client({ run, fetchImpl });
  assert.equal(await container.resolveCdpUrl('Pabc12345'), 'ws://127.0.0.1:32768/devtools/browser/abc');
  assert.equal(attempts, 2);

  const alwaysFails = client({ run, fetchImpl: async () => new Response(null, { status: 500 }) });
  await assert.rejects(alwaysFails.resolveCdpUrl('Pabc12345'), /HTTP 500/);
  assert.ok(calls.length > 0);
});

test('resolveCdpUrl returns null for a malformed id', async () => {
  const { calls, run } = runStub({});
  assert.equal(await client({ run }).resolveCdpUrl('a/../b'), null);
  assert.equal(calls.length, 0);
});

test('health reports the runtime availability', async () => {
  const ok = client({ run: runStub({ info: { code: 0, stdout: '{}', stderr: '' } }).run });
  assert.equal(await ok.health(), true);

  const broken = client({ run: runStub({ info: { code: 127, stdout: '', stderr: 'command not found' } }).run });
  await assert.rejects(broken.health(), /podman is not available/);
});

test('detectContainerRuntime prefers podman, then docker, and falls back to podman', () => {
  assert.equal(
    detectContainerRuntime(() => false),
    'podman'
  );
  assert.equal(
    detectContainerRuntime((binary) => binary === 'docker'),
    'docker'
  );
  assert.equal(
    detectContainerRuntime((binary) => binary === 'podman'),
    'podman'
  );
  assert.equal(
    detectContainerRuntime(() => true),
    'podman'
  );
});

test('buildContainerCommand picks the binary and adds --remote only for podman', () => {
  assert.deepEqual(buildContainerCommand('docker', ['info']), ['docker', 'info']);
  assert.deepEqual(buildContainerCommand('podman', ['info']), ['podman', 'info']);
  assert.deepEqual(buildContainerCommand('podman', ['info'], { containerHost: 'unix:///run/podman.sock' }), [
    'podman',
    '--remote',
    'info'
  ]);
  assert.deepEqual(buildContainerCommand('docker', ['info'], { containerHost: 'tcp://host:2375' }), ['docker', 'info']);
});

test('isWellFormedBrowserId accepts path-safe ids and rejects traversal', () => {
  assert.equal(isWellFormedBrowserId('Pabc12345'), true);
  assert.equal(isWellFormedBrowserId('a/../b'), false);
});

test('createContainerClient reports the runtime it will use', () => {
  assert.equal(createContainerClient({ runtime: 'docker' }).runtime, 'docker');
  assert.equal(createContainerClient({ runtime: 'podman' }).runtime, 'podman');
});

// CONTAINER_RUNTIME must reach the default singleton, not just the factory.
test('the default client honors CONTAINER_RUNTIME from the environment', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "import('./container.js').then((m) => process.stdout.write(m.containers.runtime))"],
    { cwd: __dirname, env: { ...process.env, NODE_ENV: 'development', CONTAINER_RUNTIME: 'docker' } }
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), 'docker');
});
