import path from 'node:path';

// Enough for a few shortcuts, short enough to finish soon.
const MAX_KEY_ACTIONS = 50;

// KeyboardEvent.code names, as they do not change with the layout, like QEMU's qcodes.
/** @type {Map<string, string>} */
const KEYS = new Map([
  ['Enter', 'ret'],
  ['Escape', 'esc'],
  ['Backspace', 'backspace'],
  ['Tab', 'tab'],
  ['Space', 'spc'],
  ['Minus', 'minus'],
  ['Equal', 'equal'],
  ['BracketLeft', 'bracket_left'],
  ['BracketRight', 'bracket_right'],
  ['Backslash', 'backslash'],
  ['Semicolon', 'semicolon'],
  ['Quote', 'apostrophe'],
  ['Backquote', 'grave_accent'],
  ['Comma', 'comma'],
  ['Period', 'dot'],
  ['Slash', 'slash'],
  ['IntlBackslash', 'less'],
  ['CapsLock', 'caps_lock'],
  ['ShiftLeft', 'shift'],
  ['ShiftRight', 'shift_r'],
  ['ControlLeft', 'ctrl'],
  ['ControlRight', 'ctrl_r'],
  ['AltLeft', 'alt'],
  ['AltRight', 'alt_r'],
  ['MetaLeft', 'meta_l'],
  ['MetaRight', 'meta_r'],
  ['ContextMenu', 'menu'],
  ['Insert', 'insert'],
  ['Delete', 'delete'],
  ['Home', 'home'],
  ['End', 'end'],
  ['PageUp', 'pgup'],
  ['PageDown', 'pgdn'],
  ['ArrowUp', 'up'],
  ['ArrowDown', 'down'],
  ['ArrowLeft', 'left'],
  ['ArrowRight', 'right'],
  ['PrintScreen', 'print'],
  ['ScrollLock', 'scroll_lock'],
  ['Pause', 'pause'],
  ['NumLock', 'num_lock'],
  ['NumpadAdd', 'kp_add'],
  ['NumpadSubtract', 'kp_subtract'],
  ['NumpadMultiply', 'kp_multiply'],
  ['NumpadDivide', 'kp_divide'],
  ['NumpadDecimal', 'kp_decimal'],
  ['NumpadEnter', 'kp_enter'],
  ['NumpadEqual', 'kp_equals']
]);
for (let code = 0; code < 26; code += 1) {
  const letter = String.fromCharCode(97 + code);
  KEYS.set(`Key${letter.toUpperCase()}`, letter);
}
for (let digit = 0; digit < 10; digit += 1) {
  KEYS.set(`Digit${digit}`, String(digit));
  KEYS.set(`Numpad${digit}`, `kp_${digit}`);
}
for (let number = 1; number <= 12; number += 1) {
  KEYS.set(`F${number}`, `f${number}`);
}

const ACTIONS = ['down', 'up', 'press'];

/**
 * Validates key actions and maps each key to its QEMU qcode; errors name the index.
 * @param {unknown} actions
 * @returns {{action: string, key: string}[]}
 */
const parseKeyActions = (actions) => {
  if (!Array.isArray(actions)) {
    throw new Error('The actions must be a list');
  }
  if (actions.length === 0) {
    throw new Error('The actions are empty');
  }
  if (actions.length > MAX_KEY_ACTIONS) {
    throw new Error(`There are more than ${MAX_KEY_ACTIONS} actions`);
  }
  return actions.map((item, index) => {
    const where = `Action ${index}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${where} must be an object`);
    }
    const { action, key } = item;
    if (typeof action !== 'string' || !ACTIONS.includes(action)) {
      throw new Error(`${where} must be one of: ${ACTIONS.join(', ')}`);
    }
    const unknown = Object.keys(item).find((field) => field !== 'action' && field !== 'key');
    if (unknown) {
      throw new Error(`${where} has an unknown field: ${unknown}`);
    }
    const qcode = typeof key === 'string' ? KEYS.get(key) : undefined;
    if (!qcode) {
      throw new Error(`${where} needs a key named as KeyboardEvent.code, such as KeyA, Enter, or ShiftLeft`);
    }
    return { action, key: qcode };
  });
};

const keyEvent = (qcode, down) => ({ type: 'key', data: { down, key: { type: 'qcode', data: qcode } } });

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

/**
 * Sends every event at once. Keys still down at the end stay down, for a
 * Ctrl+click with the mouse; the caller lets go of them.
 * @param {{dir: string, actions: unknown, connectQmp: Function}} params
 */
const runKeyActions = async ({ dir, actions, connectQmp }) => {
  const parsed = parseKeyActions(actions);
  const socket = path.join(dir, 'qmp.sock');
  const qmp = await connectQmp(socket);
  /** @type {string[]} */
  const down = [];
  const send = async (qcode, isDown) => {
    await qmp.execute('input-send-event', { events: [keyEvent(qcode, isDown)] });
    if (isDown) {
      down.push(qcode);
    } else if (down.includes(qcode)) {
      down.splice(down.lastIndexOf(qcode), 1);
    }
  };
  try {
    for (const { action, key } of parsed) {
      if (action === 'down' || action === 'press') {
        await send(key, true);
      }
      if (action === 'up' || action === 'press') {
        await send(key, false);
      }
    }
  } catch (error) {
    // A key left down by a failed call would repeat until someone lets go of it.
    if (down.length > 0) {
      await releaseKeys({ qmp, socket, keys: down.toReversed(), connectQmp });
    }
    throw error;
  } finally {
    qmp.close();
  }
};

export { MAX_KEY_ACTIONS, parseKeyActions, runKeyActions };
