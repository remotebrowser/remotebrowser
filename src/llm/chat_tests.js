import test from 'node:test';
import assert from 'node:assert/strict';

// Set before ./config is first required, since config freezes what it read.
// The trailing slash is deliberate: it must not survive into the request URL.
process.env.LLM_API_BASE_URL = 'http://llm.test/v1/';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_CHAT_MODEL = 'test-model';

const { rawChat, chat } = await import('./chat.js');

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stubFetch = (respond) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return respond();
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
};

test('rawChat sends the input as a user message and returns the answer', async () => {
  const { calls, restore } = stubFetch(() => jsonResponse({ choices: [{ message: { content: '  Hello!\n' } }] }));
  try {
    const result = await rawChat('Say hello');
    assert.deepEqual(result, { data: 'Hello!' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://llm.test/v1/chat/completions');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Say hello' }]);
  } finally {
    restore();
  }
});

test('rawChat reports an HTTP error status', async () => {
  const { restore } = stubFetch(() => jsonResponse({ error: 'nope' }, 401));
  try {
    assert.deepEqual(await rawChat('Say hello'), { error: 'HTTP 401' });
  } finally {
    restore();
  }
});

test('rawChat reports an empty answer', async () => {
  const { restore } = stubFetch(() => jsonResponse({ choices: [] }));
  try {
    assert.deepEqual(await rawChat('Say hello'), { error: 'EMPTY_ANSWER' });
  } finally {
    restore();
  }
});

test('rawChat reports a network failure', async () => {
  const { restore } = stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  try {
    assert.deepEqual(await rawChat('Say hello'), { error: 'fetch failed' });
  } finally {
    restore();
  }
});

// Sequence of responses, one per call; the last one repeats.
const stubSequence = (responses) => {
  let index = 0;
  return stubFetch(() => {
    const respond = responses[Math.min(index++, responses.length - 1)];
    return respond();
  });
};

const ok = () => jsonResponse({ choices: [{ message: { content: 'Hello!' } }] });
const failing = (status) => () => jsonResponse({ error: 'nope' }, status);

test('chat retries a failure until it succeeds', async () => {
  const { calls, restore } = stubSequence([
    failing(503),
    () => {
      throw new TypeError('fetch failed');
    },
    ok
  ]);
  try {
    assert.deepEqual(await chat('Say hello', { baseDelay: 1 }), { data: 'Hello!' });
    assert.equal(calls.length, 3);
  } finally {
    restore();
  }
});

test('chat gives up after 5 retries', async () => {
  const { calls, restore } = stubSequence([failing(429)]);
  try {
    assert.deepEqual(await chat('Say hello', { baseDelay: 1 }), { error: 'HTTP 429' });
    assert.equal(calls.length, 6);
  } finally {
    restore();
  }
});

test('chat backs off exponentially between retries', async () => {
  const times = [];
  const { restore } = stubFetch(() => {
    times.push(Date.now());
    return failing(500)();
  });
  try {
    await chat('Say hello', { baseDelay: 10 });
    const gaps = times.slice(1).map((time, i) => time - times[i]);
    // Expected delays: 10, 20, 40, 80, 160 ms; timers never fire early.
    gaps.forEach((gap, i) => assert.ok(gap >= 10 * 2 ** i - 1, `gap ${i} was ${gap}ms`));
  } finally {
    restore();
  }
});

test('chat does not retry a rejected request', async () => {
  const { calls, restore } = stubSequence([failing(401)]);
  try {
    assert.deepEqual(await chat('Say hello', { baseDelay: 1 }), { error: 'HTTP 401' });
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('rawChat sends a whole conversation as is', async () => {
  const messages = [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Say hello' }
  ];
  const { calls, restore } = stubFetch(() => jsonResponse({ choices: [{ message: { content: 'Hi' } }] }));
  try {
    assert.deepEqual(await rawChat(messages), { data: 'Hi' });
    assert.deepEqual(JSON.parse(calls[0].opts.body).messages, messages);
  } finally {
    restore();
  }
});
