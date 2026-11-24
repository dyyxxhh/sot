import { checkName, MAX_ENTRY_SIZE, packTar, readTar } from './tar.mjs';

export const SIGNATURE_ENTRY = 'file.sig';
const authorityName = /^[a-z0-9][a-z0-9-]{0,47}$/i;
export const archiveKind = name => /\.(asot|fsot)$/i.exec(name)?.[1].toLowerCase();

export function checkOriginal(kind, original) {
  if (kind === 'fsot' && !original) throw new Error('.fsot 必须包含原文件。');
  if (kind === 'fsot' && original.size > MAX_ENTRY_SIZE) throw new Error('原文件达到 8 GiB，不能打成 .fsot；请选择 .asot 单独保存凭证。');
}

function proofEntryName({ type, authority, target }) {
  const base = target === 'signature' ? SIGNATURE_ENTRY : 'file';
  if (type === 'ots') return `${base}.ots`;
  if (type === 'tsr' && authorityName.test(authority ?? '')) return `${base}-${authority}.tsr`;
  throw new Error('时间戳类型或机构标识无效。');
}

function parseProofEntry(label) {
  if (label === 'file.ots') return { type: 'ots', target: 'file' };
  if (label === 'file.sig.ots') return { type: 'ots', target: 'signature' };
  const match = /^file(\.sig)?-(.+)\.tsr$/.exec(label);
  if (match && authorityName.test(match[2])) {
    return { type: 'tsr', target: match[1] ? 'signature' : 'file', authority: match[2] };
  }
}

const isReserved = name => name.toLowerCase() === SIGNATURE_ENTRY || !!parseProofEntry(name.toLowerCase());

export function makeBundle({ kind, name, original, signature, proofs }) {
  checkName(name);
  if (!['asot', 'fsot'].includes(kind) || !proofs.length) throw new Error('请选择归档类型和至少一份时间戳。');
  checkOriginal(kind, original);
  const entries = kind === 'fsot' ? [{ name: isReserved(name) ? `original-${name}` : name, blob: original }] : [];
  if (signature) entries.push({ name: SIGNATURE_ENTRY, blob: signature });
  for (const proof of proofs) {
    if (!['file', 'signature'].includes(proof.target) || proof.target === 'signature' && !signature) throw new Error('时间戳缺少对应的签名文件。');
    entries.push({ name: proofEntryName(proof), blob: proof.blob });
  }
  return { filename: `${name}.${kind}`, blob: packTar(entries) };
}

export async function readBundle(file, external) {
  const kind = archiveKind(file.name);
  if (!kind) throw new Error('请选择 .asot 或 .fsot。');
  const entries = await readTar(file);
  const originalName = kind === 'fsot' ? entries.keys().next().value : undefined;
  if (originalName && isReserved(originalName)) throw new Error('.fsot 的第一项必须是原文件，不能使用凭证保留名称。');
  const original = originalName ? entries.get(originalName) : external;
  const signature = entries.get(SIGNATURE_ENTRY);
  const proofs = [];
  for (const [label, blob] of entries) {
    if (label === originalName || label === SIGNATURE_ENTRY) continue;
    const proof = parseProofEntry(label);
    if (!proof || proof.target === 'signature' && !signature || blob.size > 256 * 1024 || !blob.size) throw new Error(`无效的凭证条目：${label}`);
    proofs.push({ ...proof, blob, label });
  }
  if (!proofs.length) throw new Error('归档中没有时间戳。');
  return { original, signature, proofs, entries };
}
