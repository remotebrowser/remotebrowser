// Runs playground code in a worker: Stop can kill it at once, and the code
// cannot touch the page that hosts it. It speaks CDP over the app's relay and
// offers a small, Playwright-like API on top.

const DEFAULT_TIMEOUT = 30000;
const POLL_INTERVAL = 100;

const post = (message) => self.postMessage(message);

let socket = null;
let nextId = 0;
const pending = new Map();
const listeners = new Set();

const connect = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('Unable to connect to the browser.'));
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          if (message.error) {
            waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
          } else {
            waiter.resolve(message.result);
          }
        }
        return;
      }
      for (const listener of listeners) {
        listener(message);
      }
    };
    ws.onclose = () => {
      for (const waiter of pending.values()) {
        waiter.reject(new Error('The browser connection was closed.'));
      }
      pending.clear();
    };
  });

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error('The browser connection is closed.'));
      return;
    }
    nextId += 1;
    pending.set(nextId, { resolve, reject, method });
    socket.send(JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

// Listens before the command that fires the event is sent, so it is never missed.
const waitForEvent = (sessionId, method, timeout) => {
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
      listeners.delete(listener);
    };
    listeners.add(listener);
  });
  return { promise, cancel };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Key names to the fields Input.dispatchKeyEvent needs; other keys are sent as text.
const KEYS = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34 },
  Home: { code: 'Home', windowsVirtualKeyCode: 36 },
  End: { code: 'End', windowsVirtualKeyCode: 35 }
};

const callExpression = (fn, ...args) => {
  const source = typeof fn === 'function' ? fn.toString() : String(fn);
  return `(${source})(${args.map((arg) => (arg === undefined ? 'undefined' : JSON.stringify(arg))).join(', ')})`;
};

// The selector is resolved again in each call, like a Playwright locator.
const elementExpression = (selector, index) => `(() => {
  const all = document.querySelectorAll(${JSON.stringify(selector)});
  return all[${index} < 0 ? all.length + ${index} : ${index}] || null;
})()`;

class Locator {
  constructor(page, selector, index = 0) {
    this.page = page;
    this.selector = selector;
    this.index = index;
  }

  first() {
    return new Locator(this.page, this.selector, 0);
  }

  last() {
    return new Locator(this.page, this.selector, -1);
  }

  nth(index) {
    return new Locator(this.page, this.selector, index);
  }

  count() {
    return this.page.evaluate(`document.querySelectorAll(${JSON.stringify(this.selector)}).length`);
  }

  async evaluate(fn, arg) {
    const source = typeof fn === 'function' ? fn.toString() : String(fn);
    const result = await this.page.evaluate(`(() => {
      const element = ${elementExpression(this.selector, this.index)};
      if (!element) return { missing: true };
      return Promise.resolve((${source})(element, ${arg === undefined ? 'undefined' : JSON.stringify(arg)}))
        .then((value) => ({ value }));
    })()`);
    if (result.missing) {
      throw new Error(`No element matches ${this.selector}.`);
    }
    return result.value;
  }

