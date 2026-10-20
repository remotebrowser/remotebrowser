import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';

// Host-facing defaults that the VM client uses unless tests inject fakes.

// Resolves with the exit result instead of throwing, so callers can treat a
// non-zero exit as data rather than an error.
const run = (argv) =>
  new Promise((resolve) => {
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

// Starts QEMU in its own session, logging to a file, so it keeps running when
// the app exits.
const start = async (argv, logFile) => {
  const log = await open(logFile, 'a', 0o600);
  try {
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', log.fd, log.fd] });
    const exited = new Promise((resolve) => {
      child.once('error', () => resolve(127));
      child.once('exit', (code) => resolve(code ?? 1));
    });
    child.unref();
    return { pid: child.pid, exited };
  } finally {
    await log.close();
  }
};

// User-mode networking accepts on the forwarded port as soon as QEMU has set
// up the VM, long before the guest boots, so this marks a successful start.
const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

// The OS picks a free loopback port; QEMU binds it right after, and a lost race
// is retried with a new one.
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      server.close(() => resolve(port));
    });
  });

// The command line of a running process, or null if it cannot be read.
// macOS has no /proc, so there ps reads it.
const commandLine = async (pid) => {
  if (process.platform === 'linux') {
    return readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => null);
  }
  const { code, stdout } = await run(['ps', '-o', 'command=', '-p', String(pid)]);
  return code === 0 ? stdout : null;
};

const pidExists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
};

// A pid alone can be reused after the VM is gone, so also check that the
// process is the QEMU that owns this state dir.
const isAlive = async (pid, marker) => {
  if (!pidExists(pid)) {
    return false;
  }
  const command = await commandLine(pid);
  // An exited QEMU may be reaped while its command line is read, and then the
  // read fails. Treating that as alive made a stop send SIGKILL to a gone pid.
  if (command === null) {
    return pidExists(pid);
  }
  return command.includes(marker);
};

const kill = (pid, signal) => process.kill(pid, signal);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lastLines = async (file, count = 5) =>
  (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').slice(-count).join('\n');

export { delay, freePort, isAlive, kill, lastLines, portOpen, run, start };
