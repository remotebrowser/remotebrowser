import path from 'node:path';
import { delay } from './host.js';

/**
 * Writes `content` into a guest file through the guest agent. The agent may
 * not answer yet right after the VM starts, so this retries, and throws the
 * last error.
 * @param {{dir: string, file: string, content: Buffer, connectQmp: Function, attempts?: number}} params
 */
const writeGuestFile = async ({ dir, file, content, connectQmp, attempts = 20 }) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const agent = await connectQmp(path.join(dir, 'qga.sock'), { agent: true, timeoutMs: 3000 });
      try {
        const handle = await agent.execute('guest-file-open', { path: file, mode: 'w' });
        try {
          const { count } = await agent.execute('guest-file-write', {
            handle,
            'buf-b64': content.toString('base64')
          });
          if (count !== content.length) {
            throw new Error(`wrote ${count} of ${content.length} bytes`);
          }
        } finally {
          await agent.execute('guest-file-close', { handle });
        }
        return;
      } finally {
        agent.close();
      }
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await delay(500);
      }
    }
  }
  throw lastError;
};

export { writeGuestFile };
