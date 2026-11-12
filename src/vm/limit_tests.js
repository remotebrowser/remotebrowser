import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimit } from './limit.js';

const gate = () => {
  /** @type {() => void} */
  let open = () => {};
  const opened = new Promise((resolve) => {
    open = () => resolve(undefined);
  });
  return { opened, open };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('runs at most max tasks at once, and the rest in order', async () => {
  const limit = createLimit(2);
  const gates = [gate(), gate(), gate(), gate()];
  const started = [];
  const runs = gates.map((g, i) =>
    limit(async () => {
      started.push(i);
      await g.opened;
      return i;
    })
  );
  await tick();
  assert.deepEqual(started, [0, 1]);
  assert.equal(limit.pending(), 2);
  gates[1].open();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  gates[0].open();
  gates[2].open();
  gates[3].open();
  assert.deepEqual(await Promise.all(runs), [0, 1, 2, 3]);
  assert.equal(limit.pending(), 0);
});

test('a failed task frees its slot', async () => {
  const limit = createLimit(1);
  const failed = limit(async () => {
    throw new Error('boom');
  });
  const next = limit(async () => 'ok');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
});
