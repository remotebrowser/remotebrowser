import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { imageStatus, makeUnattendIso, missingSource, prepareSource } from './windows-image.js';

const KEY = 'W269N-WFGWX-YVC9B-4J6C9-T83GX';

// The iso dir, as the sysadmin and prepareSource leave it.
const isos = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'windows-'));
  const isoDir = path.join(dir, 'iso');
  mkdirSync(isoDir);
  writeFileSync(path.join(isoDir, 'windows-11.iso'), 'w');
  writeFileSync(path.join(isoDir, 'virtio-win.iso'), 'v');
  writeFileSync(path.join(isoDir, '3proxy-1.0.2-x64.zip'), 'z');
  return { dir, isoDir };
};

test('makeUnattendIso fills in the key and a password, with the 3proxy zip, and the first ISO tool there', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'unattend-'));
  const threeproxyZip = path.join(dir, '3proxy-1.0.2-x64.zip');
  writeFileSync(threeproxyZip, 'zip');
  const calls = [];
  const run = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'xorriso') {
      return { code: 127, stdout: '', stderr: '' };
    }
    if (argv.includes('-o')) {
      const files = argv.at(-1);
      calls.push(readFileSync(path.join(files, 'autounattend.xml'), 'utf8'));
      calls.push(readFileSync(path.join(files, 'remotebrowser-setup.ps1'), 'utf8'));
      calls.push(readFileSync(path.join(files, '3proxy.zip'), 'utf8'));
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const iso = await makeUnattendIso({ dir, productKey: KEY, threeproxyZip, run });
  assert.equal(iso, path.join(dir, 'unattend.iso'));
  const make = calls.find((call) => Array.isArray(call) && call.includes('-o'));
  assert.equal(make[0], 'genisoimage');
  const [xml, ps1, zip] = calls.filter((call) => typeof call === 'string');
  assert.ok(xml.includes(`<Key>${KEY}</Key>`));
  assert.doesNotMatch(xml + ps1, /\{\{/);
  const password = /<Value>([^<]+)<\/Value>/.exec(xml)[1];
  assert.ok(ps1.includes(`'${password}'`));
  assert.equal(zip, 'zip');
});

test('makeUnattendIso fails when no ISO tool is there', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'unattend-'));
  const run = async () => ({ code: 127, stdout: '', stderr: '' });
  await assert.rejects(makeUnattendIso({ dir, productKey: KEY, run }), /xorriso, genisoimage, or mkisofs/);
});

test('imageStatus names a new build when the ISOs or the key change', async () => {
  const { dir, isoDir } = isos();
  const imagesDir = path.join(dir, 'images', 'windows-11');
  const first = await imageStatus({ imagesDir, arch: 'x86_64', isoDir });
  assert.equal(first.current, false);
  assert.match(first.image, /images[/\\]windows-11[/\\]x86_64-[0-9a-f]{16}[/\\]windows\.qcow2$/);
  const other = await imageStatus({ imagesDir, arch: 'x86_64', isoDir, productKey: 'NPPR9-FWDCX-D2C8J-H872K-2YT43' });
  assert.notEqual(other.image, first.image);
});

test('imageStatus fails when an ISO is missing', async () => {
  const { dir, isoDir } = isos();
  rmSync(path.join(isoDir, 'virtio-win.iso'));
  await assert.rejects(imageStatus({ imagesDir: dir, arch: 'x86_64', isoDir }), /virtio-win\.iso is not there/);
});

test('missingSource asks for the install ISO, and an x86_64 host', async () => {
  const { isoDir } = isos();
  assert.equal(await missingSource({ isoDir, arch: 'x86_64' }), null);
  assert.match(await missingSource({ isoDir, arch: 'aarch64' }), /needs an x86_64 host/);
  rmSync(path.join(isoDir, 'windows-11.iso'));
  assert.match(await missingSource({ isoDir, arch: 'x86_64' }), /No Windows 11 install ISO at .*windows-11\.iso/);
});

test('prepareSource downloads the virtio-win ISO and the 3proxy zip once, and keeps no part of a failed download', async () => {
  const { isoDir } = isos();
  rmSync(path.join(isoDir, 'virtio-win.iso'));
  rmSync(path.join(isoDir, '3proxy-1.0.2-x64.zip'));
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return new Response(url.includes('3proxy') ? 'proxy' : 'virtio');
  };
  await prepareSource({ isoDir, fetchImpl });
  await prepareSource({ isoDir, fetchImpl });
  assert.equal(urls.length, 2);
  assert.equal(readFileSync(path.join(isoDir, 'virtio-win.iso'), 'utf8'), 'virtio');
  assert.equal(readFileSync(path.join(isoDir, '3proxy-1.0.2-x64.zip'), 'utf8'), 'proxy');

  rmSync(path.join(isoDir, 'virtio-win.iso'));
  await assert.rejects(
    prepareSource({ isoDir, fetchImpl: async () => new Response('gone', { status: 404 }) }),
    /HTTP 404/
  );
  assert.equal(existsSync(path.join(isoDir, 'virtio-win.iso')), false);
  assert.deepEqual(readdirSync(isoDir).sort(), ['3proxy-1.0.2-x64.zip', 'windows-11.iso']);
});
