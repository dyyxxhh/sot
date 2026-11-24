import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkOriginal, makeBundle, readBundle } from '../src/bundle.mjs';
import { hashBlob, hex } from '../src/hash.mjs';
import { packTar } from '../src/tar.mjs';
import { readCertificate, verifyTsr } from '../src/tsa.mjs';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const root = async name => readCertificate(await readFile(new URL(`../public/roots/${name}.pem`, import.meta.url), 'utf8'));

for (const [authority, file, receipt, time] of [
  ['digicert', 'probe.sig', 'probe-digicert.tsr', '2026-11-23T22:29:38.000Z'],
  ['freetsa', 'hello-world.txt', 'hello-freetsa.tsr', '2026-11-24T10:46:43.000Z'],
]) test(`${authority}: accepts a real receipt and rejects a different file and root`, async () => {
  const token = new Blob([await fixture(receipt)]), target = new Blob([await fixture(file)]);
  const trust = { root: await root(authority), signer: authority === 'freetsa' ? await root('freetsa-signer') : undefined };
  assert.equal((await verifyTsr(token, target, trust)).time, time);
  await assert.rejects(verifyTsr(token, new Blob(['changed']), trust));
  await assert.rejects(verifyTsr(token, target, { root: await root(authority === 'digicert' ? 'freetsa' : 'digicert') }));
});

test('SHA-256 matches the OpenTimestamps upstream file digest', async () => {
  assert.equal(hex(await hashBlob(new Blob([await fixture('hello-world.txt')]))), '03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340');
});

test('rejects an oversized .fsot before processing the file and permits .asot', () => {
  const original = { size: 8589934592 };
  assert.throws(() => checkOriginal('fsot', original), /请选择 \.asot/);
  assert.doesNotThrow(() => checkOriginal('asot', original));
});

for (const kind of ['asot', 'fsot']) test(`${kind}: ordinary tar keeps exact Unicode paths, no extra entries, and original proof bytes`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sot-tar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const name = '测试'.repeat(40) + ' = .txt';
  const original = new File([await fixture('hello-world.txt')], name);
  const signature = new Blob(['signature fixture']);
  const proof = new Blob([await fixture('hello-world.txt.ots')]);
  const { filename, blob } = makeBundle({ kind, name, original, signature, proofs: [{ type: 'ots', target: 'file', blob: proof }] });
  const path = join(dir, 'bundle.tar');
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  const entries = [...(kind === 'fsot' ? [name] : []), 'file.sig', 'file.ots'];
  const tar = (...args) => execFileSync('tar', args, { env: { ...process.env, LC_ALL: 'C.UTF-8' } });
  assert.deepEqual(tar('-tf', path).toString().trimEnd().split('\n'), entries);
  assert.deepEqual(tar('-xOf', path, 'file.ots'), await fixture('hello-world.txt.ots'));
  const renamed = new File([blob], `改名后的归档.${kind}`);
  const renamedOriginal = new File([original], 'renamed.txt');
  const result = await readBundle(renamed, kind === 'asot' ? renamedOriginal : undefined);
  assert.equal(await result.original.text(), await original.text());
  assert.equal(await result.signature.text(), 'signature fixture');
  assert.equal(result.proofs[0].target, 'file');
  if (kind === 'asot') {
    assert.equal((await readBundle(renamed)).original, undefined);
  }
  await assert.rejects(readBundle(new File([blob.slice(0, -1024)], filename), original), /tar/);
});

test('reserves proof names even when an archive does not yet include those proofs', async () => {
  const original = new File(['original content'], 'file.sig');
  const proof = new Blob([await fixture('hello-freetsa.tsr')]);
  const { blob } = makeBundle({ kind: 'fsot', name: original.name, original, proofs: [{ type: 'tsr', target: 'file', authority: 'freetsa', blob: proof }] });
  const data = await readBundle(new File([blob], 'renamed.fsot'));
  assert.deepEqual([...data.entries.keys()], ['original-file.sig', 'file-freetsa.tsr']);
  assert.equal(await data.original.text(), 'original content');
  assert.equal(data.signature, undefined);
});

test('requires fixed entry names and rejects a signature proof without its signature', async () => {
  const blob = new Blob([await fixture('hello-world.txt.ots')]);
  for (const name of ['old.ots', 'file.sig.ots']) {
    const archive = new File([packTar([{ name, blob }])], 'old.asot');
    await assert.rejects(readBundle(archive), /无效的凭证条目/);
  }
});
