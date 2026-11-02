import { writeGuestFile } from './guest-file.js';

// The browsers that a VM can run. Each image has all of them.
const BROWSER_APPS = Object.freeze({
  chromium: Object.freeze({ label: 'Chromium', binary: null }),
  chrome: Object.freeze({ label: 'Google Chrome', binary: '/usr/bin/google-chrome-stable' })
});

const DEFAULT_BROWSER_APP = 'chromium';

const isBrowserApp = (name) => typeof name === 'string' && Object.hasOwn(BROWSER_APPS, name);

// Short names that the API also takes.
const BROWSER_APP_ALIASES = Object.freeze({ 'google-chrome': 'chrome' });

// The browser that `name` means, or null. Case does not matter.
const resolveBrowserApp = (name) => {
  if (typeof name !== 'string') {
    return null;
  }
  const key = name.toLowerCase();
  return BROWSER_APP_ALIASES[key] ?? (isBrowserApp(key) ? key : null);
};

// None of the browsers runs in the snapshot, so the host picks one per VM:
// it writes the binary into this guest file, and /usr/local/bin/browser in
// vm/linux/files runs it, else Chromium.
const GUEST_BROWSER_APP_FILE = '/etc/remotebrowser/app.env';

/**
 * Makes the guest run `app` instead of Chromium. It works only before the
 * browser starts.
 * @param {{dir: string, app: string, connectQmp: Function, attempts?: number}} params
 */
const writeGuestBrowserApp = async ({ dir, app, connectQmp, attempts = 20 }) => {
  const { binary } = BROWSER_APPS[app];
  try {
    await writeGuestFile({
      dir,
      file: GUEST_BROWSER_APP_FILE,
      content: Buffer.from(`BROWSER_APP=${binary}\n`),
      connectQmp,
      attempts
    });
  } catch (error) {
    throw new Error(
      `unable to pick ${BROWSER_APPS[app].label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

export {
  BROWSER_APPS,
  DEFAULT_BROWSER_APP,
  GUEST_BROWSER_APP_FILE,
  isBrowserApp,
  resolveBrowserApp,
  writeGuestBrowserApp
};
