import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readAnyScreenshot,
  readSuspendedPreviewImage,
  readSuspendedPreviewList,
  removeSuspendedPreviews,
  writeSuspendedPreviews
} from './previews.js';

const vmDir = () => mkdtempSync(path.join(tmpdir(), 'previews-'));

const preview = (pageId, data = `jpeg of ${pageId}`) => ({
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
  assert.equal((await readSuspendedPreviewImage(dir, 'page1')).toString(), 'jpeg of page1');
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
  for (const pageId of ['../secret', '0', '0.jpg', 'pages.json', '']) {
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

test('any picture: the first suspended page, else the newest saved frame, else none', async () => {
  const dir = vmDir();
  assert.equal(await readAnyScreenshot(dir), null);
  assert.equal(await readAnyScreenshot(path.join(dir, 'gone')), null);
  writeFileSync(path.join(dir, 'screenshot-OLD.jpg'), 'old');
  utimesSync(path.join(dir, 'screenshot-OLD.jpg'), 1000, 1000);
  writeFileSync(path.join(dir, 'screenshot-NEW.jpg'), 'new');
  writeFileSync(path.join(dir, 'screenshot-NEW.jpg.part'), 'half');
  const newest = await readAnyScreenshot(dir);
  assert.equal(newest.pageId, 'NEW');
  assert.equal(newest.data.toString(), 'new');
  assert.ok(newest.timestamp > 1000 * 1000, 'the file time');
  await writeSuspendedPreviews(dir, [preview('page0'), preview('page1')]);
  const first = await readAnyScreenshot(dir);
  assert.equal(first.pageId, 'page0');
  assert.equal(first.data.toString(), 'jpeg of page0');
  assert.ok(first.timestamp > 0);
});
