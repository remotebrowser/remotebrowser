import { parentPort } from 'node:worker_threads';
import { validateCode } from './harness-check.js';

// One check per message. The parent ends this worker when a check runs too long.
parentPort.on('message', ({ id, answer, own }) => {
  parentPort.postMessage({ id, result: validateCode(answer, { own }) });
});
