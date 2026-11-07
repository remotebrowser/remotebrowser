// Minimal peer-to-peer D-Bus for QEMU's D-Bus display (cursor.js).
// See https://dbus.freedesktop.org/doc/dbus-specification.html.

const METHOD_CALL = 1;
const METHOD_RETURN = 2;
const ERROR = 3;
const NO_REPLY_EXPECTED = 1;

const FIELDS = {
  path: 1,
  interface: 2,
  member: 3,
  errorName: 4,
  replySerial: 5,
  destination: 6,
  sender: 7,
  signature: 8,
  unixFds: 9
};
const FIELD_TYPES = { 1: 'o', 2: 's', 3: 's', 4: 's', 5: 'u', 6: 's', 7: 's', 8: 'g', 9: 'u' };
const FIELD_NAMES = Object.fromEntries(Object.entries(FIELDS).map(([name, code]) => [code, name]));

const ALIGN = {
  'y': 1,
  'b': 4,
  'n': 2,
  'q': 2,
  'i': 4,
  'u': 4,
  'x': 8,
  't': 8,
  'd': 8,
  'h': 4,
  's': 4,
  'o': 4,
  'g': 1,
  'v': 1,
  'a': 4,
  '(': 8,
  '{': 8
};

// The end of the one complete type at `start` in a signature.
const typeEnd = (signature, start) => {
  const char = signature[start];
  if (char === 'a') {
    return typeEnd(signature, start + 1);
  }
  if (char === '(' || char === '{') {
    const close = char === '(' ? ')' : '}';
    let index = start + 1;
    while (signature[index] !== close) {
      if (index >= signature.length) {
        throw new Error(`Bad D-Bus signature: ${signature}`);
      }
      index = typeEnd(signature, index);
    }
    return index + 1;
  }
  if (!(char in ALIGN)) {
    throw new Error(`Bad D-Bus signature: ${signature}`);
  }
  return start + 1;
};

const splitSignature = (signature) => {
  const types = [];
  for (let index = 0; index < signature.length;) {
    const end = typeEnd(signature, index);
    types.push(signature.slice(index, end));
    index = end;
  }
  return types;
};

// Little endian. A variant is [signature, value], a dict [[key, value]], a struct an array.
class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(buffer) {
    this.chunks.push(buffer);
    this.length += buffer.length;
  }

  align(n) {
    const pad = (n - (this.length % n)) % n;
    if (pad) {
      this.push(Buffer.alloc(pad));
    }
  }

  fixed(size, write) {
    this.align(size);
    const buffer = Buffer.alloc(size);
    write(buffer);
    this.push(buffer);
  }

  write(type, value) {
    switch (type[0]) {
      case 'y':
        return this.push(Buffer.from([value]));
      case 'b':
        return this.fixed(4, (b) => b.writeUInt32LE(value ? 1 : 0));
      case 'n':
        return this.fixed(2, (b) => b.writeInt16LE(value));
      case 'q':
        return this.fixed(2, (b) => b.writeUInt16LE(value));
      case 'i':
        return this.fixed(4, (b) => b.writeInt32LE(value));
      case 'u':
      case 'h':
        return this.fixed(4, (b) => b.writeUInt32LE(value));
      case 'x':
        return this.fixed(8, (b) => b.writeBigInt64LE(BigInt(value)));
      case 't':
        return this.fixed(8, (b) => b.writeBigUInt64LE(BigInt(value)));
      case 'd':
        return this.fixed(8, (b) => b.writeDoubleLE(value));
      case 's':
      case 'o': {
        const text = Buffer.from(value, 'utf8');
        this.fixed(4, (b) => b.writeUInt32LE(text.length));
        this.push(text);
        return this.push(Buffer.alloc(1));
      }
      case 'g': {
        const text = Buffer.from(value, 'utf8');
        this.push(Buffer.from([text.length]));
        this.push(text);
        return this.push(Buffer.alloc(1));
      }
      case 'v': {
        const [signature, inner] = value;
        this.write('g', signature);
        return this.write(signature, inner);
      }
      case '(':
      case '{': {
        this.align(8);
        splitSignature(type.slice(1, -1)).forEach((member, index) => this.write(member, value[index]));
        return undefined;
      }
      case 'a': {
        const element = type.slice(1);
        if (element === 'y') {
          this.fixed(4, (b) => b.writeUInt32LE(value.length));
          return this.push(Buffer.from(value));
        }
        const lengthAt = this.length;
        this.fixed(4, () => {});
        this.align(ALIGN[element[0]]);
        const start = this.length;
        for (const item of value) {
          this.write(element, item);
        }
        this.lengthPatches = [
          ...(this.lengthPatches ?? []),
          [lengthAt + ((4 - (lengthAt % 4)) % 4), this.length - start]
        ];
        return undefined;
      }
      default:
        throw new Error(`Bad D-Bus type: ${type}`);
    }
  }

  toBuffer() {
    const buffer = Buffer.concat(this.chunks);
    for (const [at, length] of this.lengthPatches ?? []) {
      buffer.writeUInt32LE(length, at);
    }
    return buffer;
  }
}

