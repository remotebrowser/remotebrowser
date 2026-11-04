import { connect } from 'node:net';

// A small VNC client (RFB 3.8, no security), for QEMU's own VNC server,
// which only listens on the host's loopback.

// Reads exact byte counts from the socket, in order.
const openReader = (socket, timeoutMs) => {
  let buffer = Buffer.alloc(0);
  /** @type {{size: number, resolve: (data: Buffer) => void, reject: (error: Error) => void} | null} */
  let waiting = null;
  /** @type {Error | null} */
  let failure = null;
  const pump = () => {
    if (waiting && buffer.length >= waiting.size) {
      const { size, resolve } = waiting;
      waiting = null;
      const data = buffer.subarray(0, size);
      buffer = buffer.subarray(size);
      resolve(data);
    } else if (waiting && failure) {
      const { reject } = waiting;
      waiting = null;
      reject(failure);
    }
  };
  const fail = (error) => {
    failure ??= error;
    socket.destroy();
    pump();
  };
  socket.setTimeout(timeoutMs, () => fail(new Error('VNC timed out')));
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('VNC closed the connection')));
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    pump();
  });
  /** @type {(size: number) => Promise<Buffer>} */
  const read = (size) =>
    new Promise((resolve, reject) => {
      waiting = { size, resolve, reject };
      pump();
    });
  return read;
};

// Opens a shared connection, so viewers that watch stay connected, and
// returns once the server has sent the first bytes of its init message.
const handshake = async (socket, read) => {
  if (!(await read(12)).subarray(0, 4).equals(Buffer.from('RFB '))) {
    throw new Error('not a VNC server');
  }
  socket.write('RFB 003.008\n');
  const types = await read((await read(1))[0]);
  if (!types.includes(1)) {
    throw new Error('VNC asks for a password');
  }
  socket.write(Buffer.from([1]));
  if ((await read(4)).readUInt32BE(0) !== 0) {
    throw new Error('VNC refused the connection');
  }
  socket.write(Buffer.from([1]));
};

const withVnc = async (port, timeoutMs, session) => {
  const socket = connect({ host: '127.0.0.1', port });
  const read = openReader(socket, timeoutMs);
  try {
    await handshake(socket, read);
    return await session(socket, read);
  } finally {
    socket.destroy();
  }
};

/**
 * Reads the size of the VNC screen on the host's loopback `port`. The
 * handshake ends with it, so it shows when the guest has set a new one.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{width: number, height: number}>}
 */
const readVncScreenSize = (port, timeoutMs) =>
  withVnc(port, timeoutMs, async (socket, read) => {
    const init = await read(4);
    return { width: init.readUInt16BE(0), height: init.readUInt16BE(2) };
  });

// 32 bits per pixel, red in the lowest byte, so the frame is RGBX in memory.
const SET_PIXEL_FORMAT = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]);
// Raw only, which every server has.
const SET_ENCODINGS = Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]);

/**
 * Reads the whole VNC screen on the host's loopback `port`, as RGBX pixels.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{width: number, height: number, data: Buffer}>}
 */
const readVncFrame = (port, timeoutMs) =>
  withVnc(port, timeoutMs, async (socket, read) => {
    const init = await read(24);
    const width = init.readUInt16BE(0);
    const height = init.readUInt16BE(2);
    await read(init.readUInt32BE(20));
    const request = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    request.writeUInt16BE(width, 6);
    request.writeUInt16BE(height, 8);
    socket.write(Buffer.concat([SET_PIXEL_FORMAT, SET_ENCODINGS, request]));
    const data = Buffer.alloc(width * height * 4);
    let covered = 0;
    while (covered < width * height) {
      const type = (await read(1))[0];
      if (type === 0) {
        const rects = (await read(3)).readUInt16BE(1);
        for (let i = 0; i < rects; i += 1) {
          const rect = await read(12);
          const [x, y, w, h] = [0, 2, 4, 6].map((offset) => rect.readUInt16BE(offset));
          if (rect.readInt32BE(8) !== 0 || x + w > width || y + h > height) {
            throw new Error('VNC sent a rectangle it was not asked for');
          }
          const pixels = await read(w * h * 4);
          for (let row = 0; row < h; row += 1) {
            pixels.copy(data, ((y + row) * width + x) * 4, row * w * 4, (row + 1) * w * 4);
          }
          covered += w * h;
        }
      } else if (type === 1) {
        await read((await read(5)).readUInt16BE(3) * 6);
      } else if (type === 3) {
        await read((await read(7)).readUInt32BE(3));
      } else if (type !== 2) {
        throw new Error(`VNC sent an unknown message ${type}`);
      }
    }
    return { width, height, data };
  });

export { readVncFrame, readVncScreenSize };
