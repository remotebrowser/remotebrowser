// Open CDP sessions of the REST API re-check their key every minute. A route that
// just revoked keys asks for a check at once, so the sessions end now instead of
// within the minute.

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * @param {() => void} listener
 * @returns {() => void} stops listening
 */
const onRecheckApiSessions = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const recheckApiSessions = () => {
  for (const listener of listeners) {
    listener();
  }
};

export { onRecheckApiSessions, recheckApiSessions };
