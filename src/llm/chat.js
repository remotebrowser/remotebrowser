import { config } from '../config.js';

// A slow model can take a while, but a request stuck longer than this is treated as dead.
const LLM_TIMEOUT = 30000;

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

// Reads the reply shape that OpenAI-compatible services share.
const extract = (data) => {
  const answer = data?.choices?.[0]?.message?.content;
  return typeof answer === 'string' ? answer.trim() : '';
};

/**
 * One request, no retries. A string is a single user message; an array is the
 * whole conversation.
 * @param {string | {role: string, content: string}[]} input
 * @returns {Promise<{data?: string, error?: string}>}
 */
const rawChat = async (input) => {
  if (!config.llmApiBaseUrl || !config.llmChatModel) {
    return { error: 'NOT_CONFIGURED' };
  }
  const auth = config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {};
  const body = {
    model: config.llmChatModel,
    messages: typeof input === 'string' ? [{ role: 'user', content: input }] : input,
    stream: false
  };

  /** @type {Response} */
  let response;
  try {
    response = await fetch(`${config.llmApiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT)
    });
  } catch (error) {
    return { error: error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : errorMessage(error) };
  }
  if (!response.ok) {
    return { error: `HTTP ${response.status}` };
  }
  const data = await response.json().catch(() => null);
  const answer = extract(data);
  if (!answer) {
    return { error: 'EMPTY_ANSWER' };
  }
  return { data: answer };
};

const MAX_RETRIES = 5;
const BASE_RETRY_DELAY = 500;

// Retrying cannot fix a missing config or a rejected request (e.g. a bad key or
// model name), only a slow, overloaded, or flaky service.
const isRetryable = (error) => {
  if (error === 'NOT_CONFIGURED') {
    return false;
  }
  const status = /^HTTP (\d+)$/.exec(error);
  if (status) {
    const code = Number(status[1]);
    return code === 408 || code === 429 || code >= 500;
  }
  return true;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Like rawChat(), but retries a retryable failure with exponential back-off, so
 * an overloaded service has time to recover.
 * @param {string | {role: string, content: string}[]} input
 * @param {{baseDelay?: number}} [options]
 * @returns {Promise<{data?: string, error?: string}>}
 */
const chat = async (input, { baseDelay = BASE_RETRY_DELAY } = {}) => {
  let result = await rawChat(input);
  for (let retry = 0; retry < MAX_RETRIES && result.error && isRetryable(result.error); retry++) {
    await sleep(baseDelay * 2 ** retry);
    result = await rawChat(input);
  }
  return result;
};

export { rawChat, chat };