// Reads values that `big` says are big or little endian.
class Reader {
  constructor(buffer, big = false) {
    this.buffer = buffer;
    this.offset = 0;
    this.big = big;
  }

  align(n) {
    this.offset += (n - (this.offset % n)) % n;
  }

  fixed(size, read) {
    this.align(size);
    const value = read(this.offset);
    this.offset += size;
    return value;
  }

  u32() {
    return this.fixed(4, (at) => (this.big ? this.buffer.readUInt32BE(at) : this.buffer.readUInt32LE(at)));
  }

  read(type) {
    const b = this.buffer;
    switch (type[0]) {
      case 'y':
        return b[this.offset++];
      case 'b':
        return this.u32() !== 0;
      case 'n':
        return this.fixed(2, (at) => (this.big ? b.readInt16BE(at) : b.readInt16LE(at)));
      case 'q':
        return this.fixed(2, (at) => (this.big ? b.readUInt16BE(at) : b.readUInt16LE(at)));
      case 'i':
        return this.fixed(4, (at) => (this.big ? b.readInt32BE(at) : b.readInt32LE(at)));
      case 'u':
      case 'h':
        return this.u32();
      case 'x':
        return this.fixed(8, (at) => (this.big ? b.readBigInt64BE(at) : b.readBigInt64LE(at)));
      case 't':
        return this.fixed(8, (at) => (this.big ? b.readBigUInt64BE(at) : b.readBigUInt64LE(at)));
      case 'd':
        return this.fixed(8, (at) => (this.big ? b.readDoubleBE(at) : b.readDoubleLE(at)));
      case 's':
      case 'o': {
        const length = this.u32();
        const text = b.toString('utf8', this.offset, this.offset + length);
        this.offset += length + 1;
        return text;
      }
      case 'g': {
        const length = b[this.offset++];
        const text = b.toString('utf8', this.offset, this.offset + length);
        this.offset += length + 1;
        return text;
      }
      case 'v': {
        const signature = this.read('g');
        return [signature, this.read(signature)];
      }
      case '(':
      case '{':
        this.align(8);
        return splitSignature(type.slice(1, -1)).map((member) => this.read(member));
      case 'a': {
        const length = this.u32();
        const element = type.slice(1);
        this.align(ALIGN[element[0]]);
        const end = this.offset + length;
        if (element === 'y') {
          const bytes = b.subarray(this.offset, end);
          this.offset = end;
          return bytes;
        }
        const items = [];
        while (this.offset < end) {
          items.push(this.read(element));
        }
        return items;
      }
      default:
        throw new Error(`Bad D-Bus type: ${type}`);
    }
  }
}

/**
 * One message, as bytes.
 * @param {{type: number, serial: number, flags?: number, path?: string, interface?: string, member?: string, errorName?: string, replySerial?: number, signature?: string, unixFds?: number, body?: unknown[]}} message
 */
const encodeMessage = ({ type, serial, flags = 0, signature = '', body = [], ...fields }) => {
  const bodyWriter = new Writer();
  splitSignature(signature).forEach((member, index) => bodyWriter.write(member, body[index]));
  const bodyBytes = bodyWriter.toBuffer();
  const headerFields = Object.entries({ ...fields, ...(signature ? { signature } : {}) })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [FIELDS[name], [FIELD_TYPES[FIELDS[name]], value]]);
  const header = new Writer();
  for (const value of [0x6c, type, flags, 1]) {
    header.write('y', value);
  }
  header.write('u', bodyBytes.length);
  header.write('u', serial);
  header.write('a(yv)', headerFields);
  header.align(8);
  return Buffer.concat([header.toBuffer(), bodyBytes]);
};

/**
 * The first complete message in `buffer` and its length, or null if incomplete.
 * @param {Buffer} buffer
 */
