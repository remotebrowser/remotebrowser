import { consola } from 'consola/basic';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { shutdown as shutdownTelemetry } from './logging.js';
import app from './app.js';
import { checkBrowserFleetHealth } from './fleet.js';
import { containers } from './container.js';
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

const health = await checkBrowserFleetHealth().catch((error) => ({ error }));
// Local mode talks to the container CLI (podman or docker, per CONTAINER_RUNTIME);
// external mode talks to BROWSERFLEET_URL.
const browserProvider = config.browserFleetUrl || `${containers.runtime} (${config.containerImage})`;
consola.info(
  config.browserFleetUrl
    ? `Browser provider: external browserfleet (${config.browserFleetUrl})`
    : `Browser provider: ${containers.runtime}`,
  { 'event.domain': 'browserfleet' }
);
if (health.error) {
  consola.error('Browser provider health check failed; server will start without browser provisioning', {
    'event.domain': 'browserfleet',
    'error.type': String(health.error),
    'server.address': browserProvider
  });
} else {
  consola.log('Browser provider health check passed', {
    'event.domain': 'browserfleet',
    'server.address': browserProvider
  });
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
