import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// A picture of each page as it was when the browser was suspended, so its page
// can show what comes back on resume. They live in the VM dir, next to the
// suspended state, and go with it:
//
//   suspended-previews/pages.json   [{pageId, title, url}], in tab order
//   suspended-previews/<n>.jpg      the screenshot of page n
//
// The files are named by position, never by a page id, so a page id from a
// request only ever looks up pages.json and cannot name a path.
const PREVIEWS = 'suspended-previews';

const previewsDir = (dir) => path.join(dir, PREVIEWS);

// Replaces any earlier previews. They are written to a new dir and renamed in
// place, so a reader never sees half of them.
const writeSuspendedPreviews = async (dir, previews) => {
  const target = previewsDir(dir);
  const partial = `${target}.part`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  await Promise.all(previews.map(({ data }, index) => writeFile(path.join(partial, `${index}.jpg`), data)));
  const pages = previews.map(({ pageId, title, url }) => ({ pageId, title, url }));
  await writeFile(path.join(partial, 'pages.json'), JSON.stringify(pages));
  await rm(target, { recursive: true, force: true });
  await rename(partial, target);
};

// The pages that have a saved preview, or none.
const readSuspendedPreviewList = async (dir) => {
  try {
    const pages = JSON.parse(await readFile(path.join(previewsDir(dir), 'pages.json'), 'utf8'));
    return Array.isArray(pages) ? pages : [];
  } catch {
    return [];
  }
};

// The saved screenshot of one page, or null.
const readSuspendedPreviewImage = async (dir, pageId) => {
  const index = (await readSuspendedPreviewList(dir)).findIndex((page) => page.pageId === pageId);
  if (index === -1) {
    return null;
  }
  return readFile(path.join(previewsDir(dir), `${index}.jpg`)).catch(() => null);
};

const removeSuspendedPreviews = (dir) => rm(previewsDir(dir), { recursive: true, force: true });

// The latest full-size frame of each page, as screenshot-<page-id>.jpg, so it
// can be seen from the host. Chrome's target ids are hex, so anything else is
// refused before it can name a path.
const SAFE_PAGE_ID = /^[A-Za-z0-9_-]+$/;

// Written next to it and renamed, so a reader never sees half a file. No mkdir:
// a VM dir that is gone means a stopped browser, which must stay gone.
const writeScreenshot = async (dir, pageId, jpeg) => {
  if (!SAFE_PAGE_ID.test(pageId)) {
    return;
  }
  const target = path.join(dir, `screenshot-${pageId}.jpg`);
  const partial = `${target}.part`;
  await writeFile(partial, jpeg);
  await rename(partial, target);
};

// The saved frame of a page and when it was taken, or null.
const readScreenshot = async (dir, pageId) => {
  if (!SAFE_PAGE_ID.test(pageId)) {
    return null;
  }
  const file = path.join(dir, `screenshot-${pageId}.jpg`);
  try {
    const [data, info] = await Promise.all([readFile(file), stat(file)]);
    return { data, timestamp: info.mtimeMs };
  } catch {
    return null;
  }
};

const SCREENSHOT_FILE = /^screenshot-([A-Za-z0-9_-]+)\.jpg$/;

// A picture of the browser when its pages cannot be listed, e.g. while it is
// suspended: the first page as it was when suspended, else the newest saved
// frame of any page. With its page and when it was taken, or null.
const readAnyScreenshot = async (dir) => {
  const [first] = await readSuspendedPreviewList(dir);
  const preview = first ? await readSuspendedPreviewImage(dir, first.pageId) : null;
  if (preview) {
    const info = await stat(path.join(previewsDir(dir), 'pages.json')).catch(() => null);
    return { pageId: first.pageId, data: preview, timestamp: info?.mtimeMs ?? 0 };
  }
  const names = await readdir(dir).catch(() => []);
  const saved = await Promise.all(
    names
      .filter((name) => SCREENSHOT_FILE.test(name))
      .map((name) =>
        stat(path.join(dir, name)).then(
          (info) => ({ name, mtimeMs: info.mtimeMs }),
          () => null
        )
      )
  );
  const newest = saved.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!newest) {
    return null;
  }
  const data = await readFile(path.join(dir, newest.name)).catch(() => null);
  return data ? { pageId: newest.name.match(SCREENSHOT_FILE)[1], data, timestamp: newest.mtimeMs } : null;
};

export {
  writeSuspendedPreviews,
  readSuspendedPreviewList,
  readSuspendedPreviewImage,
  removeSuspendedPreviews,
  writeScreenshot,
  readScreenshot,
  readAnyScreenshot
};
