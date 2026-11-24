import { archiveKind, readBundle } from './bundle.mjs';
import { upgradeOts } from './ots.mjs';
import { readDetached } from './pgp.mjs';
import { packTar } from './tar.mjs';
import { setupDisplayTime } from './time-display.mjs';
import { OTS_DRIFT_HOURS, TSR_SPREAD_SECONDS } from './verification-result.mjs';
import { errorText, executeMake, planMake, proofType, signatureName, verifyFiles } from './workflows.mjs';

const el = id => document.getElementById(id);
const displayTime = setupDisplayTime(el('settings'), el('display-time-zone'), el('open-settings'));
const selected = id => el(id).files[0];
const show = (id, visible) => { el(id).hidden = !visible; };
const field = (id, visible, required = false) => {
  el(id).closest('[data-field]').hidden = !visible;
  el(id).disabled = !visible;
  el(id).required = visible && required;
};
const views = { create: ['制作', 'make-input'], verify: ['验证', 'verify-input'], complete: ['补全', 'complete-input'] };
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
  const id = button.dataset.view;
  const [title, input] = views[id];
  for (const view of Object.keys(views)) show(view, view === id);
  show('home', false);
  show('tool', true);
  el('tool-title').textContent = title;
  el(input).focus();
});
el('back').addEventListener('click', () => {
  const active = Object.keys(views).find(id => !el(id).hidden);
  el(active).reset();
  el(views[active][1]).dispatchEvent(new Event('change', { bubbles: true }));
  show('tool', false);
  show('home', true);
  document.querySelector(`[data-view="${active}"]`).focus();
});

function report(id, lines = [], downloads = [], title) {
  const out = el(id);
  if (id === 'verify-status') showVerifySummary();
  for (const link of out.querySelectorAll('a')) URL.revokeObjectURL(link.href);
  out.replaceChildren();
  for (const [index, line] of lines.entries()) {
    if (index) out.append('\n');
    if (typeof line === 'string') out.append(line);
    else out.append(line.prefix, displayTime.clock(line.time, line.verified), ' ', displayTime.zoneLabel(), line.suffix ?? '');
  }
  out.hidden = !lines.length && !downloads.length;
  if (!downloads.length) return;
  if (title) {
    const heading = document.createElement('p');
    heading.textContent = title;
    out.append(heading);
  }
  const links = document.createElement('div');
  links.className = 'downloads';
  for (const [filename, blob] of downloads) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.textContent = `下载 ${filename}`;
    links.append(link);
  }
  out.append(links);
}

function showVerifySummary(summary) {
  const box = el('verify-summary');
  box.replaceChildren();
  box.hidden = !summary;
  if (!summary) return;
  box.dataset.result = summary.pass ? 'pass' : 'fail';
  const heading = document.createElement('h2');
  heading.textContent = summary.pass ? '联合校验通过' : '联合校验未通过';
  box.append(heading);
  if (summary.time) {
    const label = document.createElement('small');
    label.append(summary.timeType === 'tsr' ? '最早已验证 TSR · ' : 'OTS 区块标记时间 · ', displayTime.zoneLabel());
    box.append(label, displayTime.clock(summary.time));
  }
  const reason = document.createElement('p');
  reason.textContent = summary.reason;
  const rule = document.createElement('small');
  rule.textContent = `判定规则：TSR 时间跨度 ≤ ${TSR_SPREAD_SECONDS} 秒；同一对象的 OTS 区块标记时间与 TSR 签发时间相差 ≤ ${OTS_DRIFT_HOURS} 小时。`;
  box.append(reason, rule);
}

async function run(form, out, job) {
  const controls = [...el(form).querySelectorAll('button, input'), el('back')].filter(node => !node.disabled);
  if (el('back').disabled) return;
  controls.forEach(node => { node.disabled = true; });
  report(out, ['处理中…']);
  try { await job(); }
  catch (error) { report(out, [`无法完成：${errorText(error)}`]); }
  finally { controls.forEach(node => { node.disabled = false; }); }
}

