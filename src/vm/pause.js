import { setTimeout as sleep } from 'node:timers/promises';

// Long enough for a human-like rhythm, short enough that a call still ends soon.
const MAX_PAUSE = 1000;
const MAX_TOTAL_PAUSE = 5000;

/**
 * Checks each action's optional pause, in milliseconds, and their sum.
 * @param {unknown[]} actions
 * @returns {number[]} the pause after each action, 0 if none
 */
const parsePauses = (actions) => {
  const pauses = actions.map((item, index) => {
    const pause = item && typeof item === 'object' ? (item.pause ?? 0) : 0;
    if (!Number.isInteger(pause) || pause < 0 || pause > MAX_PAUSE) {
      throw new Error(`Action ${index} needs a pause from 0 to ${MAX_PAUSE}, in whole milliseconds`);
    }
    return pause;
  });
  if (pauses.reduce((sum, pause) => sum + pause, 0) > MAX_TOTAL_PAUSE) {
    throw new Error(`The pauses add up to more than ${MAX_TOTAL_PAUSE} milliseconds`);
  }
  return pauses;
};

export { MAX_PAUSE, MAX_TOTAL_PAUSE, parsePauses, sleep };
