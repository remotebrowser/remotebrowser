import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { requireUser } from '../../middleware/auth.js';
import { requireWorkspaceRole } from '../../middleware/workspace.js';
import { verifyCsrfToken } from '../../auth/csrf.js';
import { formString } from '../../form.js';
import { getBrowserInstanceByPublicId } from '../../models/browsers.js';
import { readPageAccessibility } from '../../cdp.js';
import { describePage } from '../../llm/page.js';
import {
  checkCode,
  generateCode,
  isLlmWorking,
  MAX_CODE_LENGTH,
  MAX_INSTRUCTION_LENGTH,
  taskComment
} from '../../llm/harness.js';

export const routes = new Hono();

// Every call costs an LLM request. In memory, so per server, which is enough
// to stop a runaway loop.
const MAX_REQUESTS_PER_MINUTE = 10;
const recentRequests = new Map();

const allowRequest = (userId, now = Date.now()) => {
  const recent = (recentRequests.get(userId) ?? []).filter((time) => now - time < 60_000);
  if (recent.length >= MAX_REQUESTS_PER_MINUTE) {
    recentRequests.set(userId, recent);
    return false;
  }
  recentRequests.set(userId, [...recent, now]);
  return true;
};

// The LLM writes code for the page that is open now. Without it, the LLM can
// still write code that starts with page.goto.
const readPage = async (browser) => {
  if (browser.status !== 'running' || !browser.internalBrowserId) return undefined;
  const read = await readPageAccessibility({ browserId: browser.internalBrowserId });
  if (read.error) {
    consola.warn('HARNESS could not read the page', { 'event.domain': 'harness', 'error.type': read.error });
    return undefined;
  }
  return describePage(read.data);
};

// The playground sends every run here, code or natural language. The answer is
// always code that passed src/llm/harness.js, or an error to show.
routes.post('/:browserId/harness', requireUser, requireWorkspaceRole('User'), async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrfToken(c, body.csrf)) {
    return c.json({ error: 'Your session expired. Please reload the page.' }, 403);
  }
  const user = c.get('user');
  const workspace = c.get('workspace');
  const found = await getBrowserInstanceByPublicId({
    workspaceId: workspace.id,
    publicId: c.req.param('browserId'),
    personalWorkspaceRepair: workspace.isPersonal ? { userId: user.id, email: user.email } : null
  });
  if (found.error || !found.data) {
    return c.json({ error: 'This browser no longer exists.' }, 404);
  }
  const input = formString(body.input);
  if (!input.trim()) {
    return c.json({ error: 'Write some code or describe what the browser should do.' }, 400);
  }
  if (input.length > MAX_CODE_LENGTH) {
    return c.json({ error: `Keep it under ${MAX_CODE_LENGTH} characters.` }, 400);
  }
  // Code that already passes needs no LLM. A lone throw is the LLM's way to
  // refuse, but from the user it is just code.
  const checked = await checkCode(input, { own: true });
  if (!checked.error) {
    return c.json({ code: checked.data ?? input.trim() });
  }
  if (!isLlmWorking()) {
    return c.json({ error: `This code cannot run in the playground: ${checked.error}.` }, 422);
  }
  if (input.length > MAX_INSTRUCTION_LENGTH) {
    return c.json({ error: `Keep a task under ${MAX_INSTRUCTION_LENGTH} characters.` }, 400);
  }
  if (!allowRequest(user.id)) {
    return c.json({ error: 'Too many requests. Please wait a minute.' }, 429);
  }
  const result = await generateCode(input, { page: await readPage(found.data) });
  if (result.refusal) {
    return c.json({ error: result.refusal }, 422);
  }
  if (result.error) {
    // The instruction is not logged: it is the user's own text.
    consola.error('HARNESS failed', {
      'event.domain': 'harness',
      'error.type': result.error,
      'error.message': result.reason
    });
    return result.error === 'INVALID_CODE'
      ? c.json({ error: 'Could not turn that into playground code. Try to rephrase it.' }, 422)
      : c.json({ error: 'The LLM is not available right now. Please try again later.' }, 502);
  }
  // The task leads, so the code shows what it was written for. The playground
  // puts generated code in the editor, so the user sees what runs.
  return c.json({ code: `${taskComment(input)}\n${result.data}`, generated: true });
});

export { allowRequest };
