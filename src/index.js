import { consola } from 'consola/basic';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { shutdown as shutdownTelemetry } from './logging.js';
import app from './app.js';
import { checkBrowserFleetHealth } from './fleet.js';
import { bootstrapVm } from './vm/bootstrap.js';
import { setupQemu } from './vm/setup.js';
import { vms } from './vm/index.js';
import { mountCdpRelay } from './cdp.js';
import { stopScreenshots } from './screenshots.js';
import { stopScreencasts } from './screencast.js';
import { browserMonitors } from './browser.js';

// Opens the database and runs migrations in every environment: Postgres when
// DATABASE_URL is set, PGlite otherwise.
const { getDatabase, closeDatabase } = await import('./db/database.js');
try {
  await getDatabase();
} catch (error) {
  consola.error('Unable to connect to the database:', error, { 'event.domain': 'database' });
  process.exit(1);
}

const { startScheduler, drainScheduler } = await import('./scheduler.js');
try {
  await startScheduler();
} catch (error) {
  consola.error('Unable to start the scheduler:', error, { 'event.domain': 'scheduler' });
  process.exit(1);
}

// Local mode runs QEMU VMs; external mode talks to BROWSERFLEET_URL.
if (!config.browserFleetUrl) {
  // The step logs the failure itself.
  await setupQemu().catch(() => process.exit(1));
}
const accel = config.browserFleetUrl ? null : await vms.getAccel();
consola.info(
  config.browserFleetUrl
    ? `Browser provider: external browserfleet (${config.browserFleetUrl})`
    : `Browser provider: qemu (${accel})`,
  { 'event.domain': 'browserfleet' }
);
if (accel === 'tcg') {
  consola.warn('QEMU has no KVM or HVF here, so browser VMs run under slow emulation', { 'event.domain': 'qemu' });
}
if (config.browserFleetUrl) {
  const health = await checkBrowserFleetHealth().catch((error) => ({ error }));
  if (health.error) {
    consola.error('Browser provider health check failed; server will start without browser provisioning', {
      'event.domain': 'browserfleet',
      'error.type': String(health.error),
      'server.address': config.browserFleetUrl
    });
  } else {
    consola.log('Browser provider health check passed', {
      'event.domain': 'browserfleet',
      'server.address': config.browserFleetUrl
    });
  }
}

// Building the image takes minutes, so the server does not wait for it. An
// external fleet has its own VMs.
if (!config.browserFleetUrl) {
  void bootstrapVm();
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  consola.info('SERVER listening on port', config.port, { 'event.domain': 'server' });
});

// Monitors are in memory, so browsers that outlived the previous run get theirs back.
void browserMonitors
  .startAllBrowserMonitors()
  .then((restored) => {
    if (restored.error) {
      consola.error('Unable to restore browser monitors', {
        'event.domain': 'browser-monitor',
        'error.type': String(restored.error)
      });
    } else {
      consola.info(`Restored ${restored.data.started} of ${restored.data.total} browser monitors`, {
        'event.domain': 'browser-monitor'
      });
    }
  })
  .catch((error) => {
    consola.error('Unable to restore browser monitors', {
      'event.domain': 'browser-monitor',
      'error.type': String(error)
    });
  });

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    consola.error(`SERVER port ${config.port} is in use. Stop the other process or set PORT.`, {
      'event.domain': 'server'
    });
  } else {
    consola.error('SERVER failed to start:', error, { 'event.domain': 'server' });
  }
  process.exit(1);
});

// CDP needs the raw socket for WebSocket handshake, which app.fetch does not expose.
const cdpRelay = mountCdpRelay({ server });

// Telemetry batches before exporting; flush now or scale-to-zero drops buffered data.
const shutdown = async (signal) => {
  consola.info('SERVER shutting down on', signal, { 'event.domain': 'server' });
  server.close();
  await drainScheduler().catch(() => {});
  // Open CDP WebSocket sessions would outlive server.close().
  await Promise.allSettled([
    cdpRelay.close(),
    stopScreenshots(),
    stopScreencasts(),
    browserMonitors.stopAllBrowserMonitors(),
    shutdownTelemetry(),
    closeDatabase()
  ]);
  process.exit(0);
};

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
