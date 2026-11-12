// Runs at most `max` of the given tasks at once; the rest wait their turn, in
// order. A VM start is CPU-heavy, and when many start together none of them
// get far enough to answer in time.
const createLimit = (max) => {
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  const next = () => {
    active -= 1;
    waiting.shift()?.();
  };
  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  const run = async (task) => {
    if (active >= max) {
      // The slot passes straight to this task, so `active` stays the same.
      await new Promise((resolve) => waiting.push(() => resolve(undefined)));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      next();
    }
  };
  run.pending = () => waiting.length;
  return run;
};

export { createLimit };
