import { makeBundle, readBundle } from './bundle.mjs';
import { hashBlob } from './hash.mjs';
import { stampOts, upgradeOts, verifyOts } from './ots.mjs';
import { readDetached, verifyPgp } from './pgp.mjs';
import { tsa } from './providers.mjs';
import { loadTrust, requestTsa, verifyTsr } from './tsa.mjs';

const el = id => document.getElementById(id);
const selected = id => el(id).files[0];
const text = error => error instanceof Error ? error.message : String(error);
const urls = new WeakMap();
const busyForms = new WeakSet();
function report(out, lines, bundle) {
  const oldUrl = urls.get(out);
  if (oldUrl) URL.revokeObjectURL(oldUrl);
  out.textContent = lines.join('\n');
  if (bundle) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(bundle.blob);
    urls.set(out, link.href);
    link.download = bundle.filename;
    link.textContent = `下载 ${bundle.filename}`;
    out.append(document.createElement('br'), link);
  }
}
async function run(form, out, job) {
  if (busyForms.has(form)) return;
  busyForms.add(form);
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  report(out, ['处理中…']);
  try { await job(); }
  catch (error) { report(out, [`无法完成：${text(error)}`]); }
  finally { buttons.forEach(button => { button.disabled = false; }); busyForms.delete(form); }
}
const create = el('create'), verify = el('verify');
const makeResult = el('make-status'), verifyResult = el('verify-status');
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
  for (const peer of document.querySelectorAll('[data-view]')) peer.setAttribute('aria-pressed', String(peer === button));
  create.hidden = button.dataset.view !== 'create'; verify.hidden = !create.hidden;
});
el('signature').addEventListener('change', () => {
  const hasSignature = Boolean(selected('signature'));
  el('target-sig').disabled = !hasSignature;
  create.elements.target.value = hasSignature ? 'signature' : 'file';
});

async function imported(file, blob, digest, target) {
  if (!file.size || file.size > 256 * 1024) throw new Error('凭证不得为空或大于 256 KiB。');
  if (/\.ots$/i.test(file.name)) {
    await verifyOts(file, blob, { digest });
    return { type: 'ots', target, blob: file };
  }
  for (const id of Object.keys(tsa)) {
    try {
      await verifyTsr(file, blob, { ...await loadTrust(id), digest });
      return { type: 'tsr', authority: id, target, blob: file };
    } catch { /* distinguish supported authority by its certificate, not by filename */ }
  }
  throw new Error('与打戳对象不符，或签发机构不受支持。');
}
function make(online) {
  return run(create, makeResult, async () => {
    const original = selected('original'), signature = selected('signature');
    const target = create.elements.target.value, kind = create.elements.kind.value;
    const targetBlob = target === 'signature' ? signature : original;
    const authorities = online ? [...create.querySelectorAll('[name=authority]:checked')].map(input => input.value) : [];
    const files = [...el('existing').files];
    if (!original || !targetBlob) throw new Error('请先选择原文件及所需的签名。');
    if (!authorities.length && !files.length) throw new Error('请选择签发机构或导入已有凭证。');
    if (signature) await readDetached(signature);
    const digest = await hashBlob(targetBlob);
    const proofs = [], messages = [];
    const add = proof => {
      if (proofs.some(p => p.type === proof.type && p.authority === proof.authority)) throw new Error('相同对象的此类凭证已选中。');
      proofs.push(proof);
    };
    for (const file of files) {
      try { add(await imported(file, targetBlob, digest, target)); messages.push(`${file.name}：已导入。`); }
      catch (error) { messages.push(`${file.name}：${text(error)}`); }
    }
    const fresh = authorities.filter(id => !proofs.some(p => (p.authority ?? p.type) === id));
    const replies = await Promise.allSettled(fresh.map(async id => id === 'ots'
      ? { type: 'ots', target, blob: await stampOts(digest) }
      : { type: 'tsr', authority: id, target, blob: await requestTsa(id, digest, targetBlob) }));
    replies.forEach((reply, i) => {
      const id = fresh[i], label = tsa[id]?.label ?? 'OpenTimestamps';
      if (reply.status === 'fulfilled') {
        add(reply.value);
        messages.push(`${label}：${id === 'ots' ? '已取得回执；上链后可补全。' : '已签发并验证。'}`);
      } else messages.push(`${label}：${text(reply.reason)}`);
    });
    report(makeResult, messages, proofs.length ? makeBundle({ name: original.name, kind, original, signature, proofs }) : undefined);
  });
}
create.addEventListener('submit', event => { event.preventDefault(); void make(true); });
el('pack-only').addEventListener('click', () => void make(false));

