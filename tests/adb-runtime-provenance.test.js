const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');

/** Node>=22执行node --test tests/adb-runtime-provenance.test.js：核对官方pin、完整哈希、侧车一致性和四宿主runtime发布字节（历史provenance相对路径只作来源记录）；不连接设备。 */
test('staged ADB provenance matches every declared runtime file on all four hosts', () => {
  const record = JSON.parse(fs.readFileSync(path.join(root, 'resources/platform-tools/adb-runtime-provenance.json'), 'utf8'));
  const hosts = ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'];
  const pins = { win: 'e03e78b1d80b396f1c3358e31251cb31740e1110', linux: '477254aa5f903c15cf51001717bdf347fb6b53e0', darwin: '6ae73f4de6452dc57e62ec02b68eed92a4c21661' };
  assert.equal(record.schemaVersion, 1); assert.equal(record.version, '37.0.1');
  assert.deepEqual(Object.keys(record.hosts).sort(), [...hosts].sort());
  let count = 0;
  for (const host of hosts) {
    const entry = record.hosts[host];
    const distribution = host.startsWith('win32') ? 'win' : host.startsWith('linux') ? 'linux' : 'darwin';
    assert.equal(entry.archive.url, 'https://dl.google.com/android/repository/platform-tools_r37.0.1-' + distribution + '.zip');
    assert.equal(entry.archive.sha1, pins[distribution]); assert.match(entry.archive.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(entry.archive.bytes) && entry.archive.bytes > 0);
    assert.equal(entry.provenance, host + '/adb-provenance.json');
    const detail = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'platform-tools', host, path.basename(entry.provenance)), 'utf8'));
    assert.equal(detail.schemaVersion, 1); assert.equal(detail.version, record.version); assert.equal(detail.host, host);
    assert.deepEqual(detail.archive, entry.archive); assert.deepEqual(detail.payloads, entry.payloads);
    assert.equal(detail.notices.path, 'NOTICE.txt'); assert.equal(detail.notices.versionMetadata, 'source.properties');
    assert.ok(Array.isArray(entry.payloads));
    const names = entry.payloads.map(payload => payload.path);
    assert.equal(new Set(names).size, names.length);
    for (const name of [host === 'win32-x64' ? 'adb.exe' : 'adb', 'NOTICE.txt', 'source.properties']) assert.ok(names.includes(name));
    if (host === 'win32-x64') for (const name of ['AdbWinApi.dll', 'AdbWinUsbApi.dll']) assert.ok(names.includes(name));
    for (const payload of entry.payloads) {
      assert.match(payload.path, /^[A-Za-z0-9_.-]+$/); assert.match(payload.sha256, /^[a-f0-9]{64}$/);
      assert.equal(payload.exactUpstreamBytes, true);
      const file = path.join(root, 'resources', 'platform-tools', host, payload.path);
      assert.equal(fs.lstatSync(file).isFile(), true);
      const bytes = fs.readFileSync(file);
      assert.ok(bytes.length > 0); assert.equal(bytes.length, payload.bytes);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), payload.sha256, host + '/' + payload.path);
      count++;
    }
    assert.match(fs.readFileSync(path.join(root, 'resources', 'platform-tools', host, 'source.properties'), 'utf8'), /Pkg[.]Revision=37[.]0[.]1/);
  }
  assert.equal(count, 14);
});
