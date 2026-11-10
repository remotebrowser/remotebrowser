import { writeGuestFile } from './guest-file.js';

const MAX_EXTENSIONS = 10;

// A Chrome Web Store id: 32 letters from a to p.
const EXTENSION_ID = /^[a-p]{32}$/;

const STORE_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com']);

// The id that a Chrome Web Store URL, or a bare id, names, or null. A store
// URL ends in the id, as in
// https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh
const extensionIdOf = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  if (EXTENSION_ID.test(text)) {
    return text;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !STORE_HOSTS.has(url.hostname)) {
    return null;
  }
  const id = url.pathname.split('/').filter(Boolean).at(-1);
  return id && EXTENSION_ID.test(id) ? id : null;
};

/**
 * The ids of the extensions in `list`, each once, in order. Throws when the
 * list or an item is not valid.
 * @param {unknown} list
 * @returns {string[]}
 */
const normalizeExtensions = (list) => {
  if (!Array.isArray(list)) {
    throw new Error('The extensions must be a list of Chrome Web Store URLs or extension ids');
  }
  const ids = [];
  for (const item of list) {
    const id = extensionIdOf(item);
    if (!id) {
      throw new Error(`Not a Chrome Web Store URL or extension id: ${String(item)}`);
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  if (ids.length > MAX_EXTENSIONS) {
    throw new Error(`At most ${MAX_EXTENSIONS} extensions are allowed`);
  }
  return ids;
};

// Where each browser reads its managed policies on Linux. The images make
// these dirs, since the guest agent cannot.
const GUEST_POLICY_FILES = Object.freeze({
  chromium: '/etc/chromium/policies/managed/extensions.json',
  chrome: '/etc/opt/chrome/policies/managed/extensions.json'
});

const STORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx';

const extensionPolicy = (ids) =>
  `${JSON.stringify({ ExtensionInstallForcelist: ids.map((id) => `${id};${STORE_UPDATE_URL}`) })}\n`;

/**
 * Makes the browser install `ids` from the Chrome Web Store when it starts. It
 * works only before the browser starts.
 * Linux only: Edge on Windows reads its policies from the registry.
 * @param {{dir: string, app: string, ids: string[], connectQmp: Function, attempts?: number}} params
 */
const writeGuestExtensions = async ({ dir, app, ids, connectQmp, attempts = 20 }) => {
  try {
    await writeGuestFile({
      dir,
      file: GUEST_POLICY_FILES[app],
      content: Buffer.from(extensionPolicy(ids)),
      connectQmp,
      attempts
    });
  } catch (error) {
    throw new Error(`unable to add the extensions: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
};

export {
  GUEST_POLICY_FILES,
  MAX_EXTENSIONS,
  extensionIdOf,
  extensionPolicy,
  normalizeExtensions,
  writeGuestExtensions
};
