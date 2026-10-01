import test from 'node:test';
import assert from 'node:assert/strict';
import { playwrightJavascriptDisplaySource, playwrightJavascriptSource } from './code-sample.js';

// Nothing about the real URL reaches the screen; only the copied source has it.
test('playwrightJavascriptDisplaySource masks the whole CDP URL', () => {
  const source = playwrightJavascriptDisplaySource();
  assert.match(source, /connectOverCDP\(\*+\)/);
  assert.doesNotMatch(source, /\/cdp\//);
  assert.doesNotMatch(source, /wss?:/);
});

test('playwrightJavascriptSource carries the real URL and handle for copying', () => {
  const source = playwrightJavascriptSource('wss://example.com/cdp/Htestbrowserhandle', 'Htestbrowserhandle');
  assert.match(source, /const handle = 'Htestbrowserhandle';/);
  assert.match(source, /const remote = `wss:\/\/example\.com\/cdp\/\$\{handle\}`;/);
  assert.match(source, /connectOverCDP\(remote\)/);
  assert.ok(source.indexOf('const handle') < source.indexOf('const remote'), 'handle must be declared before remote');
});

// The preamble is the instruction half of the block; both the masked display
// source and the copied full source must lead with it.
test('both sources lead with the instruction preamble', () => {
  for (const source of [
    playwrightJavascriptDisplaySource(),
    playwrightJavascriptSource('wss://example.com/cdp/Htestbrowserhandle', 'Htestbrowserhandle')
  ]) {
    assert.match(source, /^Use the reference code below to write and run a Playwright script/);
  }
});

// The instruction is pasted into a chat UI, so the sample is fenced for its
// renderer; require keeps the pasted snippet runnable as a plain .js file.
test('both sources fence the sample and keep it plain .js compatible', () => {
  for (const source of [
    playwrightJavascriptDisplaySource(),
    playwrightJavascriptSource('wss://example.com/cdp/Htestbrowserhandle', 'Htestbrowserhandle')
  ]) {
    assert.match(source, /```js\nconst \{ chromium \} = require\('playwright'\);/);
    assert.doesNotMatch(source, /^import /m);
    assert.ok(source.endsWith('```'));
  }
});