const decodeMessage = (buffer) => {
  if (buffer.length < 16) {
    return null;
  }
  const big = buffer[0] === 0x42;
  const reader = new Reader(buffer, big);
  reader.offset = 4;
  const bodyLength = reader.u32();
  reader.u32();
  const fieldsLength = reader.u32();
  const bodyStart = 16 + fieldsLength + ((8 - ((16 + fieldsLength) % 8)) % 8);
  const length = bodyStart + bodyLength;
  if (buffer.length < length) {
    return null;
  }
  const head = new Reader(buffer.subarray(0, bodyStart), big);
  head.offset = 4;
  head.u32();
  const serial = head.u32();
  const message = { type: buffer[1], flags: buffer[2], serial, signature: '', body: [] };
  for (const [code, [, value]] of head.read('a(yv)')) {
    if (FIELD_NAMES[code]) {
      message[FIELD_NAMES[code]] = value;
    }
  }
  const body = new Reader(buffer.subarray(bodyStart, length), big);
  message.body = splitSignature(message.signature).map((member) => body.read(member));
  return { message, length };
};

/**
 * A peer-to-peer client with fd passing; `onCall` returns a reply's [signature, body].
 * @param {import('node:net').Socket} socket
 * @param {{onCall?: (message: any) => [string, unknown[]] | undefined, uid?: number}} [options]
 */
const connectDbus = async (socket, { onCall, uid = process.getuid?.() ?? 0 } = {}) => {
  let buffer = Buffer.alloc(0);
  let serial = 0;
  /** @type {Map<number, {resolve: Function, reject: Function}>} */
  const pending = new Map();
  let lineWaiter = null;
  let authenticated = false;
  let closed = false;
  let closeError = null;
  const closeHandlers = [];

  const reply = (message, signature, body) => {
    serial += 1;
    socket.write(encodeMessage({ type: METHOD_RETURN, serial, replySerial: message.serial, signature, body }));
  };

  const dispatch = (message) => {
    if (message.type === METHOD_RETURN || message.type === ERROR) {
      const waiter = pending.get(message.replySerial);
      pending.delete(message.replySerial);
      if (message.type === ERROR) {
        waiter?.reject(new Error(`${message.errorName}: ${message.body[0] ?? ''}`));
      } else {
        waiter?.resolve(message.body);
      }
      return;
    }
    if (message.type !== METHOD_CALL) {
      return;
    }
    const [signature, body] = onCall?.(message) ?? ['', []];
    if (!(message.flags & NO_REPLY_EXPECTED)) {
      reply(message, signature, body);
    }
  };

  const fail = (error) => {
    if (closed) {
      return;
    }
    closed = true;
    closeError = error;
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
    lineWaiter?.reject(error);
    for (const handler of closeHandlers) {
      handler(error);
    }
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!authenticated) {
      const end = buffer.indexOf('\r\n');
      if (end >= 0 && lineWaiter) {
        const line = buffer.toString('utf8', 0, end);
        buffer = buffer.subarray(end + 2);
        const waiter = lineWaiter;
        lineWaiter = null;
        waiter.resolve(line);
      }
      return;
    }
    try {
      for (let decoded = decodeMessage(buffer); decoded; decoded = decodeMessage(buffer)) {
        buffer = buffer.subarray(decoded.length);
        dispatch(decoded.message);
      }
    } catch (error) {
      socket.destroy(error);
    }
  });
  socket.on('error', (error) => fail(error));
  socket.on('close', () => fail(new Error('D-Bus connection closed')));

  const readLine = () =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(closeError);
        return;
      }
      lineWaiter = { resolve, reject };
      socket.emit('data', Buffer.alloc(0));
    });

  socket.write(`\0AUTH EXTERNAL ${Buffer.from(String(uid)).toString('hex')}\r\n`);
  const ok = await readLine();
  if (!ok.startsWith('OK ')) {
    socket.destroy();
    throw new Error(`D-Bus authentication failed: ${ok}`);
  }
  socket.write('NEGOTIATE_UNIX_FD\r\n');
  const fds = await readLine();
  if (fds !== 'AGREE_UNIX_FD') {
    socket.destroy();
    throw new Error(`D-Bus peer cannot pass fds: ${fds}`);
  }
  socket.write('BEGIN\r\n');
  authenticated = true;
  if (buffer.length) {
    socket.emit('data', Buffer.alloc(0));
  }

  return {
    /**
     * A method call as bytes, to send with an fd, and the promise of its reply.
     * @param {{path: string, interface: string, member: string, signature?: string, body?: unknown[], unixFds?: number}} call
     */
    prepareCall: (call) => {
      serial += 1;
      const bytes = encodeMessage({ type: METHOD_CALL, serial, ...call });
      const replied = new Promise((resolve, reject) => {
        if (closed) {
          reject(closeError);
          return;
        }
        pending.set(serial, { resolve, reject });
      });
      return { bytes, replied };
    },
    /** @param {(error: Error) => void} handler */
    onClose: (handler) => {
      if (closed) {
        handler(closeError);
      } else {
        closeHandlers.push(handler);
      }
    },
    close: () => socket.destroy()
  };
};

export { connectDbus, decodeMessage, encodeMessage, splitSignature };
