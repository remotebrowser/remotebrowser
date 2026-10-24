import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { eta } from '../../render.js';
import { createCsrfToken } from '../../auth/csrf.js';
import { requireUser } from '../../middleware/auth.js';
import {
  requireWorkspaceRole,
  buildBreadcrumbs,
  loadWorkspaceSwitcherItems,
  hasAdminRole
} from '../../middleware/workspace.js';
import {
  listApiKeysByUser,
  listApiKeysByWorkspace,
  countApiKeysByUser,
  MAX_PERSONAL_API_KEYS,
  MAX_SHARED_API_KEYS_PER_MEMBER
} from '../../models/apikeys.js';

export const routes = new Hono();

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

// "in 3 minutes", "5 days ago": the largest unit that keeps the number at 1 or
// more. Rounded, so a 7-day key made a moment ago says 7 days, not 6.
const formatRelativeTime = (deltaMs) => {
  const sign = deltaMs < 0 ? -1 : 1;
  const ms = Math.abs(deltaMs);
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return relativeTime.format(sign * minutes, 'minute');
  const hours = Math.round(ms / HOUR_MS);
  if (hours < 24) return relativeTime.format(sign * hours, 'hour');
  return relativeTime.format(sign * Math.round(ms / DAY_MS), 'day');
};

// Only a preview of the key exists past its creation, so that is all a row can show.
const summarizeApiKey = (apiKey, now) => ({
  publicId: apiKey.publicId,
  name: apiKey.name,
  keyPreview: apiKey.keyPreview,
  expiresAt: new Date(apiKey.expiresTimestamp).toISOString(),
  expiresIn: formatRelativeTime(apiKey.expiresTimestamp - now),
  // Null for a key that was never used; the table says "Never".
  lastUsedAt: apiKey.lastUsedTimestamp === null ? null : new Date(apiKey.lastUsedTimestamp).toISOString(),
  lastUsedAgo: apiKey.lastUsedTimestamp === null ? null : formatRelativeTime(apiKey.lastUsedTimestamp - now),
  creatorEmail: apiKey.creatorEmail
});

// Admins and Owners of a shared workspace see every member's keys, so they can
// revoke one that leaked. A personal workspace has no other members.
const seesAllApiKeys = (workspace) => hasAdminRole(workspace.role) && !workspace.isPersonal;

const maxApiKeysFor = (workspace) => (workspace.isPersonal ? MAX_PERSONAL_API_KEYS : MAX_SHARED_API_KEYS_PER_MEMBER);

const atApiKeyLimit = (workspace, count) => {
  const max = maxApiKeysFor(workspace);
  return max !== null && count >= max;
};

const loadApiKeys = async (c, { everyone }) => {
  const workspaceId = c.get('workspace').id;
  const listed = everyone
    ? await listApiKeysByWorkspace({ workspaceId })
    : await listApiKeysByUser({ workspaceId, userId: c.get('user').id });
  if (listed.error) {
    consola.error('API could not list the keys', { 'event.domain': 'api', 'error.type': String(listed.error) });
    return [];
  }
  const now = Date.now();
  return listed.data.map((apiKey) => summarizeApiKey(apiKey, now));
};

routes.get('/', requireUser, requireWorkspaceRole('User'), async (c) => {
  const user = c.get('user');
  const workspace = c.get('workspace');
  const apiKeys = await loadApiKeys(c, { everyone: seesAllApiKeys(workspace) });
  // Counted apart, since an Admin's list holds other members' keys too.
  const ownCount = await countApiKeysByUser({ workspaceId: workspace.id, userId: user.id });
  return c.html(
    eta.render('apikeys/index', {
      email: user.email,
      csrfToken: createCsrfToken(c),
      workspace,
      workspaces: await loadWorkspaceSwitcherItems(c),
      breadcrumbs: buildBreadcrumbs(workspace, 'API keys'),
      apiKeys,
      showCreator: seesAllApiKeys(workspace),
      // Offered too when the count failed: the generate page checks again.
      // Null when the count failed, which leaves the summary out.
      ownCount: ownCount.error ? null : ownCount.data,
      canGenerate: Boolean(ownCount.error) || !atApiKeyLimit(workspace, ownCount.data),
      maxApiKeys: maxApiKeysFor(workspace)
    })
  );
});

export { seesAllApiKeys, maxApiKeysFor, atApiKeyLimit, formatRelativeTime };
