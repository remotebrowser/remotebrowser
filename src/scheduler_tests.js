import test from 'node:test';
import assert from 'node:assert/strict';

// Force the PGlite path so the test never dials a developer's real Postgres.
delete process.env.DATABASE_URL;
process.env.PGLITE_DATA_DIR = 'memory://';

const { startScheduler, drainScheduler } = await import('./scheduler.js');

test.afterEach(async () => drainScheduler());

test('schedules the cleanup task every minute', async () => {
  const boss = await startScheduler();
  const schedule = await boss.getSchedule('cleanup');
  assert.equal(schedule.cron, '* * * * *');
});

test('starting twice shares one scheduler instance', async () => {
  const first = await startScheduler();
  const second = await startScheduler();
  assert.equal(first, second);
});
