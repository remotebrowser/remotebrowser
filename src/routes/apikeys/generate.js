import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../render.js';
import { createCsrfToken, verifyCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import {
  requireWorkspaceRole,
  requireSubmittedWorkspace,
  buildApiKeysBreadcrumbs,
  loadWorkspaceSwitcherItems
} from '../../middleware/workspace.js';
import { API_KEY_EXPIRATIONS, createApiKey, countApiKeysByUser } from '../../models/apikeys.js';
import { maxApiKeysFor, atApiKeyLimit } from './index.js';
import { formString } from '../../form.js';
import { FLOWER_ADJECTIVES, FLOWERS, randomItem } from '../../wordlist.js';
import { API_KEY_PREFIX } from '../../apikey.js';

export const routes = new Hono();

const renderPage = async (c, template, data) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  return eta.render(template, {
    email: user.email,
    csrfToken: createCsrfToken(c),
    workspace,
    workspaces: await loadWorkspaceSwitcherItems(c),
    breadcrumbs: buildApiKeysBreadcrumbs(workspace, 'Generate'),
    ...data
  });
};

// Pre-selected on a fresh form; the other choices stay one click away.
const DEFAULT_EXPIRATION = '7d';

// Like a browser's suggested name, with a flower in place of an animal.
const generateApiKeyName = () => `${randomItem(FLOWER_ADJECTIVES)}-${randomItem(FLOWERS)}`;

// Error re-renders keep the submitted values, so nothing has to be typed again.
const renderGenerate = (c, data = {}) =>
  renderPage(c, 'apikeys/generate', {
    error: null,
    name: '',
    expiration: '',
    expirations: API_KEY_EXPIRATIONS,
    atLimit: false,
    maxApiKeys: maxApiKeysFor(c.get('workspace')),
    ...data
  });

routes.get('/generate', requireUser, requireWorkspaceRole('User'), async (c) => {
  // The button is hidden at the limit, but the address can still be opened.
  const count = await countApiKeysByUser({ workspaceId: c.get('workspace').id, userId: c.get('user').id });
  if (!count.error && atApiKeyLimit(c.get('workspace'), count.data)) {
    return c.html(await renderGenerate(c, { atLimit: true }));
  }
  return c.html(await renderGenerate(c, { name: generateApiKeyName(), expiration: DEFAULT_EXPIRATION }));
});

const handleGenerate = async (c) => {
  const body = await c.req.parseBody();
  const name = formString(body.name).trim();
  const expiration = formString(body.expiration);
  const fail = async (error, status) => c.html(await renderGenerate(c, { error, name, expiration }), status);

  if (!verifyCsrfToken(c, body.csrf)) {
    return fail('Your session expired. Please try again.', 403);
  }
  if (!name || name.length > 80) {
    return fail('A name (up to 80 characters) is required.', 400);
  }
  if (!API_KEY_EXPIRATIONS.some((option) => option.value === expiration)) {
    return fail('Choose when the API key expires.', 400);
  }

  const user = c.get('user');
  const workspace = c.get('workspace');
  const created = await createApiKey({
    workspaceId: workspace.id,
    userId: user.id,
    name,
    expiration,
    maxKeys: maxApiKeysFor(workspace)
  });
  if (created.error === 'TOO_MANY_API_KEYS') {
    return c.html(await renderGenerate(c, { atLimit: true }), 409);
  }
  if (created.error) {
    consola.error('API could not create a key', { 'event.domain': 'api', 'error.type': String(created.error) });
    return fail('Unable to generate the API key. Please try again.', 500);
  }

  // Names the key by its public id only: the key itself must never be logged.
  consola.info('API key created', {
    'event.domain': 'api',
    'user.id': user.id,
    'workspace.id': workspace.id,
    'rb.api_key': created.data.publicId,
    'rb.api_key_expires': new Date(created.data.expiresTimestamp).toISOString()
  });

  // Rendered straight from the POST, never redirected: the key must not end up
  // in a URL, and this is the only time it can be shown.
  c.header('Cache-Control', 'no-store');
  return c.html(
    await renderPage(c, 'apikeys/created', {
      apiKey: created.data.apiKey,
      // Same length as the key, so revealing it does not shift the layout.
      maskedApiKey: API_KEY_PREFIX + '•'.repeat(created.data.apiKey.length - API_KEY_PREFIX.length),
      name: created.data.name,
      // Set by secureHeaders first; the Copy button's inline script reads it back for CSP.
      scriptNonce: c.get('secureHeadersNonce')
    })
  );
};

routes.post('/generate', requireUser, requireWorkspaceRole('User'), requireSubmittedWorkspace, handleGenerate);

export { generateApiKeyName };
