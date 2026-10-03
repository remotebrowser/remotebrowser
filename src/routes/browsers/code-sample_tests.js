import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTRUCTION_PREAMBLE,
  fullInstructionSource,
  playwrightJavascriptDisplaySource,
  playwrightJavascriptSource
} from './code-sample.js';

// Nothing about the real URL reaches the screen; only the copied source has it.
test('playwrightJavascriptDisplaySource masks the whole CDP URL', () => {
  const source = playwrightJavascriptDisplaySource();
  assert.match(source, /connectOverCDP\(\*+\)/);
  assert.doesNotMatch(source, /\/cdp\//);
  assert.doesNotMatch(source, /wss?:/);
});

// The display <pre> is only the sample; the prose preamble is rendered as its
// own paragraph, so the two together make up the full instruction. The fence
// is added as a visually-hidden line by the view, not baked into this source.
test('playwrightJavascriptDisplaySource is just the sample, not the preamble or fence', () => {
  const source = playwrightJavascriptDisplaySource();
  assert.doesNotMatch(source, /^Use the reference code below/);
  assert.doesNotMatch(source, /```/);
  assert.match(source, /^const \{ chromium \} = require\('playwright'\);/);
});

test('playwrightJavascriptSource carries the real URL and handle for copying', () => {
  const source = playwrightJavascriptSource('wss://example.com/cdp/Htestbrowserhandle', 'Htestbrowserhandle');
  assert.match(source, /const handle = 'Htestbrowserhandle';/);
  assert.match(source, /const remote = `wss:\/\/example\.com\/cdp\/\$\{handle\}`;/);
  assert.match(source, /connectOverCDP\(remote\)/);
  assert.ok(source.indexOf('const handle') < source.indexOf('const remote'), 'handle must be declared before remote');
});

// The whole instruction, for the Copy button: preamble then fenced sample.
test('fullInstructionSource copies the preamble and the real sample as one block', () => {
  const source = fullInstructionSource('wss://example.com/cdp/Htestbrowserhandle', 'Htestbrowserhandle');
  assert.match(source, /^Use the reference code below/);
  assert.match(source, /const handle = 'Htestbrowserhandle';/);
  assert.match(source, /connectOverCDP\(remote\)/);
  assert.ok(source.endsWith('```'));
});

test('INSTRUCTION_PREAMBLE is the prose half shared by both sources', () => {
  assert.match(INSTRUCTION_PREAMBLE, /^Use the reference code below to write and run a Playwright script/);
  assert.ok(playwrightJavascriptSource('wss://x/cdp/Ha', 'Ha').startsWith(INSTRUCTION_PREAMBLE));
});

// The instruction is pasted into a chat UI, so the copied source is fenced for
// its renderer; require keeps the pasted snippet runnable as a plain .js file.
// The display source has no fence - the view hides that line instead.
test('both sources keep the sample plain .js compatible; the copied one is fenced', () => {
  const copied = playwrightJavascriptSource('wss://example.com/cdp/Htestbrowserhandle', 'Htestbrowserhandle');
  assert.match(copied, /```js\nconst \{ chromium \} = require\('playwright'\);/);
  assert.ok(copied.endsWith('```'));
  for (const source of [playwrightJavascriptDisplaySource(), copied]) {
    assert.doesNotMatch(source, /^import /m);
  }
});
