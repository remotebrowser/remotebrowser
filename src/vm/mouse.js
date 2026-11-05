import path from 'node:path';

// Enough for a drag or a few clicks and scrolls, short enough to finish soon.
const MAX_MOUSE_ACTIONS = 50;
// The largest screen (screen-resolution.js); points past an edge stop there.
const MAX_X = 3839;
const MAX_Y = 2159;
const MAX_SCROLL = 20;
const MAX_CLICKS = 3;
// QEMU's absolute axis goes from 0 to 0x7fff, over the whole screen.
const ABS_RANGE = 0x8000;

// QEMU's names for the buttons. Back and forward are the side buttons.
const BUTTONS = new Map([
  ['left', 'left'],
  ['middle', 'middle'],
  ['right', 'right'],
  ['back', 'side'],
  ['forward', 'extra']
]);

// Each action and its fields. Each may have a point to move to first.
const FIELDS = {
  move: ['x', 'y'],
  down: ['x', 'y', 'button'],
  up: ['x', 'y', 'button'],
  click: ['x', 'y', 'button', 'count'],
  scroll: ['x', 'y', 'dx', 'dy']
};

const wholeIn = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

/**
 * Validates mouse actions and maps buttons to QEMU's names; errors name the index.
 * @param {unknown} actions
 * @returns {{action: string, x?: number, y?: number, button?: string, count?: number, dx?: number, dy?: number}[]}
 */
const parseMouseActions = (actions) => {
  if (!Array.isArray(actions)) {
    throw new Error('The actions must be a list');
  }
  if (actions.length === 0) {
    throw new Error('The actions are empty');
  }
  if (actions.length > MAX_MOUSE_ACTIONS) {
    throw new Error(`There are more than ${MAX_MOUSE_ACTIONS} actions`);
  }
  return actions.map((item, index) => {
    const where = `Action ${index}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${where} must be an object`);
    }
    const { action } = item;
    if (typeof action !== 'string' || !Object.hasOwn(FIELDS, action)) {
      throw new Error(`${where} must be one of: ${Object.keys(FIELDS).join(', ')}`);
    }
    const unknown = Object.keys(item).find((key) => key !== 'action' && !FIELDS[action].includes(key));
    if (unknown) {
      throw new Error(`${where} has an unknown field: ${unknown}`);
    }
    const parsed = { action };
    if ('x' in item || 'y' in item || action === 'move') {
      if (!wholeIn(item.x, 0, MAX_X) || !wholeIn(item.y, 0, MAX_Y)) {
        throw new Error(`${where} needs x from 0 to ${MAX_X} and y from 0 to ${MAX_Y}, in whole pixels`);
      }
      Object.assign(parsed, { x: item.x, y: item.y });
    }
    if (FIELDS[action].includes('button')) {
      const button = BUTTONS.get(item.button ?? 'left');
      if (!button) {
        throw new Error(`${where} has a button that is not one of: ${[...BUTTONS.keys()].join(', ')}`);
      }
      parsed.button = button;
    }
    if (action === 'click') {
      const count = item.count ?? 1;
      if (!wholeIn(count, 1, MAX_CLICKS)) {
        throw new Error(`${where} needs a count from 1 to ${MAX_CLICKS}`);
      }
      parsed.count = count;
    }
    if (action === 'scroll') {
      const dx = item.dx ?? 0;
      const dy = item.dy ?? 0;
      if (!wholeIn(dx, -MAX_SCROLL, MAX_SCROLL) || !wholeIn(dy, -MAX_SCROLL, MAX_SCROLL) || (dx === 0 && dy === 0)) {
        throw new Error(`${where} needs dx or dy, in whole wheel steps from -${MAX_SCROLL} to ${MAX_SCROLL}`);
      }
      Object.assign(parsed, { dx, dy });
    }
    return parsed;
  });
};

/**
 * The pixel's center on QEMU's absolute axis.
 * @param {number} pixel
 * @param {number} size
 */
const toAbs = (pixel, size) => Math.min(ABS_RANGE - 1, Math.floor(((pixel + 0.5) * ABS_RANGE) / size));

const absEvents = ({ x, y }, screen) => [
  { type: 'abs', data: { axis: 'x', value: toAbs(x, screen.width) } },
  { type: 'abs', data: { axis: 'y', value: toAbs(y, screen.height) } }
];

const btnEvent = (button, down) => ({ type: 'btn', data: { down, button } });

// QEMU takes a wheel step as a button that is pressed and let go.
const wheelSteps = ({ dx, dy }) => [
  ...Array(Math.abs(dy)).fill(dy > 0 ? 'wheel-down' : 'wheel-up'),
  ...Array(Math.abs(dx)).fill(dx > 0 ? 'wheel-right' : 'wheel-left')
];

/**
 * Sends every event at once; timing and letting go of buttons are up to the caller.
 * @param {{dir: string, actions: unknown, screen: {width: number, height: number}, connectQmp: Function}} params
 */
const runMouseActions = async ({ dir, actions, screen, connectQmp }) => {
  const parsed = parseMouseActions(actions);
  const qmp = await connectQmp(path.join(dir, 'qmp.sock'));
  const send = (events) => qmp.execute('input-send-event', { events });
  try {
    for (const action of parsed) {
      if (action.x !== undefined && action.y !== undefined) {
        const x = Math.min(action.x, screen.width - 1);
        const y = Math.min(action.y, screen.height - 1);
        await send(absEvents({ x, y }, screen));
      }
      if (action.action === 'down' || action.action === 'up') {
        await send([btnEvent(action.button, action.action === 'down')]);
      } else if (action.action === 'click') {
        // Separate sends, so the guest sees each press and release.
        for (let click = 0; click < action.count; click += 1) {
          await send([btnEvent(action.button, true)]);
          await send([btnEvent(action.button, false)]);
        }
      } else if (action.action === 'scroll') {
        for (const wheel of wheelSteps(action)) {
          await send([btnEvent(wheel, true), btnEvent(wheel, false)]);
        }
      }
    }
  } finally {
    qmp.close();
  }
};

export { MAX_MOUSE_ACTIONS, parseMouseActions, runMouseActions, toAbs };
