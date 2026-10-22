import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readSuspendedPreviewImage,
  readSuspendedPreviewList,
  removeSuspendedPreviews,
  writeSuspendedPreviews
} from './previews.js';

const vmDir = () => mkdtempSync(path.join(tmpdir(), 'previews-'));

const preview = (pageId, data = `png of ${pageId}`) => ({
  pageId,
  title: `Title of ${pageId}`,
  url: `https://example.com/${pageId}`,
  data: Buffer.from(data)
});

test('keeps each page, in order, with its picture', async () => {
  const dir = vmDir();
  await writeSuspendedPreviews(dir, [preview('page0'), preview('page1')]);
  assert.deepEqual(await readSuspendedPreviewList(dir), [
    { pageId: 'page0', title: 'Title of page0', url: 'https://example.com/page0' },
    { pageId: 'page1', title: 'Title of page1', url: 'https://example.com/page1' }
  ]);
  assert.equal((await readSuspendedPreviewImage(dir, 'page1')).toString(), 'png of page1');
});

test('a new suspend replaces the pictures of the last one', async () => {
  const dir = vmDir();
  await writeSuspendedPreviews(dir, [preview('page0'), preview('page1')]);
  await writeSuspendedPreviews(dir, [preview('page2')]);
  assert.deepEqual(
    (await readSuspendedPreviewList(dir)).map(({ pageId }) => pageId),
    ['page2']
  );
  assert.equal(await readSuspendedPreviewImage(dir, 'page0'), null);
  assert.equal(existsSync(path.join(dir, 'suspended-previews.part')), false);
});

test('a page id only looks up the list, so it cannot name a file', async () => {
  const dir = vmDir();
  writeFileSync(path.join(dir, 'secret'), 'secret');
  await writeSuspendedPreviews(dir, [preview('page0')]);
  for (const pageId of ['../secret', '0', '0.png', 'pages.json', '']) {
    assert.equal(await readSuspendedPreviewImage(dir, pageId), null, pageId);
  }
});

test('none at all, or removed, reads as no pictures', async () => {
  const dir = vmDir();
  assert.deepEqual(await readSuspendedPreviewList(dir), []);
  assert.equal(await readSuspendedPreviewImage(dir, 'page0'), null);
  await writeSuspendedPreviews(dir, [preview('page0')]);
  await removeSuspendedPreviews(dir);
  assert.deepEqual(await readSuspendedPreviewList(dir), []);
  // A browser with no open page still suspends; it just has nothing to show.
  await writeSuspendedPreviews(dir, []);
  assert.deepEqual(await readSuspendedPreviewList(dir), []);
});
