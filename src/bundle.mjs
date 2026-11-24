import { checkName, packTar, readTar } from './tar.mjs';

const authorityName = /^[a-z0-9][a-z0-9-]{0,47}$/i;

export function makeBundle({ kind, name, original, signature, proofs }) {
  checkName(name);
  if (!['asot', 'fsot'].includes(kind) || !proofs.length) throw new Error('请选择归档类型和至少一份时间戳。');
  if (kind === 'fsot' && !original) throw new Error('.fsot 必须包含原文件。');
  const entries = kind === 'fsot' ? [{ name, blob: original }] : [];
  if (signature) entries.push({ name: `${name}.sig`, blob: signature });
  for (const { type, authority, target, blob } of proofs) {
    if (!['file', 'signature'].includes(target) || target === 'signature' && !signature) throw new Error('时间戳缺少对应的签名文件。');
    const base = name + (target === 'signature' ? '.sig' : '');
    if (type === 'ots') entries.push({ name: `${base}.ots`, blob });
    else if (type === 'tsr' && authorityName.test(authority ?? '')) entries.push({ name: `${base}-${authority}.tsr`, blob });
    else throw new Error('时间戳类型或机构标识无效。');
  }
  return { filename: `${name}.${kind}`, blob: packTar(entries) };
}

export async function readBundle(file, external) {
  const kind = /\.(asot|fsot)$/i.exec(file.name)?.[1].toLowerCase();
  if (!kind) throw new Error('请选择 .asot 或 .fsot。');
  const entries = await readTar(file);
  const name = kind === 'fsot' ? entries.keys().next().value : external?.name ?? file.name.slice(0, -5);
  checkName(name);
  const original = kind === 'fsot' ? entries.get(name) : external;
  if (kind === 'fsot') entries.delete(name);
  const signature = entries.get(`${name}.sig`);
  entries.delete(`${name}.sig`);
  const proofs = [];
  for (const [label, blob] of entries) {
    let proof;
    for (const target of ['signature', 'file']) {
      const base = `${name}${target === 'signature' ? '.sig' : ''}`;
      if (label === `${base}.ots`) proof = { type: 'ots', target };
      else if (label.startsWith(`${base}-`) && label.endsWith('.tsr')) {
        const authority = label.slice(base.length + 1, -4);
        if (authorityName.test(authority)) proof = { type: 'tsr', authority, target };
      }
      if (proof) break;
    }
    if (!proof || proof.target === 'signature' && !signature || blob.size > 256 * 1024 || !blob.size) throw new Error(`无效的凭证条目：${label}`);
    proofs.push({ ...proof, blob, label });
  }
  if (!proofs.length) throw new Error('归档中没有时间戳。');
  return { kind, name, original, signature, proofs };
}
