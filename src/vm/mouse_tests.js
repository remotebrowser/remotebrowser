import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MOUSE_ACTIONS, parseMouseActions, runMouseActions, toAbs } from './mouse.js';

test('parseMouseActions fills in the defaults, and names the buttons as QEMU does', () => {
  assert.deepEqual(
    parseMouseActions([
      { action: 'move', x: 10, y: 20 },
      { action: 'click' },
      { action: 'click', x: 0, y: 0, button: 'right', count: 2 },
      { action: 'down', button: 'back' },
      { action: 'up', button: 'forward' },
      { action: 'scroll', dy: -3 }
    ]),
    [
      { action: 'move', x: 10, y: 20 },
      { action: 'click', button: 'left', count: 1 },
      { action: 'click', x: 0, y: 0, button: 'right', count: 2 },
      { action: 'down', button: 'side' },
      { action: 'up', button: 'extra' },
      { action: 'scroll', dx: 0, dy: -3 }
    ]
  );
});

test('parseMouseActions says which action is wrong, and why', () => {
  for (const [actions, error] of [
    [undefined, /must be a list/],
    [[], /empty/],
    [Array(MAX_MOUSE_ACTIONS + 1).fill({ action: 'click' }), /more than 50/],
    [['click'], /Action 0 must be an object/],
    [[{ action: 'drag' }], /Action 0 must be one of: move, down/],
    [[{ action: 'click' }, { action: 'move', x: 1 }], /Action 1 needs x from 0 to 3839/],
    [[{ action: 'move', x: 1.5, y: 1 }], /whole pixels/],
    [[{ action: 'click', y: 1 }], /needs x/],
    [[{ action: 'move', x: 1, y: 1, button: 'left' }], /unknown field: button/],
    [[{ action: 'wait', ms: 1 }], /Action 0 must be one of: move, down, up, click, scroll$/],
    [[{ action: 'scroll', dy: 1, ms: 1 }], /unknown field: ms/],
    [[{ action: 'click', button: 'wheel-up' }], /button that is not one of: left, middle, right, back, forward/],
    [[{ action: 'click', count: 4 }], /count from 1 to 3/],
    [[{ action: 'scroll' }], /needs dx or dy/],
    [[{ action: 'scroll', dy: 21 }], /needs dx or dy/]
  ]) {
    assert.throws(() => parseMouseActions(actions), error, JSON.stringify(actions));
  }
});

test('toAbs puts each pixel at its center on the 0 to 0x7fff axis', () => {
  assert.equal(toAbs(0, 1920), 8);
  assert.equal(toAbs(959, 1920), 16375);
  assert.equal(toAbs(1919, 1920), 0x7fff - 8);
  assert.equal(toAbs(0, 1), 0x4000);
  // The pixel that the guest maps the value back to is the same one.
  for (const size of [640, 1366, 1920, 3840]) {
    for (let pixel = 0; pixel < size; pixel += 1) {
      assert.equal(Math.floor((toAbs(pixel, size) * size) / 0x8000), pixel);
    }
  }
});

// Fake QMP that logs each send as "abs x,y" or "+button"/"-button".
const recorder = ({ failOn } = {}) => {
  const log = [];
  let sessions = 0;
  let closed = 0;
  const connectQmp = async (socketPath) => {
    assert.equal(socketPath, '/vm/qmp.sock');
    sessions += 1;
    return {
      execute: async (command, { events }) => {
        assert.equal(command, 'input-send-event');
        if (events[0].type === 'abs') {
          log.push(`abs ${events[0].data.value},${events[1].data.value}`);
          return;
        }
        const entry = events.map(({ data }) => `${data.down ? '+' : '-'}${data.button}`).join(' ');
        if (entry === failOn) {
          throw new Error('QMP went away');
        }
        log.push(entry);
      },
      close: () => {
        closed += 1;
      }
    };
  };
  return { log, connectQmp, sessions: () => sessions, closed: () => closed };
};

const screen = { width: 1024, height: 768 };
const options = { dir: '/vm', screen };

test('runMouseActions sends every event at once, in one QMP session', async () => {
  const { log, connectQmp, sessions, closed } = recorder();
  await runMouseActions({
    ...options,
    connectQmp,
    actions: [
      { action: 'click', x: 512, y: 384, count: 2 },
      { action: 'down', button: 'right' },
      { action: 'up', button: 'right' },
      { action: 'scroll', dy: 2, dx: -1 }
    ]
  });
  assert.deepEqual(log, [
    'abs 16400,16405',
    '+left',
    '-left',
    '+left',
    '-left',
    '+right',
    '-right',
    '+wheel-down -wheel-down',
    '+wheel-down -wheel-down',
    '+wheel-left -wheel-left'
  ]);
  assert.equal(sessions(), 1);
  assert.equal(closed(), 1);
});

test('runMouseActions moves at once, and stops at the edge', async () => {
  const { log, connectQmp } = recorder();
  await runMouseActions({ ...options, connectQmp, actions: [{ action: 'move', x: 3000, y: 100 }] });
  assert.deepEqual(log, [`abs ${toAbs(1023, 1024)},${toAbs(100, 768)}`]);
});

test('runMouseActions stops at a failed event, and leaves any button as it is', async () => {
  const { log, connectQmp, closed } = recorder({ failOn: '+right' });
  await assert.rejects(
    runMouseActions({
      ...options,
      connectQmp,
      actions: [
        { action: 'down', button: 'left' },
        { action: 'down', button: 'right' },
        { action: 'up', button: 'left' }
      ]
    }),
    /went away/
  );
  assert.deepEqual(log, ['+left']);
  assert.equal(closed(), 1);
});

test('runMouseActions checks every action before it sends any event', async () => {
  let connected = false;
  const connectQmp = async () => {
    connected = true;
    return { execute: async () => {}, close: () => {} };
  };
  await assert.rejects(
    runMouseActions({ ...options, connectQmp, actions: [{ action: 'click' }, { action: 'jump' }] }),
    /Action 1/
  );
  assert.equal(connected, false);
});