async function archive() {
  const file = selected('archive');
  if (!file) throw new Error('请先选择归档。');
  return readBundle(file, selected('external'));
}
async function localHeaders() {
  const file = selected('headers');
  if (!file) return [];
  if (file.size > 1024 * 1024) throw new Error('区块记录文件过大。');
  const parsed = JSON.parse(await file.text());
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.some(h => !h || !Number.isSafeInteger(h.height) || h.height < 0 || typeof h.hash !== 'string' || typeof h.header !== 'string')) throw new Error('区块记录格式不正确。');
  return list;
}
function inspect(online) {
  return run(verify, verifyResult, async () => {
    const { original, signature, proofs } = await archive();
    const headers = await localHeaders(), key = selected('public-key');
    const messages = [];
    let sigValid = false;
    const signatureTimes = [];
    if (signature) {
      if (key && original) {
        try { const fingerprint = await verifyPgp(original, signature, key); sigValid = true; messages.push(`OpenPGP：有效；公钥指纹 ${fingerprint}`); }
        catch (error) { messages.push(`OpenPGP：验签失败；${text(error)}`); }
      } else messages.push('OpenPGP：未验签，需要原文件和公钥。');
    }
    for (const proof of proofs) {
      const target = proof.target === 'signature' ? signature : original;
      const label = `${proof.label}（${proof.target === 'file' ? '原文件' : '签名文件'}）`;
      if (!target) { messages.push(`${label}：缺少原文件，未验证。`); continue; }
      try {
        if (proof.type === 'tsr') {
          const { time } = await verifyTsr(proof.blob, target, await loadTrust(proof.authority));
          messages.push(`${label}：有效 · ${time}`);
          if (proof.target === 'signature') signatureTimes.push(time);
        } else {
          const result = await verifyOts(proof.blob, target, { headers, online });
          if (result.state === 'pending') messages.push(`${label}：匹配，但尚无比特币区块证明，请先联网补全。`);
          else if (result.state === 'needs-headers') messages.push(`${label}：文件匹配，但未验证上链；缺少区块头（高度 ${result.heights.join('、')}）。`);
          else {
            messages.push(`${label}：与${result.via === 'local' ? '提供的本地区块记录' : '两个区块浏览器查询的记录'}相符 · 区块 ${result.height} · 区块标记时间 ${result.time}`);
            if (sigValid && proof.target === 'signature') messages.push(`结合验签：这版文件的签名在区块 ${result.height} 上链时已存在。`);
          }
        }
      } catch (error) { messages.push(`${label}：未通过；${text(error)}`); }
    }
    if (sigValid && signatureTimes.length) messages.push(`结合验签：这版文件最晚在 ${signatureTimes.sort()[0]} 已被该公钥对应的密钥签名。`);
    report(verifyResult, messages);
  });
}
verify.addEventListener('submit', event => { event.preventDefault(); void inspect(false); });
el('verify-online').addEventListener('click', () => void inspect(true));
el('upgrade').addEventListener('click', () => void run(verify, verifyResult, async () => {
  const data = await archive(), notes = [];
  if (!data.proofs.some(p => p.type === 'ots')) throw new Error('归档没有 OTS 回执。');
  for (const proof of data.proofs) if (proof.type === 'ots') {
    const { blob, complete } = await upgradeOts(proof.blob);
    proof.blob = blob;
    notes.push(`${proof.label}：${complete ? '已包含区块证明，可继续验戳。' : '待确认或日历不可用；晚些再试。'}`);
  }
  report(verifyResult, notes, makeBundle(data));
}));
el('attach').addEventListener('click', () => el('attach-file').click());
el('attach-file').addEventListener('change', () => {
  const signature = selected('attach-file');
  el('attach-file').value = '';
  if (signature) void run(verify, verifyResult, async () => {
    const data = await archive();
    if (data.signature) throw new Error('归档已经含有 .sig，不自动替换已有签名。');
    await readDetached(signature);
    report(verifyResult, ['已附加签名；已有时间戳不会覆盖新附加的签名。'], makeBundle({ ...data, signature }));
  });
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => {
    el('offline-state').textContent = '离线工具已缓存';
  }).catch(() => { el('offline-state').textContent = '本浏览器未能缓存离线工具'; });
} else el('offline-state').textContent = '开发模式不启用离线缓存';
