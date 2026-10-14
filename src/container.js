import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { consola } from 'consola/basic';
import { config } from './config.js';
import { generateShortId } from './id.js';

// In-process container manager. It drives `podman` or `docker` to run one
// Chrome container per browser and resolves each container's CDP websocket URL.
// The runtime is chosen by CONTAINER_RUNTIME, or auto-detected when unset. Every
// browser container is named `chrome-<browser-id>`.

const BROWSER_CONTAINER_PREFIX = 'chrome-';
const CDP_PORT = 9222;

// Unreserved URL chars only: a browser id is a path segment and must never escape it.
const BROWSER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const isWellFormedBrowserId = (browserId) => typeof browserId === 'string' && BROWSER_ID_PATTERN.test(browserId);

// Per-runtime differences. `run`, `kill`, `port` and `inspect` share the same
// CLI shape, so only these three diverge.
const RUNTIMES = {
  podman: {
    binary: 'podman',
    // `container exists` is Podman-only; Docker uses `container inspect`.
    existsArgs: (name) => ['container', 'exists', name]
  },
  docker: {
    binary: 'docker',
    existsArgs: (name) => ['container', 'inspect', name]
  }
};

// Podman first when both are installed, matching the default before Docker was
// supported; CONTAINER_RUNTIME forces either one.
const CONTAINER_RUNTIME_ORDER = ['podman', 'docker'];

