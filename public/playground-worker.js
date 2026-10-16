// Runs user code away from the page that hosts the playground. The API is
// intentionally small: one page, a few common actions, and raw CDP access.

const DEFAULT_TIMEOUT = 30000;
const POLL_INTERVAL = 100;

const post = (message) => self.postMessage(message);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) {
          request.reject(new Error(`${request.method}: ${message.error.message}`));
        } else {
          request.resolve(message.result);
        }
        return;
      }
      for (const listener of this.listeners) listener(message);
    };

    socket.onclose = () => {
      for (const request of this.pending.values()) {
        request.reject(new Error('The browser connection was closed.'));
      }
      this.pending.clear();
    };
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      let settled = false;
      socket.onopen = () => {
        settled = true;
        resolve(new CdpConnection(socket));
      };
      socket.onerror = () => {
        settled = true;
        reject(new Error('Unable to connect to the browser.'));
      };
      socket.onclose = () => {
        if (!settled) reject(new Error('The browser connection was closed.'));
      };
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('The browser connection is closed.'));
        return;
      }
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitFor(sessionId, method, timeout) {
    let cancel = () => {};
    const promise = new Promise((resolve, reject) => {
      const listener = (message) => {
        if (message.method === method && message.sessionId === sessionId) {
          cancel();
          resolve(message.params);
        }
      };
      const timer = setTimeout(() => {
        cancel();
        reject(new Error(`Timed out after ${timeout} ms waiting for ${method}.`));
      }, timeout);
      cancel = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      this.listeners.add(listener);
    });
    return { promise, cancel };
  }

  close() {
    this.socket.close();
  }
}

const callExpression = (fn, ...args) => {
  const source = typeof fn === 'function' ? fn.toString() : String(fn);
  const values = args.map((arg) => (arg === undefined ? 'undefined' : JSON.stringify(arg)));
  return `(${source})(${values.join(', ')})`;
};

const KEYS = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 }
};

class Page {
  constructor(connection, targetId, sessionId, url) {
    this.connection = connection;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.currentUrl = url;

    connection.listeners.add((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) {
        this.currentUrl = message.params.frame.url;
      } else if (message.method === 'Page.navigatedWithinDocument') {
        this.currentUrl = message.params.url;
      }
    });
  }

  show() {
    post({ type: 'page', pageId: this.targetId });
  }

  cdp(method, params = {}) {
    return this.connection.send(method, params, this.sessionId);
  }

  url() {
    return this.currentUrl;
  }

  async goto(url, { waitUntil = 'load', timeout = DEFAULT_TIMEOUT } = {}) {
    this.show();
    const event = waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';
    const loaded = this.connection.waitFor(this.sessionId, event, timeout);
    let result;
    try {
      result = await this.cdp('Page.navigate', { url });
    } catch (error) {
      loaded.cancel();
      throw error;
    }
    if (result.errorText) {
      loaded.cancel();
      throw new Error(`${result.errorText} at ${url}`);
    }
    if (!result.loaderId) {
      loaded.cancel();
      return;
    }
    await loaded.promise;
  }

  async evaluate(fn, arg) {
    const expression = typeof fn === 'function' ? callExpression(fn, arg) : String(fn);
    const { result, exceptionDetails } = await this.cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    }
    return result.value;
  }

  title() {
    return this.evaluate('document.title');
  }

  content() {
    return this.evaluate('document.documentElement.outerHTML');
  }

  $eval(selector, fn, arg) {
    const source = typeof fn === 'function' ? fn.toString() : String(fn);
    return this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error(${JSON.stringify(`No element matches ${selector}.`)});
      return (${source})(element, ${arg === undefined ? 'undefined' : JSON.stringify(arg)});
    })()`);
  }

  $$eval(selector, fn, arg) {
    const source = typeof fn === 'function' ? fn.toString() : String(fn);
    return this.evaluate(
      `(${source})([...document.querySelectorAll(${JSON.stringify(selector)})], ${arg === undefined ? 'undefined' : JSON.stringify(arg)})`
    );
  }

  async waitForSelector(selector, { timeout = DEFAULT_TIMEOUT } = {}) {
    const deadline = Date.now() + timeout;
    const visible = `((element) => Boolean(element) && element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden')(document.querySelector(${JSON.stringify(selector)}))`;
    while (!(await this.evaluate(visible))) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeout} ms waiting for ${selector}.`);
      }
      await sleep(POLL_INTERVAL);
    }
  }

  async click(selector, options) {
    await this.waitForSelector(selector, options);
    const { x, y } = await this.$eval(selector, (element) => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    this.show();
    const fields = { x, y, button: 'left', clickCount: 1 };
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...fields });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...fields });
  }

  async fill(selector, value, options) {
    await this.waitForSelector(selector, options);
    await this.$eval(selector, (element) => {
      element.focus();
      if (typeof element.select === 'function') element.select();
    });
    if (value === '') {
      await this.press(selector, 'Delete', options);
    } else {
      await this.cdp('Input.insertText', { text: String(value) });
    }
  }

  async press(selector, key, options) {
    await this.waitForSelector(selector, options);
    await this.$eval(selector, (element) => element.focus());
    this.show();
    const known = KEYS[key];
    const fields = known ? { key, ...known } : { key, text: key };
    await this.cdp('Input.dispatchKeyEvent', { type: fields.text ? 'keyDown' : 'rawKeyDown', ...fields });
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...fields, text: undefined });
  }

  textContent(selector) {
    return this.$eval(selector, (element) => element.textContent);
  }

  innerText(selector) {
    return this.$eval(selector, (element) => element.innerText);
  }

  waitForTimeout(ms) {
    return sleep(ms);
  }

  async screenshot({ fullPage = false } = {}) {
    this.show();
    const { data } = await this.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    post({ type: 'image', data });
    return data;
  }
}

const openPage = async (connection) => {
  const { targetInfos } = await connection.send('Target.getTargets');
  let target = targetInfos.find((info) => info.type === 'page');
  if (!target) {
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
    target = { targetId, url: 'about:blank' };
  }
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const page = new Page(connection, target.targetId, sessionId, target.url);
  await page.cdp('Page.enable');
  page.show();
  return page;
};

const format = (value) => {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const log =
  (level) =>
  (...args) =>
    post({ type: 'log', level, text: args.map(format).join(' ') });

const sandboxConsole = {
  log: log('log'),
  info: log('info'),
  warn: log('warn'),
  error: log('error')
};

const AsyncFunction = (async () => {}).constructor;

const run = async ({ code, cdpUrl }) => {
  let connection;
  try {
    const program = new AsyncFunction('page', 'console', code);
    connection = await CdpConnection.connect(cdpUrl);
    const page = await openPage(connection);
    const result = await program(page, sandboxConsole);
    post({ type: 'done', result: result === undefined ? undefined : format(result) });
  } catch (error) {
    post({ type: 'error', text: format(error) });
  } finally {
    connection?.close();
  }
};

self.onmessage = (event) => {
  if (event.data?.type === 'run') void run(event.data);
};
