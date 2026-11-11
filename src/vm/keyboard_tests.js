import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_KEY_ACTIONS, parseKeyActions, runKeyActions } from './keyboard.js';

test('parseKeyActions maps KeyboardEvent.code names to QEMU qcodes', () => {
  assert.deepEqual(
    parseKeyActions([
      { action: 'down', key: 'ControlLeft' },
      { action: 'press', key: 'KeyA' },
      { action: 'up', key: 'ControlLeft' },
      { action: 'press', key: 'Digit7' },
      { action: 'press', key: 'Numpad7' },
      { action: 'press', key: 'F12' },
      { action: 'press', key: 'ArrowDown' },
      { action: 'press', key: 'Enter' }
    ]),
    [
      { action: 'down', key: 'ctrl' },
      { action: 'press', key: 'a' },
      { action: 'up', key: 'ctrl' },
      { action: 'press', key: '7' },
      { action: 'press', key: 'kp_7' },
      { action: 'press', key: 'f12' },
      { action: 'press', key: 'down' },
      { action: 'press', key: 'ret' }
    ]
  );
});

test('parseKeyActions says which action is wrong, and why', () => {
  for (const [actions, error] of [
    [undefined, /must be a list/],
    [[], /empty/],
    [Array(MAX_KEY_ACTIONS + 1).fill({ action: 'press', key: 'KeyA' }), /more than 50/],
    [['KeyA'], /Action 0 must be an object/],
    [[{ action: 'type', key: 'KeyA' }], /Action 0 must be one of: down, up, press$/],
    [[{ action: 'press', key: 'KeyA', count: 2 }], /unknown field: count/],
    [[{ action: 'press', key: 'KeyA' }, { action: 'press' }], /Action 1 needs a key named as KeyboardEvent.code/],
    [[{ action: 'press', key: 'a' }], /needs a key/],
    [[{ action: 'press', key: 'Shift' }], /needs a key/],
    [[{ action: 'press', key: 'constructor' }], /needs a key/],
    [[{ action: 'press', key: 13 }], /needs a key/]
  ]) {
    assert.throws(() => parseKeyActions(actions), error, JSON.stringify(actions));
  }
});

// Fake QMP that logs each key event as "+qcode" or "-qcode".
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
        const entry = events.map(({ data }) => `${data.down ? '+' : '-'}${data.key.data}`).join(' ');
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

test('runKeyActions sends every event at once, in one QMP session', async () => {
  const { log, connectQmp, sessions, closed } = recorder();
  await runKeyActions({
    dir: '/vm',
    connectQmp,
    actions: [
      { action: 'down', key: 'ControlLeft' },
      { action: 'down', key: 'ShiftLeft' },
      { action: 'press', key: 'KeyT' },
      { action: 'up', key: 'ShiftLeft' },
      { action: 'up', key: 'ControlLeft' }
    ]
  });
  assert.deepEqual(log, ['+ctrl', '+shift', '+t', '-t', '-shift', '-ctrl']);
  assert.equal(sessions(), 1);
  assert.equal(closed(), 1);
});

test('runKeyActions leaves a key down at the end, for a click with it', async () => {
  const { log, connectQmp } = recorder();
  await runKeyActions({ dir: '/vm', connectQmp, actions: [{ action: 'down', key: 'ControlLeft' }] });
  await runKeyActions({ dir: '/vm', connectQmp, actions: [{ action: 'up', key: 'ControlLeft' }] });
  assert.deepEqual(log, ['+ctrl', '-ctrl']);
});

test('runKeyActions lets go of the keys it pressed when a key event fails', async () => {
  const { log, connectQmp, closed } = recorder({ failOn: '+a' });
  await assert.rejects(
    runKeyActions({
      dir: '/vm',
      connectQmp,
      actions: [
        { action: 'down', key: 'ControlLeft' },
        { action: 'down', key: 'ShiftLeft' },
        { action: 'press', key: 'KeyA' }
      ]
    }),
    /went away/
  );
  assert.deepEqual(log, ['+ctrl', '+shift', '-shift -ctrl']);
  assert.equal(closed(), 1);
});

test('runKeyActions checks every action before it sends any event', async () => {
  let connected = false;
  const connectQmp = async () => {
    connected = true;
    return { execute: async () => {}, close: () => {} };
  };
  await assert.rejects(
    runKeyActions({
      dir: '/vm',
      connectQmp,
      actions: [
        { action: 'press', key: 'KeyA' },
        { action: 'press', key: 'Hyper' }
      ]
    }),
    /Action 1/
  );
  assert.equal(connected, false);
});