const runtimeAvailable = (binary) => {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

const detectContainerRuntime = (available = runtimeAvailable) =>
  CONTAINER_RUNTIME_ORDER.find((name) => available(RUNTIMES[name].binary)) || 'podman';

// A remote Podman socket comes from CONTAINER_HOST in the environment and needs
// `--remote`; Docker reads its own socket from DOCKER_HOST and takes no flag.
const buildContainerCommand = (runtime, args, { containerHost = config.containerHost } = {}) => {
  const dialect = RUNTIMES[runtime];
  const remote = runtime === 'podman' && containerHost ? ['--remote'] : [];
  return [dialect.binary, ...remote, ...args];
};

// Resolves with the exit result instead of throwing, so callers can treat a
// non-zero exit (missing container, not running) as data rather than an error.
const defaultRun = (runtime, args) =>
  new Promise((resolve) => {
    const argv = buildContainerCommand(runtime, args);
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => resolve({ code: 127, stdout, stderr: stderr + error.message }));
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

const rewriteWsUrl = (wsUrl, baseUrl) => {
  const base = new URL(baseUrl);
  const parsed = new URL(wsUrl);
  parsed.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.hostname = base.hostname;
  parsed.port = base.port;
  return parsed.toString();
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Everything container-facing is behind this factory so tests can inject a fake
// runner and fetch; the exported singleton is what the app uses.
const createContainerClient = ({
  // Explicit CONTAINER_RUNTIME wins; otherwise probe the host.
  runtime = config.containerRuntime || detectContainerRuntime(),
  run,
  fetchImpl = globalThis.fetch,
  containerImage = config.containerImage,
  // Inside a container the published loopback port is only reachable with host
  // networking, and the container IP only without it (rootless Podman cannot
  // reach it from the host namespace), so try both.
  inContainer = existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
  cdpRetry = { attempts: 10, delayMs: 1000, timeoutMs: 5000 }
} = {}) => {
  const dialect = RUNTIMES[runtime];
  const exec = run ?? ((args) => defaultRun(runtime, args));
  // A container's port mapping is fixed for its lifetime, so it is worth caching.
  const portCache = new Map();
  const containerName = (browserId) => `${BROWSER_CONTAINER_PREFIX}${browserId}`;

  const getHostPort = async (name, containerPort) => {
    const key = `${name}:${containerPort}`;
    if (portCache.has(key)) {
      return portCache.get(key);
    }
    const { code, stdout } = await exec(['port', name, String(containerPort)]);
    if (code !== 0) {
      return null;
    }
    const mapping = stdout.trim();
    if (!mapping) {
      return null;
    }
    const hostPort = Number.parseInt(mapping.split(':').at(-1), 10);
    if (!Number.isInteger(hostPort)) {
      return null;
    }
    portCache.set(key, hostPort);
    return hostPort;
  };

  const getContainerIp = async (name) => {
    const key = `${name}:ip`;
    if (portCache.has(key)) {
      return portCache.get(key);
    }
    const { code, stdout } = await exec([
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
      name
    ]);
    const ip = code === 0 ? stdout.trim().split(/\s+/)[0] : '';
    if (!ip) {
      return null;
    }
    portCache.set(key, ip);
    return ip;
  };

  const evictPorts = (name) => {
    portCache.delete(`${name}:${CDP_PORT}`);
    portCache.delete(`${name}:ip`);
  };

  const launchBrowser = async () => {
    const prefix = runtime === 'podman' ? 'P' : 'D';
    const browserId = generateShortId(prefix, 8);
    const name = containerName(browserId);
    const args = ['run', '-d', '--rm', '--name', name];
    args.push('-p', `127.0.0.1::${CDP_PORT}`, containerImage);
    // Starting a container shells out and can take a while (image pull, cold
    // start), so log the attempt before it blocks to make a hang visible.
    consola.info(`Starting Google Chrome container ${name}`, {
      'event.domain': 'browserfleet',
      'rb.runtime': runtime,
      'rb.container_image': containerImage
    });
    const { code, stdout, stderr } = await exec(args);
    if (code !== 0 || !stdout.trim()) {
      consola.error(`Unable to start Google Chrome container ${name}`, {
        'event.domain': 'browserfleet',
        'rb.runtime': runtime,
        'rb.container_image': containerImage,
        'error.type': stderr.trim() || `runtime exited with code ${code}`
      });
      throw new Error(`Unable to launch Google Chrome for ${name}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    }
    consola.log(`Started Google Chrome container ${name}`, {
      'event.domain': 'browserfleet',
      'rb.runtime': runtime,
      'rb.container_id': stdout.trim()
    });
    // Warm the cache so the first CDP lookup does not race the mapping.
    await getHostPort(name, CDP_PORT);
    return { browserId };
  };

  const browserExists = async (browserId) => {
    if (!isWellFormedBrowserId(browserId)) {
      return false;
    }
    const { code } = await exec(dialect.existsArgs(containerName(browserId)));
    return code === 0;
  };

  const browserIsRunning = async (browserId) => {
    if (!isWellFormedBrowserId(browserId)) {
      return false;
    }
    const { code, stdout } = await exec(['inspect', '--format', '{{.State.Running}}', containerName(browserId)]);
    return code === 0 && stdout.trim() === 'true';
  };

  const stopBrowser = async (browserId) => {
    const name = containerName(browserId);
    try {
      const { code, stderr } = await exec(['kill', name]);
      if (code !== 0) {
        throw new Error(`Unable to kill container ${name}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
      }
    } finally {
      evictPorts(name);
    }
  };

  // Candidate base URLs in dial order; the first that answers wins.
  const getCdpBaseUrls = async (browserId) => {
    const name = containerName(browserId);
    const urls = [];
    if (inContainer) {
      const ip = await getContainerIp(name);
      if (ip) {
        urls.push(`http://${ip}:${CDP_PORT}`);
      }
    }
    const hostPort = await getHostPort(name, CDP_PORT);
    if (hostPort) {
      urls.push(`http://127.0.0.1:${hostPort}`);
    }
    if (urls.length === 0) {
      throw new Error(`CDP address not found for ${name}`);
    }
    return urls;
  };

  const fetchWebSocketDebuggerUrl = async (baseUrl) => {
    const response = await fetchImpl(`${baseUrl}/json/version`, {
      signal: AbortSignal.timeout(cdpRetry.timeoutMs)
    });
    if (!response.ok) {
      throw new Error(`CDP /json/version answered HTTP ${response.status}`);
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data.webSocketDebuggerUrl !== 'string') {
      throw new Error('CDP /json/version carried no webSocketDebuggerUrl');
    }
    return data.webSocketDebuggerUrl;
  };

  // Chrome needs a moment after its container starts before /json/version
  // answers, so the whole lookup is retried; the last failure is what surfaces.
  const resolveCdpUrl = async (browserId) => {
    if (!isWellFormedBrowserId(browserId)) {
      return null;
    }
    let lastError;
    for (let attempt = 0; attempt < cdpRetry.attempts; attempt += 1) {
      try {
        const baseUrls = await getCdpBaseUrls(browserId);
        let candidateError;
        for (const baseUrl of baseUrls) {
          try {
            return rewriteWsUrl(await fetchWebSocketDebuggerUrl(baseUrl), baseUrl);
          } catch (error) {
            candidateError = error;
          }
        }
        throw candidateError;
      } catch (error) {
        lastError = error;
        if (attempt < cdpRetry.attempts - 1) {
          await delay(cdpRetry.delayMs);
        }
      }
    }
    throw lastError;
  };

  // Startup probe: proves the container CLI is reachable before browsers are needed.
  const health = async () => {
    const { code, stderr } = await exec(['info']);
    if (code !== 0) {
      throw new Error(`${runtime} is not available${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    }
    return true;
  };

  return { runtime, launchBrowser, browserExists, browserIsRunning, stopBrowser, resolveCdpUrl, health };
};

// Reassignable so tests (and future callers) can swap the client; importers read
// the live binding at call time.
let containers = createContainerClient();
const setContainerClient = (client) => {
  containers = client;
};

export {
  isWellFormedBrowserId,
  createContainerClient,
  setContainerClient,
  detectContainerRuntime,
  buildContainerCommand,
  containers,
  BROWSER_CONTAINER_PREFIX
};
