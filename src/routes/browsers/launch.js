import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../render.js';
import { createCsrfToken, verifyCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import {
  requireWorkspaceRole,
  requireSubmittedWorkspace,
  buildBrowsersBreadcrumbs,
  loadWorkspaceSwitcherItems
} from '../../middleware/workspace.js';
import { ADJECTIVES, SOLITARY_ANIMALS, randomItem } from '../../wordlist.js';
import { launchBrowserInstance, recordProvisionedBrowser, updateBrowserInstanceStatus } from '../../models/browsers.js';
import { browserMonitors } from '../../browser.js';
import {
  canSetBrowserScreenResolution,
  canSetBrowserScreenScale,
  canSetBrowserProxy,
  canStartBrowser,
  startBrowser as startBrowserOnFleet
} from '../../fleet.js';
import { DEFAULT_SCREEN_RESOLUTION, DEFAULT_SCREEN_SCALE, normalizeProxyUrl, maskProxyUrl } from '../../vm/index.js';
import { navigateBrowserToUrl } from '../../cdp.js';
import { formString } from '../../form.js';

// Chosen randomly at launch, all privacy-respecting, to fill the first page.
const INITIAL_URLS = ['https://duck.com', 'https://startpage.com', 'https://search.brave.com'];

// Screen sizes in pixels. The default is the image's own, so a
// launch with it sets nothing.
const SCREEN_RESOLUTIONS = [
  { value: 'full-hd', label: 'Full HD', ...DEFAULT_SCREEN_RESOLUTION },
  { value: 'wuxga', label: 'WUXGA', width: 1920, height: 1200 },
  { value: 'qhd', label: 'QHD', width: 2560, height: 1440 },
  { value: '4k', label: '4K', width: 3840, height: 2160 }
].map((resolution) => ({ ...resolution, detail: `${resolution.width}×${resolution.height}` }));
const DEFAULT_SCREEN_RESOLUTION_CHOICE = 'full-hd';

// In percent, the slider's stops. The default is the image's own, so a launch
// with it sets nothing.
const SCREEN_SCALE_RANGE = { min: 100, max: 200, step: 25 };
const SCREEN_SCALES = [100, 125, DEFAULT_SCREEN_SCALE, 175, 200].map((scale) => ({
  value: String(scale),
  label: `${scale}%`,
  scale
}));
const DEFAULT_SCREEN_SCALE_CHOICE = String(DEFAULT_SCREEN_SCALE);

export const routes = new Hono();

const NOT_READY_ERROR =
  'Browsers are still being prepared, so none can be launched yet. Please come back again in a few minutes.';

// Not ready also covers a failed check: a launch would fail the same way.
const browsersReady = async () => {
  const ready = await canStartBrowser();
  if (ready.error) {
    consola.error(`Unable to check whether a browser can be started: ${ready.error}`);
  }
  return ready.data === true;
};

// What to tell someone whose launch was over the workspace's rate, or null for
// any other outcome. Shared with the REST API, which answers with the same words.
const launchRefusal = (launched) => {
  if (launched.error !== 'LAUNCH_RATE_LIMITED') {
    return null;
  }
  const seconds = launched.retryAfterSeconds;
  return {
    // The rate itself is left out on purpose: it is not a promise to anyone.
    message: `This workspace launched too many browsers in the last minute. Please try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
    retryAfterSeconds: seconds
  };
};

const generateBrowserName = () => `${randomItem(ADJECTIVES)}-${randomItem(SOLITARY_ANIMALS)}`;

// Toggles default checked; error re-renders instead keep submitted values.
const renderBrowserLaunch = async (c, data = {}) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  return eta.render('browsers/launch', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildBrowsersBreadcrumbs(workspace, 'Launch'),
    suggestedName: generateBrowserName(),
    error: null,
    description: '',
    enableScreenRecording: true,
    blockAdsAndTrackers: true,
    notReady: false,
    canSetProxy: canSetBrowserProxy(),
    canSetScreenResolution: canSetBrowserScreenResolution(),
    screenResolutions: SCREEN_RESOLUTIONS,
    screenResolution: DEFAULT_SCREEN_RESOLUTION_CHOICE,
    canSetScreenScale: canSetBrowserScreenScale(),
    screenScales: SCREEN_SCALES,
    screenScaleRange: SCREEN_SCALE_RANGE,
    screenScale: DEFAULT_SCREEN_SCALE_CHOICE,
    scriptNonce: c.get('secureHeadersNonce'),
    useProxy: false,
    proxy: '',
    ...data
  });
};

// Without the field, e.g. when the server cannot set it, the default.
const parseScreenResolution = (body) => {
  const value = formString(body.screenResolution) || DEFAULT_SCREEN_RESOLUTION_CHOICE;
  return SCREEN_RESOLUTIONS.find((resolution) => resolution.value === value) ?? null;
};

const parseScreenScale = (body) => {
  const value = formString(body.screenScale) || DEFAULT_SCREEN_SCALE_CHOICE;
  return SCREEN_SCALES.find((scale) => scale.value === value) ?? null;
};

const renderBrowserLaunchError = (c, body, error, data = {}) =>
  renderBrowserLaunch(c, {
    error,
    ...data,
    suggestedName: formString(body.name).trim(),
    description: formString(body.description).trim(),
    enableScreenRecording: Boolean(body.enableScreenRecording),
    blockAdsAndTrackers: Boolean(body.blockAdsAndTrackers),
    screenResolution: parseScreenResolution(body)?.value ?? DEFAULT_SCREEN_RESOLUTION_CHOICE,
    screenScale: parseScreenScale(body)?.value ?? DEFAULT_SCREEN_SCALE_CHOICE,
    useProxy: Boolean(body.useProxy),
    // Kept, password included, so a typo is easy to fix; it goes back only to its sender.
    proxy: formString(body.proxy).trim()
  });

routes.get('/launch', requireUser, requireWorkspaceRole('User'), async (c) => {
  if (!(await browsersReady())) {
    return c.html(await renderBrowserLaunch(c, { error: NOT_READY_ERROR, notReady: true }), 503);
  }
  return c.html(await renderBrowserLaunch(c));
});

// Post-response only: may not throw, and navigate/startMonitor are injectable for tests.
const startBrowser = async ({
  workspaceId,
  browserInstanceId,
  userId,
  proxy = null,
  screenResolution = null,
  screenScale = null,
  navigate = navigateBrowserToUrl,
  startMonitor = browserMonitors.startBrowserMonitor
}) => {
  const started = await startBrowserOnFleet({ proxy, screenResolution, screenScale });
  if (started.error) {
    consola.error(`Unable to start browser ${browserInstanceId}: ${started.error}`);
    return;
  }
  // Fired once CDP exists, in parallel; best-effort, so nothing waits on it.
  void navigate({ browserId: started.data.browserId, url: randomItem(INITIAL_URLS) }).then((navigated) => {
    if (navigated.error) {
      consola.error(`Unable to navigate browser ${browserInstanceId} to the initial page: ${navigated.error}`);
    }
  });

  const recorded = await recordProvisionedBrowser({
    workspaceId,
    browserInstanceId,
    internalBrowserId: started.data.browserId,
    userId
  });
  if (recorded.error) {
    consola.error(`Unable to record the remote browser id for ${browserInstanceId}: ${recorded.error}`);
    return;
  }
  // Fleet assigned a real browser; mark running now, don't wait for scheduler.
  const running = await updateBrowserInstanceStatus({
    workspaceId,
    browserInstanceId,
    toStatus: 'running'
  });
  if (running.error) {
    consola.error(`Unable to mark browser ${browserInstanceId} as running: ${running.error}`);
    return;
  }
  // Watch the browser's page navigations; best-effort, so nothing waits on it.
  void startMonitor({ workspaceId, browserInstanceId, internalBrowserId: started.data.browserId }).then((monitored) => {
    if (monitored.error) {
      consola.error(`Unable to monitor browser ${browserInstanceId}: ${monitored.error}`);
    }
  });
  consola.log(`Started browser ${browserInstanceId} as ${started.data.browserId}`);
};

const handleLaunch = async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrfToken(c, body.csrf)) {
    return c.html(renderBrowserLaunchError(c, body, 'Your session expired. Please try again.'), 403);
  }
  const name = formString(body.name).trim();
  if (!name || name.length > 80) {
    return c.html(renderBrowserLaunchError(c, body, 'A browser name (up to 80 characters) is required.'), 400);
  }
  const description = formString(body.description).trim();
  if (description.length > 140) {
    return c.html(renderBrowserLaunchError(c, body, 'The description must be 140 characters or fewer.'), 400);
  }

  if (!(await browsersReady())) {
    return c.html(renderBrowserLaunchError(c, body, NOT_READY_ERROR, { notReady: true }), 503);
  }

  // Checked before the instance row exists, so a bad URL leaves nothing behind.
  // Without JavaScript, the URL input stays enabled, so it may hold a value
  // even when the box is not checked.
  /** @type {string | null} */
  let proxy = null;
  if (body.useProxy) {
    try {
      proxy = normalizeProxyUrl(formString(body.proxy));
    } catch (error) {
      return c.html(renderBrowserLaunchError(c, body, `${error.message}.`), 400);
    }
    if (!proxy) {
      return c.html(renderBrowserLaunchError(c, body, 'Enter the proxy URL, or uncheck Use proxy.'), 400);
    }
  }
  if (proxy && !canSetBrowserProxy()) {
    return c.html(renderBrowserLaunchError(c, body, 'This server cannot set a proxy for its browsers.'), 400);
  }

  const choice = parseScreenResolution(body);
  if (!choice) {
    return c.html(renderBrowserLaunchError(c, body, 'Choose a screen resolution from the list.'), 400);
  }
  const { width, height } = choice;
  const screenResolution = choice.value === DEFAULT_SCREEN_RESOLUTION_CHOICE ? null : { width, height };
  if (screenResolution && !canSetBrowserScreenResolution()) {
    return c.html(
      renderBrowserLaunchError(c, body, 'This server cannot set the screen resolution for its browsers.'),
      400
    );
  }

  const scaleChoice = parseScreenScale(body);
  if (!scaleChoice) {
    return c.html(
      renderBrowserLaunchError(
        c,
        body,
        `Choose a screen scale from ${SCREEN_SCALE_RANGE.min}% to ${SCREEN_SCALE_RANGE.max}%, in steps of ${SCREEN_SCALE_RANGE.step}%.`
      ),
      400
    );
  }
  const screenScale = scaleChoice.value === DEFAULT_SCREEN_SCALE_CHOICE ? null : scaleChoice.scale;
  if (screenScale && !canSetBrowserScreenScale()) {
    return c.html(renderBrowserLaunchError(c, body, 'This server cannot set the screen scale for its browsers.'), 400);
  }

  const user = c.get('user');
  const workspace = c.get('workspace');

  const launched = await launchBrowserInstance({
    workspaceId: workspace.id,
    userId: user.id,
    browserName: name,
    browserDescription: description,
    config: proxy ? { proxy: maskProxyUrl(proxy) } : null,
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  const refusal = launchRefusal(launched);
  if (refusal) {
    c.header('Retry-After', String(refusal.retryAfterSeconds));
    return c.html(renderBrowserLaunchError(c, body, refusal.message), 429);
  }
  if (launched.error) {
    consola.error('launchBrowserInstance failed:', launched.error);
    return c.html(renderBrowserLaunchError(c, body, 'Unable to launch the browser. Please try again.'), 400);
  }

  void startBrowser({
    workspaceId: workspace.id,
    browserInstanceId: launched.data.browserInstanceId,
    userId: user.id,
    proxy,
    screenResolution,
    screenScale
  });

  return c.redirect(`/browsers/${launched.data.publicId}`, 303);
};

routes.post('/launch', requireUser, requireWorkspaceRole('User'), requireSubmittedWorkspace, handleLaunch);

export { generateBrowserName, browsersReady, launchRefusal, startBrowser, INITIAL_URLS };
