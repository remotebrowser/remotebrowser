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
import {
  launchBrowserInstance,
  recordProvisionedBrowser,
  listBrowserInstancesByWorkspace,
  updateBrowserInstanceStatus
} from '../../models/browsers.js';
import { describeBrowserCapacity } from '../../browser.js';
import { startBrowser as startBrowserOnFleet } from '../../fleet.js';
import { navigateBrowserToUrl } from '../../cdp.js';
import { formString } from '../../form.js';

// Chosen randomly at launch, all privacy-respecting, to fill the first page.
const INITIAL_URLS = ['https://duck.com', 'https://startpage.com', 'https://search.brave.com'];

export const routes = new Hono();

const generateBrowserName = () => `${randomItem(ADJECTIVES)}-${randomItem(SOLITARY_ANIMALS)}`;

// Read by both GET and POST; a failed read counts as not at capacity.
const loadCapacity = async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const listResult = await listBrowserInstancesByWorkspace({
    workspaceId: workspace.id,
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  const instances = listResult.error ? [] : listResult.data;
  return describeBrowserCapacity({ workspace, instances });
};

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
    capacity: null,
    ...data
  });
};

const renderBrowserLaunchError = (c, body, error) =>
  renderBrowserLaunch(c, {
    error,
    suggestedName: formString(body.name).trim(),
    description: formString(body.description).trim(),
    enableScreenRecording: Boolean(body.enableScreenRecording),
    blockAdsAndTrackers: Boolean(body.blockAdsAndTrackers)
  });

routes.get('/launch', requireUser, requireWorkspaceRole('User'), async (c) =>
  c.html(renderBrowserLaunch(c, { capacity: await loadCapacity(c) }))
);

// Post-response only: may not throw, and navigate is injectable for tests.
const startBrowser = async ({ workspaceId, browserInstanceId, userId, navigate = navigateBrowserToUrl }) => {
  const started = await startBrowserOnFleet();
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

  // Re-checked here; the disabled button is a courtesy, not a boundary.
  const capacity = await loadCapacity(c);
  if (capacity.atCapacity) {
    return c.html(renderBrowserLaunch(c, { capacity }), 409);
  }

  const user = c.get('user');
  const workspace = c.get('workspace');

  const launched = await launchBrowserInstance({
    workspaceId: workspace.id,
    userId: user.id,
    browserName: name,
    browserDescription: description,
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  if (launched.error) {
    consola.error('launchBrowserInstance failed:', launched.error);
    return c.html(renderBrowserLaunchError(c, body, 'Unable to launch the browser. Please try again.'), 400);
  }

  void startBrowser({
    workspaceId: workspace.id,
    browserInstanceId: launched.data.browserInstanceId,
    userId: user.id
  });

  return c.redirect(`/browsers/${launched.data.publicId}`, 303);
};

routes.post('/launch', requireUser, requireWorkspaceRole('User'), requireSubmittedWorkspace, handleLaunch);

export { generateBrowserName, startBrowser, INITIAL_URLS };
