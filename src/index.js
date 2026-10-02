import { consola } from 'consola/basic';
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { shutdown as shutdownTelemetry } from './logging.js';
import app from './app.js';
import { checkBrowserFleetHealth } from './fleet.js';
import { mountCdpRelay } from './cdp.js';

// Opens the database and runs migrations in every environment: Postgres when
// DATABASE_URL is set, PGlite otherwise.
const { getDatabase, closeDatabase } = await import('./db/database.js');
try {
  await getDatabase();
} catch (error) {
  consola.error('Unable to connect to the database:', error, { 'event.domain': 'database' });
  process.exit(1);
}

const health = await checkBrowserFleetHealth().catch((error) => ({ error }));
if (health.error) {
  consola.error('BROWSERFLEET health check failed; server will start without fleet connectivity', {
    'event.domain': 'browserfleet',
    'error.type': String(health.error),
    'server.address': config.browserFleetUrl
  });
} else {
  consola.log('BROWSERFLEET health check passed', {
    'event.domain': 'browserfleet',
    'server.address': config.browserFleetUrl
  });
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  consola.info('SERVER listening on port', config.port, { 'event.domain': 'server' });
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
  // Open CDP WebSocket sessions would outlive server.close().
  await Promise.allSettled([cdpRelay.close(), shutdownTelemetry(), closeDatabase()]);
  process.exit(0);
};

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