  async waitFor({ state = 'visible', timeout = DEFAULT_TIMEOUT } = {}) {
    const check = `((element) => {
      if (!element) return ${JSON.stringify(state)} === 'detached';
      if (${JSON.stringify(state)} === 'attached') return true;
      const visible = element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
      return ${JSON.stringify(state)} === 'hidden' ? !visible : ${JSON.stringify(state)} === 'visible' && visible;
    })(${elementExpression(this.selector, this.index)})`;
    const deadline = Date.now() + timeout;
    while (!(await this.page.evaluate(check))) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeout} ms waiting for ${this.selector} to be ${state}.`);
      }
      await sleep(POLL_INTERVAL);
    }
  }

  isVisible() {
    return this.page.evaluate(`((element) =>
      Boolean(element) && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
    )(${elementExpression(this.selector, this.index)})`);
  }

  textContent() {
    return this.evaluate((element) => element.textContent);
  }

  innerText() {
    return this.evaluate((element) => element.innerText);
  }

  innerHTML() {
    return this.evaluate((element) => element.innerHTML);
  }

  inputValue() {
    return this.evaluate((element) => element.value);
  }

  getAttribute(name) {
    return this.evaluate((element, attribute) => element.getAttribute(attribute), name);
  }

  allTextContents() {
    return this.page.evaluate(
      callExpression(
        (selector) => [...document.querySelectorAll(selector)].map((element) => element.textContent),
        this.selector
      )
    );
  }

  allInnerTexts() {
    return this.page.evaluate(
      callExpression(
        (selector) => [...document.querySelectorAll(selector)].map((element) => element.innerText),
        this.selector
      )
    );
  }

  async click({ timeout = DEFAULT_TIMEOUT } = {}) {
    await this.waitFor({ timeout });
    const { x, y } = await this.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await this.page.mouse.click(x, y);
  }

  async focus({ timeout = DEFAULT_TIMEOUT } = {}) {
    await this.waitFor({ timeout });
    await this.evaluate((element) => element.focus());
  }

  async fill(value, { timeout = DEFAULT_TIMEOUT } = {}) {
    await this.waitFor({ timeout });
    await this.evaluate((element) => {
      element.focus();
      if (typeof element.select === 'function') {
        element.select();
      }
    });
    if (value === '') {
      await this.page.keyboard.press('Delete');
    } else {
      await this.page.keyboard.insertText(String(value));
    }
  }

  async type(text, options) {
    await this.focus(options);
    await this.page.keyboard.type(String(text));
  }

  async press(key, options) {
    await this.focus(options);
    await this.page.keyboard.press(key);
  }
}

class Page {
  constructor(targetId, sessionId, url) {
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.currentUrl = url;
    this.closed = false;
    this.mouse = {
      click: async (x, y) => {
        this.show();
        const base = { x, y, button: 'left', clickCount: 1 };
        await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
        await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
      }
    };
    this.keyboard = {
      insertText: (text) => this.cdp('Input.insertText', { text }),
      type: async (text) => {
        for (const char of text) {
          await this.keyboard.press(char);
        }
      },
      press: async (key) => {
        this.show();
        const known = KEYS[key];
        const fields = known ? { key, ...known } : { key, text: key };
        await this.cdp('Input.dispatchKeyEvent', { type: fields.text ? 'keyDown' : 'rawKeyDown', ...fields });
        await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...fields, text: undefined });
      }
    };
    listeners.add((message) => {
      if (message.sessionId !== this.sessionId) {
        return;
      }
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
    return send(method, params, this.sessionId);
  }

  url() {
    return this.currentUrl;
  }

  async goto(url, { waitUntil = 'load', timeout = DEFAULT_TIMEOUT } = {}) {
    this.show();
    const event = waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';
    const loaded = waitForEvent(this.sessionId, event, timeout);
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
    // No loaderId means a same-document navigation, which fires no load event.
    if (!result.loaderId) {
      loaded.cancel();
      return;
    }
    await loaded.promise;
  }

  async reload({ waitUntil = 'load', timeout = DEFAULT_TIMEOUT } = {}) {
    const event = waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';
    const loaded = waitForEvent(this.sessionId, event, timeout);
    await this.cdp('Page.reload', {});
    await loaded.promise;
  }

  async goBack() {
    await this.evaluate('history.back()');
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

  locator(selector) {
    return new Locator(this, selector);
  }

  $eval(selector, fn, arg) {
    return this.locator(selector).evaluate(fn, arg);
  }

  $$eval(selector, fn, arg) {
    const source = typeof fn === 'function' ? fn.toString() : String(fn);
    return this.evaluate(
      `(${source})([...document.querySelectorAll(${JSON.stringify(selector)})], ${arg === undefined ? 'undefined' : JSON.stringify(arg)})`
    );
  }

  waitForSelector(selector, options) {
    return this.locator(selector).waitFor(options);
  }

  async waitForURL(match, { timeout = DEFAULT_TIMEOUT } = {}) {
    const matches = (url) =>
      match instanceof RegExp
        ? match.test(url)
        : typeof match === 'function'
          ? match(new URL(url))
          : url.includes(match);
    const deadline = Date.now() + timeout;
    while (!matches(this.currentUrl)) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeout} ms waiting for the URL to match ${match}.`);
      }
      await sleep(POLL_INTERVAL);
    }
  }

  waitForTimeout(ms) {
    return sleep(ms);
  }

  click(selector, options) {
    return this.locator(selector).click(options);
  }

  fill(selector, value, options) {
    return this.locator(selector).fill(value, options);
  }

  type(selector, text, options) {
    return this.locator(selector).type(text, options);
  }

  press(selector, key, options) {
    return this.locator(selector).press(key, options);
  }

  textContent(selector) {
    return this.locator(selector).textContent();
  }

  innerText(selector) {
    return this.locator(selector).innerText();
  }

  async screenshot({ fullPage = false } = {}) {
    this.show();
    const { data } = await this.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    post({ type: 'image', data });
    return data;
  }

  async bringToFront() {
    this.show();
    await this.cdp('Page.bringToFront');
  }

  async close() {
    this.closed = true;
    await send('Target.closeTarget', { targetId: this.targetId });
    // Keep the live view on a page that still exists.
    context.pages()[0]?.show();
  }

  isClosed() {
    return this.closed;
  }
}

const pages = [];

const attach = async (targetId, url) => {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(targetId, sessionId, url);
  await page.cdp('Page.enable');
  pages.push(page);
  return page;
};

const context = {
  pages: () => pages.filter((page) => !page.closed),
  newPage: async () => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const page = await attach(targetId, 'about:blank');
    page.show();
    return page;
  }
};

const browser = {
  contexts: () => [context],
  newPage: () => context.newPage(),
  // Like Playwright over CDP: it only disconnects, the remote browser stays up.
  close: async () => socket?.close(),
  cdp: (method, params) => send(method, params)
};

const format = (value) => {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return String(value);
  }
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
  debug: log('log'),
  warn: log('warn'),
  error: log('error'),
  table: log('log'),
  dir: log('log')
};

const AsyncFunction = (async () => {}).constructor;

const run = async ({ code, cdpUrl }) => {
  try {
    // Compile before connecting, so a syntax error does not touch the browser.
    const program = new AsyncFunction('browser', 'context', 'page', 'console', code);
    socket = await connect(cdpUrl);
    const { targetInfos } = await send('Target.getTargets');
    for (const target of targetInfos.filter((info) => info.type === 'page')) {
      await attach(target.targetId, target.url);
    }
    const page = pages[0] ?? (await context.newPage());
    page.show();
    const result = await program(browser, context, page, sandboxConsole);
    post({ type: 'done', result: result === undefined ? undefined : format(result) });
  } catch (error) {
    post({ type: 'error', text: format(error) });
  } finally {
    socket?.close();
  }
};

self.onmessage = (event) => {
  if (event.data?.type === 'run') {
    void run(event.data);
  }
};
