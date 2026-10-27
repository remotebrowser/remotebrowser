import { connect } from 'node:net';

// The VNC handshake (RFB 3.8, no security) ends with the screen size, so it
// shows when the guest has set a new one.

/**
 * Reads the size of the VNC screen on the host's loopback `port`.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{width: number, height: number}>}
 */
const readVncScreenSize = (port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    let step = 'version';
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('VNC timed out')));
    socket.once('error', fail);
    socket.once('close', () => reject(new Error('VNC closed the connection')));
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (step === 'version' && buffer.length >= 12) {
        if (!buffer.subarray(0, 4).equals(Buffer.from('RFB '))) {
          fail(new Error('not a VNC server'));
          return;
        }
        buffer = buffer.subarray(12);
        socket.write('RFB 003.008\n');
        step = 'security';
      }
      if (step === 'security' && buffer.length >= 1 && buffer.length >= 1 + buffer[0]) {
        const types = buffer.subarray(1, 1 + buffer[0]);
        if (!types.includes(1)) {
          fail(new Error('VNC asks for a password'));
          return;
        }
        buffer = buffer.subarray(1 + buffer[0]);
        socket.write(Buffer.from([1]));
        step = 'result';
      }
      if (step === 'result' && buffer.length >= 4) {
        if (buffer.readUInt32BE(0) !== 0) {
          fail(new Error('VNC refused the connection'));
          return;
        }
        buffer = buffer.subarray(4);
        // Shared, so viewers that watch stay connected.
        socket.write(Buffer.from([1]));
        step = 'init';
      }
      if (step === 'init' && buffer.length >= 4) {
        socket.destroy();
        resolve({ width: buffer.readUInt16BE(0), height: buffer.readUInt16BE(2) });
      }
    });
  });

export { readVncScreenSize };
