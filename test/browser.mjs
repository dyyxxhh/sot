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
const gpg = (...args) => execFileSync('gpg', ['--homedir', dir, '--batch', ...args]);
const tar = (...args) => execFileSync('tar', args);
const entries = path => tar('-tf', path).toString().trimEnd().split('\n');
const extract = (path, name) => tar('-xOf', path, name);
const server = process.env.SOT_TEST_URL ? null : spawn(process.execPath, [process.env.SOT_TEST_SERVER ?? 'server.mjs'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
});
const exited = server && once(server, 'exit');
let browser;
try {
  const url = process.env.SOT_TEST_URL ?? await Promise.race([
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
  const id = name => page.locator(`#${name}`);
  const file = (name, values) => id(name).setInputFiles(values);
  const click = name => id(name).click();
  const expectText = (name, wanted) => id(name).filter({ hasText: wanted }).waitFor();
  const selectView = async view => {
    if (await id('back').isVisible()) await click('back');
    await page.locator(`[data-view=${view}]`).click();
  };
  const download = async (section, name) => {
    const link = id(section).getByRole('link', { name: `下载 ${name}`, exact: true });
    const [receipt] = await Promise.all([page.waitForEvent('download'), link.click()]);
    assert.equal(receipt.suggestedFilename(), name);
    const path = join(dir, name);
    await receipt.saveAs(path);
    return path;
  };
  const make = async () => { await click('make-review'); await click('make-confirm'); };
  await page.goto(url);
  assert.deepEqual(await page.locator('[data-view]').allTextContents(), ['制作', '验证', '补全']);
  assert.equal(await page.locator('input[type=file]:visible').count(), 0);
  for (const view of ['create', 'verify', 'complete']) {
    await selectView(view);
    assert.equal(await page.locator('input[type=file]:visible').count(), 1);
  }
  await expectText('offline-state', '离线工具已缓存');
  await page.evaluate(() => new Promise(resolve => {
    if (navigator.serviceWorker.controller) resolve();
    else navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
  }));
  await click('open-settings');
  assert.equal(await id('display-time-zone').inputValue(), 'UTC');
  const [guide] = await Promise.all([page.waitForEvent('download'), id('settings').getByRole('link', { name: '下载验证说明' }).click()]);
  assert.equal(guide.suggestedFilename(), 'VERIFY.txt');
  assert.equal(await guide.failure(), null);
  await id('settings').getByRole('button', { name: '完成' }).click();
  gpg('--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'SOT Browser Fixture <fixture@example.invalid>', 'ed25519', 'sign', '1d');
  const key = join(dir, 'public.asc'), signature = join(dir, 'hello-world.txt.sig');
  await writeFile(key, gpg('--armor', '--export', 'fixture@example.invalid'));
  gpg('--pinentry-mode', 'loopback', '--passphrase', '', '--output', signature, '--detach-sign', original);
  gpg('--verify', signature, original);

  await context.setOffline(true);
  await page.reload();
  await expectText('offline-state', '离线工具已缓存');
  const offlineRequests = [];
  const collectOffline = request => { if (/^https?:/.test(request.url())) offlineRequests.push(request.url()); };
  page.on('request', collectOffline);

  await selectView('create');
  await file('make-input', fixture('hello-freetsa.tsr'));
  await click('make-review');
  await expectText('make-status', '请补充原文件或分离签名');
  await file('make-original', fixture('incomplete.txt'));
  await click('make-review');
  await expectText('make-status', '未匹配任何已选');
  assert.equal(await id('make-confirm').isVisible(), false);
  await file('make-original', original);
  await file('make-existing', fixture('hello-world.txt.ots'));
  await page.locator('input[value=fsot]').check();
  await make();
  const archive = await download('make-status', 'hello-world.txt.fsot');
  assert.deepEqual(new Set(entries(archive)), new Set(['hello-world.txt', 'hello-world.txt.ots', 'hello-world.txt-freetsa.tsr']));
  const before = new Map(entries(archive).map(name => [name, extract(archive, name)]));

  await file('make-input', original);
  await file('make-existing', fixture('hello-freetsa.tsr'));
  await click('make-review');
  await expectText('make-status', '不联网，仅打包已有时间戳');
  await file('make-existing', []);
  assert.equal(await id('make-confirm').isVisible(), false);

  await selectView('verify');
  await file('verify-input', archive);
  await id('verify-online').waitFor();
  assert.deepEqual(await page.locator('#verify .actions button:visible').allTextContents(), ['在线验证', '离线验证']);
  assert.notEqual(await id('verify-online').evaluate(b => getComputedStyle(b).backgroundColor), await id('verify-local').evaluate(b => getComputedStyle(b).backgroundColor));
  await click('verify-local');
  await expectText('verify-status', '缺少区块头');
  await expectText('verify-status', 'hello-world.txt-freetsa.tsr（原文件）：有效');
  await file('verify-headers', fixture('header.json'));
  await click('verify-local');
  await expectText('verify-status', '与提供的本地区块记录相符 · 区块 358391');

  await expectText('verify-summary', '联合校验未通过');
  await expectText('verify-summary', '2026.11.24 10:46.43');
  await expectText('verify-summary', '24 小时');
  await expectText('verify-summary', '300 秒');
  assert.equal(await id('verify-summary').getAttribute('data-result'), 'fail');
  assert.equal(await id('verify-summary').locator('time').evaluate(el => getComputedStyle(el).color), 'rgb(146, 36, 36)');
  const proofClocks = id('verify-status').locator('time');
  assert.equal(await proofClocks.count(), 2);
  for (const time of await proofClocks.all()) {
    const style = await time.evaluate(el => [getComputedStyle(el).color, Number(getComputedStyle(el).fontWeight)]);
    assert.equal(style[0], 'rgb(71, 129, 79)');
    assert.ok(style[1] >= 700);
  }
  const instants = await proofClocks.evaluateAll(times => times.map(time => time.dateTime));
  await click('open-settings');
  await id('display-time-zone').selectOption('Asia/Shanghai');
  await id('settings').getByRole('button', { name: '完成' }).click();
  await expectText('verify-summary', '2026.11.24 18:46.43');
  await expectText('verify-summary', 'Asia/Shanghai');
  await expectText('verify-status', '2026.11.24 18:46.43');
  assert.deepEqual(await proofClocks.evaluateAll(times => times.map(time => time.dateTime)), instants);
  assert.equal(await id('verify-summary').getAttribute('data-result'), 'fail');

  await selectView('complete');
  // A legacy extra .tar suffix is accepted but never emitted.
  const legacy = join(dir, 'hello-world.txt.fsot.tar');
  await writeFile(legacy, await readFile(archive));
  await file('complete-input', legacy);
  await id('complete-signature').waitFor();
  await file('complete-signature', signature);
  assert.equal(await id('complete-status').getByRole('link').count(), 0);
  await click('attach');
  await expectText('complete-status', '已有时间戳不覆盖新签名');
  await download('complete-status', 'hello-world.txt.fsot');
  for (const [name, bytes] of before) assert.deepEqual(extract(archive, name), bytes);
  assert.deepEqual(extract(archive, 'hello-world.txt.sig'), await readFile(signature));

  await selectView('verify');
  await file('verify-input', archive);
  await id('verify-key').waitFor();
  await file('verify-key', key);
  await click('verify-local');
  await expectText('verify-status', 'OpenPGP：有效');
  assert.doesNotMatch(await id('verify-status').innerText(), /结合验签/);
  for (const name of entries(archive)) assert.deepEqual(await readFile(await download('verify-status', name)), extract(archive, name));
  for (const armored of [true, false]) {
    const args = armored ? ['--armor'] : [];
    const secretFixture = gpg('--pinentry-mode', 'loopback', '--passphrase', '', ...args, '--export-secret-keys', 'fixture@example.invalid');
    await file('verify-key', { name: 'scratch-key.pgp', mimeType: 'application/pgp-keys', buffer: secretFixture });
    await click('verify-local');
    await expectText('verify-status', /OpenPGP：验签失败；.*私钥/);
  }
  await file('verify-input', signature);
  await file('verify-original', original);
  await file('verify-key', key);
  await click('verify-local');
  await expectText('verify-status', 'OpenPGP：有效');
  await file('verify-input', fixture('hello-freetsa.tsr'));
  await file('verify-target', original);
  await click('verify-local');
  await expectText('verify-status', 'hello-freetsa.tsr（打戳对象）：有效');
  await file('verify-input', fixture('hello-world.txt.ots'));
  await file('verify-target', original);
  await file('verify-headers', fixture('header.json'));
  await click('verify-local');
  await expectText('verify-status', '与提供的本地区块记录相符 · 区块 358391');
  assert.deepEqual(offlineRequests, []);
  page.off('request', collectOffline);
  console.log('PASS: three entries, two-stage creation, native tar, exact downloads, offline individual verification, and offline signature attachment');

  if (process.env.LIVE === '1') {
    await context.setOffline(false);
    await file('verify-headers', []);
    await click('verify-online');
    await expectText('verify-status', '两个区块浏览器查询的记录相符 · 区块 358391');
    await selectView('create');
    await file('make-input', signature);
    assert.equal(await id('make-fsot').isDisabled(), true);
    for (const name of ['digicert', 'freetsa', 'ots']) await page.locator(`input[value=${name}]`).check();
    const issued = [];
    const collectIssuance = request => { if (request.method() === 'POST') issued.push(request.url()); };
    page.on('request', collectIssuance);
    await click('make-review');
    await expectText('make-status', '将联网给签名文件打戳');
    assert.deepEqual(issued, []);
    await click('make-confirm');
    await expectText('make-status', '下载 hello-world.txt.asot');
    const status = await id('make-status').innerText();
    assert.match(status, /DigiCert：已签发并验证/);
    assert.match(status, /FreeTSA：已签发并验证/);
    assert.match(status, /OpenTimestamps：已取得回执/);
    page.off('request', collectIssuance);
    const live = await download('make-status', 'hello-world.txt.asot');
    assert.deepEqual(new Set(entries(live)), new Set(['hello-world.txt.sig', 'hello-world.txt.sig-digicert.tsr', 'hello-world.txt.sig-freetsa.tsr', 'hello-world.txt.sig.ots']));
    for (const authority of ['digicert', 'freetsa']) {
      const tsr = join(dir, `${authority}.tsr`);
      await writeFile(tsr, extract(live, `hello-world.txt.sig-${authority}.tsr`));
      execFileSync('openssl', ['ts', '-verify', '-data', signature, '-in', tsr, '-CAfile', resolve(`public/roots/${authority}.pem`)]);
    }
    if (process.env.OTS_CLI === '1') {
      const ots = join(dir, 'test.sig.ots');
      await writeFile(ots, extract(live, 'hello-world.txt.sig.ots'));
      const output = execFileSync('uvx', ['--from', 'opentimestamps-client', 'ots', 'info', ots], { encoding: 'utf8' });
      assert.match(output, /PendingAttestation|BlockHeaderAttestation/);
    }
    await selectView('verify');
    await file('verify-input', live);
    await click('verify-local');
    await expectText('verify-status', 'hello-world.txt.sig-freetsa.tsr（签名文件）：有效');
    await file('verify-original', original);
    await id('verify-key').waitFor();
    await file('verify-key', key);
    await click('verify-local');
    await expectText('verify-status', '结合验签：这版文件最晚在');

    // This upstream receipt starts pending, but its calendar now has a block proof.
    const pendingReceipt = fixture('incomplete.txt.ots');
    await selectView('complete');
    await file('complete-input', pendingReceipt);
    await click('upgrade');
    await expectText('complete-status', '已包含区块证明');
    const upgradedReceipt = await download('complete-status', 'incomplete.txt.ots');
    assert.notDeepEqual(await readFile(upgradedReceipt), await readFile(pendingReceipt));
    await selectView('create');
    await file('make-input', pendingReceipt);
    await file('make-original', fixture('incomplete.txt'));
    await page.locator('input[value=fsot]').check();
    await make();
    const pending = await download('make-status', 'incomplete.txt.fsot');
    await selectView('complete');
    await file('complete-input', pending);
    await click('upgrade');
    await expectText('complete-status', '已包含区块证明');
    await download('complete-status', 'incomplete.txt.fsot');
    assert.deepEqual(extract(pending, 'incomplete.txt'), await readFile(fixture('incomplete.txt')));
    assert.notDeepEqual(extract(pending, 'incomplete.txt.ots'), await readFile(pendingReceipt));
    await selectView('verify');
    await file('verify-input', pending);
    await click('verify-online');
    await expectText('verify-status', '两个区块浏览器查询的记录相符 · 区块 428648');
    console.log('PASS: live DigiCert, FreeTSA and OTS with signature only; native OpenSSL; upgrade of standalone and archived OTS');
  }
  await page.reload();
  await click('open-settings');
  assert.equal(await id('display-time-zone').inputValue(), 'Asia/Shanghai');
  assert.deepEqual(errors, []);
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    for (const name of ['make', 'verify', 'complete']) console.error(name + ':', await page.locator(`#${name}-status`).textContent().catch(() => 'unavailable'));
  }
  throw error;
} finally {
  await browser?.close();
  if (server) { server.kill(); await exited; }
}
