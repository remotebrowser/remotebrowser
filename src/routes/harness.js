import { Hono } from 'hono';
import { consola } from 'consola/basic';
import { requireUser } from '../middleware/auth.js';
import { verifyCsrfToken } from '../auth/csrf.js';
import { formString } from '../form.js';
import {
  checkCode,
  generateCode,
  isLlmWorking,
  MAX_CODE_LENGTH,
  MAX_INSTRUCTION_LENGTH,
  taskComment
} from '../llm/harness.js';

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

// The playground sends every run here, code or natural language. The answer is
// always code that passed src/llm/harness.js, or an error to show.
routes.post('/', requireUser, async (c) => {
  const body = await c.req.parseBody();
  if (!verifyCsrfToken(c, body.csrf)) {
    return c.json({ error: 'Your session expired. Please reload the page.' }, 403);
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
  const user = c.get('user');
  if (!allowRequest(user.id)) {
    return c.json({ error: 'Too many requests. Please wait a minute.' }, 429);
  }
  const result = await generateCode(input);
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
