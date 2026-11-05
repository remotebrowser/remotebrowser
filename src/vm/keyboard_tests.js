import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TEXT_LENGTH, keyTiming, textToKeys, typeText } from './keyboard.js';

test('textToKeys maps a US keyboard, with Shift for upper case and symbols', () => {
  assert.deepEqual(textToKeys('aZ 1!'), [['a'], ['shift', 'z'], ['spc'], ['1'], ['shift', '1']]);
  assert.deepEqual(textToKeys('-_=+[{]}\\|;:\'"`~,<.>/?'), [
    ['minus'],
    ['shift', 'minus'],
    ['equal'],
    ['shift', 'equal'],
    ['bracket_left'],
    ['shift', 'bracket_left'],
    ['bracket_right'],
    ['shift', 'bracket_right'],
    ['backslash'],
    ['shift', 'backslash'],
    ['semicolon'],
    ['shift', 'semicolon'],
    ['apostrophe'],
    ['shift', 'apostrophe'],
    ['grave_accent'],
    ['shift', 'grave_accent'],
    ['comma'],
    ['shift', 'comma'],
    ['dot'],
    ['shift', 'dot'],
    ['slash'],
    ['shift', 'slash']
  ]);
  assert.deepEqual(
    textToKeys('@#$%^&*()'),
    [...'234567890'].map((digit) => ['shift', digit])
  );
});

test('textToKeys takes CRLF and CR as one Enter, and tabs', () => {
  assert.deepEqual(textToKeys('a\r\nb\rc\n\t'), [['a'], ['ret'], ['b'], ['ret'], ['c'], ['ret'], ['tab']]);
});

test('textToKeys refuses what a US keyboard cannot type', () => {
  assert.throws(() => textToKeys(42), /must be a string/);
  assert.throws(() => textToKeys(''), /empty/);
  assert.throws(() => textToKeys('x'.repeat(MAX_TEXT_LENGTH + 1)), /longer than/);
  assert.throws(() => textToKeys('café'), /cannot type: "é"/);
  assert.throws(() => textToKeys('hi 👋'), /cannot type: "👋"/);
  assert.equal(textToKeys('x'.repeat(MAX_TEXT_LENGTH)).length, MAX_TEXT_LENGTH);
});

test('keyTiming stays in a human range, slower after a word', () => {
  const sequence = (values) => {
    let index = 0;
    return () => values[index++ % values.length];
  };
  // Each draw at 0 means a pause too, of up to 800 ms more.
  for (const [value, maxGap] of [
    [0, 1100],
    [0.5, 300],
    [0.999, 300]
  ]) {
    const { holdMs, gapMs } = keyTiming({ keys: ['a'], random: () => value });
    assert.ok(holdMs >= 40 && holdMs <= 160, `hold ${holdMs}`);
    assert.ok(gapMs >= 30 && gapMs <= maxGap, `gap ${gapMs}`);
  }
  const letter = keyTiming({ keys: ['a'], random: sequence([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.9]) });
  const space = keyTiming({ keys: ['spc'], random: sequence([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.9]) });
  assert.ok(space.gapMs > letter.gapMs);
  // Now and then a longer pause.
  const pause = keyTiming({ keys: ['a'], random: sequence([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.01]) });
  assert.ok(pause.gapMs >= 300 + letter.gapMs - 1);
});

// Fake QMP that logs key events as "+key"/"-key", plus the waits between them.
const recorder = ({ failOn } = {}) => {
  const log = [];
  let sessions = 0;
  const connectQmp = async (socketPath) => {
    assert.equal(socketPath, '/vm/qmp.sock');
    sessions += 1;
    return {
      execute: async (command, { events }) => {
        assert.equal(command, 'input-send-event');
        for (const { type, data } of events) {
          assert.equal(type, 'key');
          assert.equal(data.key.type, 'qcode');
          const entry = `${data.down ? '+' : '-'}${data.key.data}`;
          if (entry === failOn) {
            failOn = undefined;
            throw new Error('QMP went away');
          }
          log.push(entry);
        }
      },
      close: () => {}
    };
  };
  const delay = async (ms) => log.push(ms);
  return { log, connectQmp, delay, sessions: () => sessions };
};

test('typeText presses and lets go of each key, with Shift around the key, one QMP session per char', async () => {
  const { log, connectQmp, delay, sessions } = recorder();
  await typeText({ dir: '/vm', text: 'Hi', connectQmp, random: () => 0.5, delay });
  const { holdMs, gapMs, leadMs, lagMs } = keyTiming({ keys: ['shift', 'h'], next: ['i'], random: () => 0.5 });
  const last = keyTiming({ keys: ['i'], random: () => 0.5 });
  assert.deepEqual(log, ['+shift', leadMs, '+h', holdMs, '-h', lagMs, '-shift', gapMs, '+i', last.holdMs, '-i']);
  assert.equal(sessions(), 2);
  assert.ok(leadMs > 0 && lagMs > 0);
  assert.equal(last.leadMs, 0);
});

test('typeText lets go of the keys that are down when a key event fails', async () => {
  const { log, connectQmp, delay } = recorder({ failOn: '-a' });
  await assert.rejects(typeText({ dir: '/vm', text: 'A', connectQmp, random: () => 0.5, delay }), /went away/);
  assert.deepEqual(
    log.filter((entry) => typeof entry === 'string'),
    ['+shift', '+a', '-a', '-shift']
  );
});

test('typeText checks the whole text before it presses any key', async () => {
  let connected = false;
  const connectQmp = async () => {
    connected = true;
    return { execute: async () => {}, close: () => {} };
  };
  await assert.rejects(typeText({ dir: '/vm', text: 'ok é', connectQmp }), /cannot type/);
  assert.equal(connected, false);
});
