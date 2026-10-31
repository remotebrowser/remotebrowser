import { writeGuestFile } from './guest-file.js';

// The browser's screen scale, in percent. The host writes it, as one line
// such as "150", or "default", into this guest file through the guest agent.
// The guest sets the X DPI to it, and Chromium follows at once, without a
// restart. See screen-scale in vm/linux/files.
const GUEST_SCREEN_SCALE_FILE = '/etc/remotebrowser/screen-scale';
const DEFAULT = 'default';

// What the image uses with no file.
const DEFAULT_SCREEN_SCALE = 150;

const MIN_SCALE = 100;
const MAX_SCALE = 300;
// In these steps, the DPI that the guest sets is exact, so the browser gets
// exactly this scale.
const SCALE_STEP = 25;

/**
 * Checks a screen scale in percent, e.g. 150, and returns it. Null means the
 * image's default. Throws an Error that says what is wrong.
 * @param {number | null | undefined} input
 * @returns {number | null}
 */
const normalizeScreenScale = (input) => {
  if (input === null || input === undefined) {
    return null;
  }
  if (!Number.isInteger(input)) {
    throw new Error('The screen scale must be a whole number of percent');
  }
  if (input < MIN_SCALE || input > MAX_SCALE || input % SCALE_STEP !== 0) {
    throw new Error(`The screen scale must be from ${MIN_SCALE}% to ${MAX_SCALE}%, in steps of ${SCALE_STEP}%`);
  }
  return input;
};

/**
 * Writes the screen scale into the guest, which sets the X DPI to it. Null
 * means the image's default.
 * @param {{dir: string, screenScale: number | null, connectQmp: Function, attempts?: number}} params
 */
const writeGuestScreenScale = async ({ dir, screenScale, connectQmp, attempts = 20 }) => {
  const scale = normalizeScreenScale(screenScale);
  const line = scale ? String(scale) : DEFAULT;
  // The guest rejects a file without its closing newline, so a partial write
  // does not set a wrong scale.
  try {
    await writeGuestFile({
      dir,
      file: GUEST_SCREEN_SCALE_FILE,
      content: Buffer.from(`${line}\n`),
      connectQmp,
      attempts
    });
  } catch (error) {
    throw new Error(`unable to set the screen scale: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
};

export { DEFAULT_SCREEN_SCALE, GUEST_SCREEN_SCALE_FILE, normalizeScreenScale, writeGuestScreenScale };
