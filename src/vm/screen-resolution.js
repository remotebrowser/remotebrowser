import { writeGuestFile } from './guest-file.js';

// The browser's screen size. The host writes it, as one line such as
// "1920x1080", or "default", into this guest file through the guest agent.
// The guest sets the labwc output to it at once, and labwc keeps the browser
// filling it. See screen-resolution in vm/linux/files.
const GUEST_SCREEN_RESOLUTION_FILE = '/etc/remotebrowser/screen-resolution';
const DEFAULT = 'default';

// What the image uses with no file: Full HD.
const DEFAULT_SCREEN_RESOLUTION = Object.freeze({ width: 1920, height: 1080 });

const MIN_SCREEN = { width: 640, height: 480 };
const MAX_SCREEN = { width: 3840, height: 2160 };

/**
 * Checks a screen size in pixels, e.g. `{width: 1920, height: 1080}`, and
 * returns it in the form the guest takes. Null means the image's default.
 * Throws an Error that says what is wrong.
 * @param {{width: number, height: number} | null | undefined} input
 * @returns {{width: number, height: number} | null}
 */
const normalizeScreenResolution = (input) => {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof input !== 'object') {
    throw new Error('The screen resolution must have a width and a height');
  }
  const { width, height } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('The screen width and height must be whole numbers');
  }
  if (width < MIN_SCREEN.width || height < MIN_SCREEN.height) {
    throw new Error(`The screen must be at least ${MIN_SCREEN.width}x${MIN_SCREEN.height}`);
  }
  if (width > MAX_SCREEN.width || height > MAX_SCREEN.height) {
    throw new Error(`The screen must be at most ${MAX_SCREEN.width}x${MAX_SCREEN.height}`);
  }
  return { width, height };
};

// Each row of the screen, as the guest gives it to the virtual GPU, is a
// multiple of these pixels.
const ROW_PIXELS = 16;

/**
 * The size that VNC shows for a screen size. The GPU pads each row, so VNC
 * shows up to 15 more pixels, which stay black.
 * @param {{width: number, height: number}} mode
 */
const vncScreenSize = ({ width, height }) => ({
  width: Math.ceil(width / ROW_PIXELS) * ROW_PIXELS,
  height
});

/**
 * Writes the screen size into the guest, which sets the screen to it.
 * Null means the image's default.
 * @param {{dir: string, screenResolution: {width: number, height: number} | null, connectQmp: Function, attempts?: number}} params
 */
const writeGuestScreenResolution = async ({ dir, screenResolution, connectQmp, attempts = 20 }) => {
  const mode = normalizeScreenResolution(screenResolution);
  const line = mode ? `${mode.width}x${mode.height}` : DEFAULT;
  // The guest rejects a file without its closing newline, so a partial write
  // does not set a wrong size.
  try {
    await writeGuestFile({
      dir,
      file: GUEST_SCREEN_RESOLUTION_FILE,
      content: Buffer.from(`${line}\n`),
      connectQmp,
      attempts
    });
  } catch (error) {
    throw new Error(`unable to set the screen resolution: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
};

export {
  DEFAULT_SCREEN_RESOLUTION,
  GUEST_SCREEN_RESOLUTION_FILE,
  normalizeScreenResolution,
  vncScreenSize,
  writeGuestScreenResolution
};
