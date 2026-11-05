import path from 'node:path';
import { delay as hostDelay } from './host.js';

// Enough for a form field, short enough to finish in about a minute.
const MAX_TEXT_LENGTH = 500;

const SHIFTED_DIGITS = ')!@#$%^&*(';
// US layout: each key's char, then the char with Shift.
const PUNCTUATION = [
  ['minus', '-', '_'],
  ['equal', '=', '+'],
  ['bracket_left', '[', '{'],
  ['bracket_right', ']', '}'],
  ['backslash', '\\', '|'],
  ['semicolon', ';', ':'],
  ['apostrophe', "'", '"'],
  ['grave_accent', '`', '~'],
  ['comma', ',', '<'],
  ['dot', '.', '>'],
  ['slash', '/', '?']
];

/** @type {Map<string, string[]>} */
const KEYS = new Map([
  [' ', ['spc']],
  ['\n', ['ret']],
  ['\t', ['tab']]
]);
for (let code = 0; code < 26; code += 1) {
  const letter = String.fromCharCode(97 + code);
  KEYS.set(letter, [letter]);
  KEYS.set(letter.toUpperCase(), ['shift', letter]);
}
for (let digit = 0; digit < 10; digit += 1) {
  KEYS.set(String(digit), [String(digit)]);
  KEYS.set(SHIFTED_DIGITS[digit], ['shift', String(digit)]);
}
for (const [qcode, plain, shifted] of PUNCTUATION) {
  KEYS.set(plain, [qcode]);
  KEYS.set(shifted, ['shift', qcode]);
}

/**
 * Maps each char to QEMU qcodes; CR and CRLF become Enter, as pasted text may have them.
 * @param {unknown} text
 * @returns {string[][]}
 */
const textToKeys = (text) => {
  if (typeof text !== 'string') {
    throw new Error('The text must be a string');
  }
  const chars = Array.from(text.replace(/\r\n?/g, '\n'));
  if (chars.length === 0) {
    throw new Error('The text is empty');
  }
  if (chars.length > MAX_TEXT_LENGTH) {
    throw new Error(`The text is longer than ${MAX_TEXT_LENGTH} characters`);
  }
  return chars.map((char) => {
    const keys = KEYS.get(char);
    if (!keys) {
      throw new Error(`The text has a character that a US keyboard cannot type: ${JSON.stringify(char)}`);
    }
    return keys;
  });
};

// Roughly normal, from the sum of uniform draws, so it needs no extra math.
const normal = (random, mean, spread) => mean + (random() + random() + random() - 1.5) * spread;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Human-like key timing in ms: about 40-70 wpm, slower at word ends and before Shift.
 * @param {{keys: string[], next?: string[], random?: () => number}} params
 * @returns {{holdMs: number, gapMs: number, leadMs: number, lagMs: number}}
 */
const keyTiming = ({ keys, next, random = Math.random }) => {
  const holdMs = Math.round(clamp(normal(random, 85, 50), 40, 160));
  let gapMs = clamp(normal(random, 110, 120), 30, 300);
  const qcode = keys.at(-1);
  if (qcode === 'spc' || qcode === 'ret' || qcode === 'tab' || PUNCTUATION.some(([key]) => key === qcode)) {
    gapMs += random() * 150;
  }
  if (next?.[0] === 'shift') {
    gapMs += random() * 80;
  }
  if (random() < 0.04) {
    gapMs += 300 + random() * 500;
  }
  const leadMs = keys.length > 1 ? Math.round(20 + random() * 50) : 0;
  const lagMs = keys.length > 1 ? Math.round(10 + random() * 40) : 0;
  return { holdMs, gapMs: Math.round(gapMs), leadMs, lagMs };
};

const keyEvent = (qcode, down) => ({ type: 'key', data: { down, key: { type: 'qcode', data: qcode } } });

/**
 * One QMP session per key, as QEMU serves only one at a time and a suspend must not wait.
 * @param {{dir: string, text: string, connectQmp: Function, random?: () => number, delay?: (ms: number) => Promise<unknown>}} params
 */
const typeText = async ({ dir, text, connectQmp, random = Math.random, delay = hostDelay }) => {
  const presses = textToKeys(text);
  const socket = path.join(dir, 'qmp.sock');
  for (const [index, keys] of presses.entries()) {
    const { holdMs, gapMs, leadMs, lagMs } = keyTiming({ keys, next: presses[index + 1], random });
    const [key, ...modifiers] = keys.toReversed();
    /** @type {string[]} */
    const down = [];
    const qmp = await connectQmp(socket);
    const send = async (qcode, isDown) => {
      await qmp.execute('input-send-event', { events: [keyEvent(qcode, isDown)] });
      if (isDown) {
        down.push(qcode);
      } else {
        down.splice(down.lastIndexOf(qcode), 1);
      }
    };
    try {
      for (const modifier of modifiers.toReversed()) {
        await send(modifier, true);
        await delay(leadMs);
      }
      await send(key, true);
      await delay(holdMs);
      await send(key, false);
      for (const modifier of modifiers) {
        await delay(lagMs);
        await send(modifier, false);
      }
    } finally {
      // A key left down would repeat, and a stuck Shift would change every later key.
      if (down.length > 0) {
        await releaseKeys({ qmp, socket, keys: down.toReversed(), connectQmp });
      }
      qmp.close();
    }
    if (index < presses.length - 1) {
      await delay(gapMs);
    }
  }
};

// Best effort, so the original error is what shows.
const releaseKeys = async ({ qmp, socket, keys, connectQmp }) => {
  const events = keys.map((qcode) => keyEvent(qcode, false));
  try {
    await qmp.execute('input-send-event', { events });
  } catch {
    const fresh = await connectQmp(socket).catch(() => null);
    await fresh?.execute('input-send-event', { events }).catch(() => {});
    fresh?.close();
  }
};

export { MAX_TEXT_LENGTH, keyTiming, textToKeys, typeText };
