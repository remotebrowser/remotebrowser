import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { absoluteOrigin } from './origin.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('absoluteOrigin falls back to the request when PUBLIC_ORIGIN is unset (development)', () => {
  const c = { req: { url: 'https://example.com/continue?nonce=abc' } };
  assert.equal(absoluteOrigin(c), 'https://example.com');
});

test('absoluteOrigin preserves a non-default port on the request fallback', () => {
  const c = { req: { url: 'http://localhost:3000/signin' } };
  assert.equal(absoluteOrigin(c), 'http://localhost:3000');
});

// The origin ends up as the sign-in link's continueUrl, i.e. where a sign-in
// link and its nonce are delivered, so a forged Host header must not be able
// to move it. Run in a child process because config is frozen at first require.
test('absoluteOrigin ignores the request Host entirely once PUBLIC_ORIGIN is configured', () => {
  const script = `
    const { absoluteOrigin } = require('./origin');
    const forged = { req: { url: 'https://attacker.example/continue?nonce=abc' } };
    console.log(absoluteOrigin(forged));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, PUBLIC_ORIGIN: 'https://app.example.com' }
  });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.toString().trim(), 'https://app.example.com');
});
