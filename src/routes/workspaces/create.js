import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../render.js';
import { createCsrfToken, verifyCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import { setActiveWorkspace } from '../../auth/session.js';
import { createWorkspace, createCollaborator } from '../../models/workspaces.js';
import { ADJECTIVES, SOCIAL_ANIMALS, randomItem } from '../../wordlist.js';
import { formString } from '../../form.js';

export const routes = new Hono();

// No workspace context; breadcrumb trail is just the current page.
const BREADCRUMBS = Object.freeze([{ label: 'Create', href: null }]);

const generateWorkspaceName = () => `${randomItem(ADJECTIVES)}-${randomItem(SOCIAL_ANIMALS)}`;

// Prefilled name; re-renders keep typed input on error.
const renderWorkspaceCreate = (c, data = {}) => {
  const user = c.get('user');
  return eta.render('workspaces/create', {
    email: user.email,
    csrfToken: createCsrfToken(c),
    error: null,
    breadcrumbs: BREADCRUMBS,
    ...data,
    suggestedName: data.suggestedName || generateWorkspaceName()
  });
};

const renderWorkspaceCreateError = (c, body, error) =>
  renderWorkspaceCreate(c, { error, suggestedName: formString(body.name).trim() });

routes.get('/create', requireUser, (c) => c.html(renderWorkspaceCreate(c)));

routes.post('/create', requireUser, async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrfToken(c, body.csrf)) {
    return c.html(renderWorkspaceCreateError(c, body, 'Your session expired. Please try again.'), 403);
  }
  const name = formString(body.name).trim();
  if (!name || name.length > 80) {
    return c.html(renderWorkspaceCreateError(c, body, 'A workspace name (up to 80 characters) is required.'), 400);
  }
  const user = c.get('user');
  const created = await createWorkspace({
    name,
    ownerId: user.id,
    personal: false
  });
  if (created.error) {
    consola.error('createWorkspace failed:', created.error);
    return c.html(renderWorkspaceCreateError(c, body, 'Unable to create the workspace. Please try again.'), 400);
  }
  const collaborator = await createCollaborator({
    workspaceId: created.data.workspaceId,
    userId: user.id,
    email: user.email,
    role: 'Owner',
    workspaceName: name
  });
  if (collaborator.error) {
    consola.error('createCollaborator failed:', collaborator.error);
    return c.html(renderWorkspaceCreateError(c, body, 'Unable to create the workspace. Please try again.'), 400);
  }
  consola.info('CREATE_WORKSPACE', {
    'event.domain': 'workspace',
    'user.id': user.id,
    'user.email': user.email,
    'workspace.id': created.data.workspaceId,
    'workspace.name': name
  });
  // Switch to the new workspace; creating one implies working in it.
  setActiveWorkspace(c, created.data.workspaceId);
  return c.redirect('/workspace', 303);
});

export { generateWorkspaceName };
