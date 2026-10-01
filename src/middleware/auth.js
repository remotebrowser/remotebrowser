import { consola } from 'consola/basic';
import { readSessionCookieFrom, clearSessionCookie } from '../auth/session.js';
import { getUserByPublicId } from '../models/users.js';
import { ensurePersonalWorkspace } from '../models/workspaces.js';

const currentUser = async (c) => {
  const session = readSessionCookieFrom(c);
  if (!session) {
    return null;
  }

  // The cookie names the account by its public id; the numeric key is resolved
  // here and never leaves the server.
  const profile = await getUserByPublicId({ publicId: session.publicId });
  if (profile.error) {
    consola.error('currentUser: could not read the user row:', profile.error);
    return null;
  }
  if (!profile.data) {
    // The account is gone (for example the database was reset), so the cookie
    // names nobody. Sign out now rather than fail later when creating a
    // workspace for a missing owner.
    consola.debug('currentUser: no user row for the session, clearing session');
    clearSessionCookie(c);
    return null;
  }
  if (session.issuedAt < profile.data.sessionExpirationTimestamp) {
    consola.debug('currentUser: session predates the revocation marker, clearing session');
    clearSessionCookie(c);
    return null;
  }

  return {
    id: profile.data.id,
    publicId: profile.data.publicId,
    email: profile.data.email,
    personalWorkspaceId: profile.data.personalWorkspaceId,
    // The workspace this session is working on. Absent means "none chosen yet", which
    // src/middleware/workspace.js resolves to the visitor's own workspace.
    activeWorkspaceId: session.activeWorkspaceId || null
  };
};

// The default guard for any signed-in page.
const requireUser = async (c, next) => {
  const user = await currentUser(c);
  if (!user) {
    return c.redirect('/signin', 303);
  }
  // Every guarded page needs a workspace, so enforce it here once.
  const workspace = await ensurePersonalWorkspace({
    userId: user.id,
    email: user.email,
    personalWorkspaceId: user.personalWorkspaceId
  });
  if (workspace.error) {
    consola.error('ensurePersonalWorkspace failed:', workspace.error);
    return c.text('Unable to prepare your workspace. Please try again.', 503);
  }
  user.personalWorkspaceId = workspace.data.workspaceId;
  c.set('user', user);
  await next();
};

const requireGuest = async (c, next) => {
  const user = await currentUser(c);
  if (user) {
    return c.redirect('/', 303);
  }
  await next();
};

export { currentUser, requireUser, requireGuest };