const create = el('create');
let approved;
const makeMain = () => selected('make-input');
const makeType = () => {
  const name = makeMain()?.name ?? '';
  return proofType(name) ?? (signatureName(name) ? 'signature' : 'file');
};
function makeFiles() {
  const main = makeMain(), type = makeType();
  return {
    original: type === 'file' ? main : selected('make-original'),
    signature: type === 'signature' ? main : selected('make-signature'),
    existing: [...(type === 'ots' || type === 'tsr' ? [main] : []), ...el('make-existing').files],
  };
}
function updateMake(event) {
  if (event.target.id === 'make-input') {
    for (const id of ['make-original', 'make-signature', 'make-existing']) el(id).value = '';
    create.elements.kind.value = 'asot';
    create.elements.target.value = 'signature';
    for (const item of create.querySelectorAll('[name=authority]')) item.checked = false;
  }
  const main = makeMain(), type = makeType();
  const { original, signature } = makeFiles();
  const hasAuthorities = !!create.querySelector('[name=authority]:checked');
  show('make-fields', !!main);
  field('make-original', !!main && type !== 'file', create.elements.kind.value === 'fsot');
  field('make-signature', !!main && type !== 'signature');
  el('make-fsot').disabled = !original;
  if (!original) create.elements.kind.value = 'asot';
  show('make-targets', hasAuthorities && !!original && !!signature);
  if (event.target.id === 'make-signature' && signature) create.elements.target.value = 'signature';
  approved = undefined;
  show('make-confirm', false);
  show('make-review', true);
  report('make-status');
}
create.addEventListener('change', updateMake);
el('make-review').addEventListener('click', () => {
  if (!create.reportValidity()) return;
  const files = makeFiles();
  const kind = create.elements.kind.value;
  const target = files.signature ? (files.original ? create.elements.target.value : 'signature') : 'file';
  const authorities = [...create.querySelectorAll('[name=authority]:checked')].map(item => item.value);
  void run('create', 'make-status', async () => {
    approved = await planMake({ ...files, kind, target, authorities });
    report('make-status', approved.lines);
    show('make-review', false);
    show('make-confirm', true);
    el('make-status').focus();
  });
});
create.addEventListener('submit', event => {
  event.preventDefault();
  if (!approved) return;
  const plan = approved;
  approved = undefined;
  show('make-confirm', false);
  show('make-review', true);
  void run('create', 'make-status', async () => {
    const { lines, bundle } = await executeMake(plan);
    report('make-status', lines, bundle ? [[bundle.filename, bundle.blob]] : []);
  });
});

async function localHeaders() {
  const file = selected('verify-headers');
  if (!file || el('verify-headers').closest('[data-field]').hidden) return [];
  if (file.size > 1024 * 1024) throw new Error('区块记录文件过大。');
  const parsed = JSON.parse(await file.text());
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.some(h => !h || !Number.isSafeInteger(h.height) || h.height < 0 || typeof h.hash !== 'string' || typeof h.header !== 'string')) throw new Error('区块记录格式不正确。');
  return list;
}
let verification, verifyRevision = 0;
async function updateVerify(event) {
  if (event.target.id === 'verify-input') {
    for (const id of ['verify-target', 'verify-original', 'verify-key', 'verify-headers']) el(id).value = '';
  }
  const rev = ++verifyRevision;
  const main = selected('verify-input'), original = selected('verify-original');
  verification = undefined;
  show('verify-fields', false);
  report('verify-status');
  if (!main) return;
  const kind = archiveKind(main.name), type = proofType(main.name);
  const detached = !kind && !type && signatureName(main.name);
  let archive, error;
  if (kind) {
    try { archive = await readBundle(main, original); }
    catch (reason) { error = reason; }
  }
  if (rev !== verifyRevision) return;
  if (!kind && !type && !detached) return report('verify-status', ['请选择 .asot、.fsot、.sig、.tsr 或 .ots。']);
  if (error) report('verify-status', [`无法读取归档：${errorText(error)}`, ...(kind === 'asot' ? ['归档改名时，可试着补选原文件。'] : [])]);
  const needOriginal = detached || !!archive?.proofs.some(p => p.target === 'file');
  const hasOts = type === 'ots' || !!archive?.proofs.some(p => p.type === 'ots');
  field('verify-original', detached || kind === 'asot' && (needOriginal || !!archive?.signature || !!error), needOriginal);
  el('verify-original-note').textContent = needOriginal ? '必选，用于验证原件。' : '可选，与公钥一起使用可验证签名。';
  field('verify-target', !!type, !!type);
  field('verify-key', detached || !!archive?.signature, detached);
  el('verify-key-note').textContent = `${detached ? '必选' : '可选'}，不要导入私钥。`;
  field('verify-headers', hasOts);
  show('verify-online', hasOts);
  el('verify-local').classList.toggle('primary', !hasOts);
  el('verify-local').disabled = !!error;
  verification = error ? undefined : { archive, main, type, detached };
  show('verify-fields', true);
}
el('verify').addEventListener('change', event => {
  if (['verify-input', 'verify-original'].includes(event.target.id)) void updateVerify(event);
  else report('verify-status');
});
function verify(online) {
  if (!verification || !el('verify').reportValidity()) return;
  const { archive, main, type, detached } = verification;
  const original = archive?.original ?? selected(detached ? 'verify-original' : 'verify-target');
  const signature = archive?.signature ?? (detached ? main : undefined);
  const proofs = archive?.proofs ?? (type ? [{ type, target: 'standalone', label: main.name, blob: main }] : []);
  const publicKey = el('verify-key').disabled ? undefined : selected('verify-key');
  void run('verify', 'verify-status', async () => {
    const headers = await localHeaders();
    const { lines, summary } = await verifyFiles({ original, signature, proofs, publicKey, headers, online });
    report('verify-status', lines, archive ? [...archive.entries] : [], '归档内文件（可单独下载；不代表已通过验证）');
    showVerifySummary(summary);
  });
}
el('verify').addEventListener('submit', event => { event.preventDefault(); verify(false); });
el('verify-online').addEventListener('click', () => verify(true));

