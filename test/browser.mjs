import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const dir = await mkdtemp(join(tmpdir(), 'sot-browser-'));
const fixture = name => resolve('test/fixtures', name);
const original = fixture('hello-world.txt');
const gpg = (...args) => execFileSync('gpg', ['--homedir', dir, '--batch', ...args], { encoding: null });
const tar = (...args) => execFileSync('tar', args);
const canRunOts = process.env.OTS_CLI === '1';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
const exited = once(server, 'exit');
let browser;
try {
  const url = await Promise.race([
    once(server.stdout, 'data').then(([data]) => data.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]),
    exited.then(([code]) => { throw new Error(`server exited with code ${code}`); }),
  ]);
  assert.ok(url);
  const errors = [];
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/usr/bin/google-chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(25_000);
  const file = (id, values) => page.locator(`#${id}`).setInputFiles(values);
  const click = id => page.locator(`#${id}`).click();
  const expectText = (id, wanted) => page.locator(`#${id}`).filter({ hasText: wanted }).waitFor();
  const selectView = view => page.locator(`[data-view=${view}]`).click();
  const download = async (id, path) => {
    const [receipt] = await Promise.all([page.waitForEvent('download'), page.locator(`#${id} a`).click()]);
    await receipt.saveAs(path);
    return receipt.suggestedFilename();
  };
  await page.goto(url);
  await expectText('offline-state', '离线工具已缓存');
  await page.evaluate(() => new Promise(resolve => {
    if (navigator.serviceWorker.controller) resolve();
    else navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
  }));
  gpg('--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'SOT Browser Fixture <fixture@example.invalid>', 'ed25519', 'sign', '1d');
  const key = join(dir, 'public.asc'), signature = join(dir, 'test.sig');
  await writeFile(key, gpg('--armor', '--export', 'fixture@example.invalid'));
  gpg('--pinentry-mode', 'loopback', '--passphrase', '', '--output', signature, '--detach-sign', original);
  gpg('--verify', signature, original);

  await context.setOffline(true);
  await page.reload();
  await expectText('offline-state', '离线工具已缓存');
  const offlineRequests = [];
  const collectOffline = request => { if (/^https?:/.test(request.url())) offlineRequests.push(request.url()); };
  page.on('request', collectOffline);
  await file('original', original);
  await file('existing', [fixture('hello-world.txt.ots'), fixture('hello-freetsa.tsr')]);
  await page.locator('input[value=fsot]').check();
  await click('pack-only');
  await expectText('make-status', '下载 hello-world.txt.fsot');
  const archive = join(dir, 'hello-world.txt.fsot');
  assert.equal(await download('make-status', archive), 'hello-world.txt.fsot');
  assert.deepEqual(tar('-tf', archive).toString().trimEnd().split('\n'), ['hello-world.txt', 'hello-world.txt.ots', 'hello-world.txt-freetsa.tsr']);
  await selectView('verify');
  await file('archive', archive);
  await click('verify-local');
  await expectText('verify-status', '缺少区块头');
  await expectText('verify-status', 'hello-world.txt-freetsa.tsr（原文件）：有效');
  await file('headers', fixture('header.json'));
  await click('verify-local');
  await expectText('verify-status', '与提供的本地区块记录相符 · 区块 358391');
  await file('attach-file', signature);
  await expectText('verify-status', '已附加签名');
  await download('verify-status', archive);
  const packedSignature = join(dir, 'unpacked.sig');
  await writeFile(packedSignature, tar('-xOf', archive, 'hello-world.txt.sig'));
  gpg('--verify', packedSignature, original);
  await file('archive', archive);
  await file('public-key', key);
  await click('verify-local');
  await expectText('verify-status', 'OpenPGP：有效');
  assert.doesNotMatch(await page.locator('#verify-status').innerText(), /结合验签/);
  for (const armored of [true, false]) {
    const args = armored ? ['--armor'] : [];
    const secretFixture = gpg('--pinentry-mode', 'loopback', '--passphrase', '', ...args, '--export-secret-keys', 'fixture@example.invalid');
    await file('public-key', { name: 'scratch-key.pgp', mimeType: 'application/pgp-keys', buffer: secretFixture });
    await click('verify-local');
    await expectText('verify-status', /OpenPGP：验签失败；.*私钥/);
  }
  await file('public-key', key);
  assert.deepEqual(offlineRequests, []);
  page.off('request', collectOffline);
  console.log('PASS: offline reload, pack/import, native tar + GPG, FreeTSA, trusted Bitcoin header, later .sig not time-stamped');

  if (process.env.LIVE === '1') {
    await context.setOffline(false);
    await file('headers', []);
    await click('verify-online');
    await expectText('verify-status', '两个区块浏览器查询的记录相符 · 区块 358391');
    await selectView('create');
    await file('existing', []);
    await file('signature', signature);
    await page.locator('input[value=signature]').check();
    await page.locator('input[value=freetsa]').check();
    await page.locator('input[value=asot]').check();
    await click('make');
    await expectText('make-status', '下载 hello-world.txt.asot');
    const results = await page.locator('#make-status').innerText();
    console.log(results);
    assert.match(results, /DigiCert：已签发并验证/);
    assert.match(results, /FreeTSA：已签发并验证/);
    assert.match(results, /OpenTimestamps：已取得回执/);
    const live = join(dir, 'hello-world.txt.asot');
    await download('make-status', live);
    const entries = tar('-tf', live).toString().trimEnd().split('\n');
    assert.deepEqual(new Set(entries), new Set(['hello-world.txt.sig', 'hello-world.txt.sig-digicert.tsr', 'hello-world.txt.sig-freetsa.tsr', 'hello-world.txt.sig.ots']));
    for (const authority of ['digicert', 'freetsa']) {
      const tsr = join(dir, `${authority}.tsr`);
      await writeFile(tsr, tar('-xOf', live, `hello-world.txt.sig-${authority}.tsr`));
      execFileSync('openssl', ['ts', '-verify', '-data', signature, '-in', tsr, '-CAfile', resolve(`public/roots/${authority}.pem`)]);
    }
    if (canRunOts) {
      const ots = join(dir, 'test.sig.ots');
      await writeFile(ots, tar('-xOf', live, 'hello-world.txt.sig.ots'));
      const output = execFileSync('uvx', ['--from', 'opentimestamps-client', 'ots', 'info', ots], { encoding: 'utf8' });
      assert.match(output, /PendingAttestation|BlockHeaderAttestation/);
    }
    await selectView('verify');
    await file('archive', live);
    await file('external', original);
    await click('verify-local');
    await expectText('verify-status', '结合验签：这版文件最晚在');
    await click('upgrade');
    await expectText('verify-status', '下载 hello-world.txt.asot');

    // This upstream receipt starts pending, but its calendar now has the full proof.
    await selectView('create');
    await file('original', fixture('incomplete.txt'));
    await file('signature', []);
    await file('existing', fixture('incomplete.txt.ots'));
    await click('pack-only');
    await expectText('make-status', '下载 incomplete.txt.asot');
    const pending = join(dir, 'incomplete.txt.asot');
    await download('make-status', pending);
    await selectView('verify');
    await file('archive', pending);
    await file('external', fixture('incomplete.txt'));
    await click('verify-local');
    await expectText('verify-status', '尚无比特币区块证明');
    await click('upgrade');
    await expectText('verify-status', '已包含区块证明');
    await download('verify-status', pending);
    await file('archive', pending);
    await click('verify-online');
    await expectText('verify-status', '两个区块浏览器查询的记录相符 · 区块 428648');
    console.log('PASS: live DigiCert, FreeTSA and OTS stamps, native OpenSSL and optional ots interoperability, online block lookup and OTS upgrade flow');
  }
  assert.deepEqual(errors, []);
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    console.error('create:', await page.locator('#make-status').textContent().catch(() => 'unavailable'));
    console.error('verify:', await page.locator('#verify-status').textContent().catch(() => 'unavailable'));
  }
  throw error;
} finally {
  await browser?.close();
  server.kill();
  await exited;
}
