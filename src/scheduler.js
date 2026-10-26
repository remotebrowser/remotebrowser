import { consola } from 'consola/basic';
import { PgBoss, fromPglite } from 'pg-boss';
import { config } from './config.js';
import { getDatabase } from './db/database.js';
import { cleanupScreenshots } from './screenshots.js';
import { deleteExpiredSigninCodes } from './models/users.js';
import { cleanupApiKeys } from './models/apikeys.js';
import { deleteOldBrowserLaunches } from './models/browsers.js';

const CLEANUP_QUEUE = 'cleanup';
const EVERY_MINUTE = '* * * * *';

const createBoss = async () => {
  // PGlite is embedded, so it cannot be dialed over TCP; pg-boss adapts the
  // instance in-process instead. PGlite owns the lifecycle, not pg-boss.
  if (!config.databaseUrl) {
    const database = await getDatabase();
    return new PgBoss({ db: fromPglite(database.pglite), backend: 'pglite' });
  }
  // pg-boss owns its pool, separate from the app's; boss.stop() closes it.
  return new PgBoss({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
};

const cleanup = async () => {
  consola.info('SCHEDULER running clean-up tasks...', { 'event.domain': 'scheduler' });
  const timestamp = performance.now();
  cleanupScreenshots();
  // A failed purge must not fail the job: the next run retries it.
  const purged = await deleteExpiredSigninCodes();
  if (purged.error) {
    consola.error('SCHEDULER could not purge expired sign-in codes', {
      'event.domain': 'scheduler',
      'error.type': String(purged.error)
    });
  }
  const removedLaunches = await deleteOldBrowserLaunches();
  if (removedLaunches.error) {
    consola.error('SCHEDULER could not remove old browser launches', {
      'event.domain': 'scheduler',
      'error.type': String(removedLaunches.error)
    });
  }
  const removedKeys = await cleanupApiKeys();
  if (removedKeys.error) {
    consola.error('SCHEDULER could not remove expired API keys', {
      'event.domain': 'scheduler',
      'error.type': String(removedKeys.error)
    });
  }
  const duration = Math.round(performance.now() - timestamp);
  consola.info('SCHEDULER finished with clean-up tasks', {
    'event.domain': 'scheduler',
    'scheduler.duration_ms': duration
  });
};

const createScheduler = async () => {
  const boss = await createBoss();
  boss.on('error', (error) => consola.error('SCHEDULER error', error, { 'event.domain': 'scheduler' }));
  await boss.start();
  await boss.createQueue(CLEANUP_QUEUE);
  await boss.schedule(CLEANUP_QUEUE, EVERY_MINUTE);
  await boss.work(CLEANUP_QUEUE, cleanup);
  consola.info('SCHEDULER started', { 'event.domain': 'scheduler' });
  return boss;
};

let schedulerPromise;

const startScheduler = () => (schedulerPromise ??= createScheduler());

const drainScheduler = async () => {
  if (!schedulerPromise) return;
  // A failed start leaves nothing to stop, but must still clear the cache.
  const boss = await schedulerPromise.catch(() => null);
  schedulerPromise = undefined;
  if (boss) await boss.stop();
};

export { startScheduler, drainScheduler };