let completion, completeRevision = 0;
el('complete-input').addEventListener('change', async () => {
  const rev = ++completeRevision;
  const main = selected('complete-input');
  completion = undefined;
  el('complete-signature').value = '';
  show('complete-fields', false);
  report('complete-status');
  if (!main) return;
  try {
    const data = archiveKind(main.name) ? await readBundle(main) : undefined;
    if (rev !== completeRevision) return;
    if (!data && proofType(main.name) !== 'ots') throw new Error('请选择 .ots、.asot 或 .fsot。');
    const hasOts = !data || data.proofs.some(p => p.type === 'ots');
    const canAttach = !!data && !data.signature;
    completion = { main, data };
    show('complete-upgrade', hasOts);
    field('complete-signature', canAttach);
    show('complete-attach', canAttach);
    el('attach').disabled = true;
    show('complete-fields', hasOts || canAttach);
    if (!hasOts && !canAttach) report('complete-status', ['归档没有 OTS 回执，且已包含签名。']);
  } catch (error) {
    if (rev === completeRevision) report('complete-status', [`无法读取归档：${errorText(error)}`]);
  }
});
el('complete').addEventListener('submit', event => event.preventDefault());
el('complete-signature').addEventListener('change', () => {
  el('attach').disabled = !selected('complete-signature');
  report('complete-status');
});
const otsNote = (name, complete) => `${name}：${complete ? '已包含区块证明，可继续验戳。' : '待确认或日历不可用；晚些再试。'}`;
const archiveDownload = (data, entries) => [`${data.name}.${data.kind}`, packTar([...entries].map(([name, blob]) => ({ name, blob })))];
el('upgrade').addEventListener('click', () => {
  if (!completion) return;
  const { main, data } = completion;
  void run('complete', 'complete-status', async () => {
    if (!data) {
      const updated = await upgradeOts(main);
      report('complete-status', [otsNote(main.name, updated.complete)], [[main.name, updated.blob]]);
      return;
    }
    const entries = new Map(data.entries), notes = [];
    for (const { label, blob } of data.proofs.filter(p => p.type === 'ots')) {
      try {
        const updated = await upgradeOts(blob);
        entries.set(label, updated.blob);
        notes.push(otsNote(label, updated.complete));
      } catch (error) { notes.push(`${label}：未补全；${errorText(error)}`); }
    }
    report('complete-status', notes, [archiveDownload(data, entries)]);
  });
});
el('attach').addEventListener('click', () => {
  const data = completion?.data, signature = selected('complete-signature');
  if (!data || data.signature || !signature) return;
  void run('complete', 'complete-status', async () => {
    await readDetached(signature);
    const entries = new Map(data.entries);
    entries.set(`${data.name}.sig`, signature);
    report('complete-status', ['已追加签名（未验签）；已有时间戳不覆盖新签名。'], [archiveDownload(data, entries)]);
  });
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => {
    el('offline-state').textContent = '离线工具已缓存';
  }).catch(() => { el('offline-state').textContent = '本浏览器未能缓存离线工具'; });
} else el('offline-state').textContent = '当前环境未启用离线缓存';
