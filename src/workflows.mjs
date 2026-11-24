import { checkOriginal, makeBundle } from './bundle.mjs';
import { hashBlob } from './hash.mjs';
import { stampOts, verifyOts } from './ots.mjs';
import { readDetached, verifyPgp } from './pgp.mjs';
import { tsa } from './providers.mjs';
import { checkName } from './tar.mjs';
import { requestTsa, verifyTsr } from './tsa.mjs';
import { getTrust } from './trust.mjs';
import { summarizeTimestamps } from './verification-result.mjs';

export const errorText = error => error instanceof Error ? error.message : String(error);
export const proofType = name => /\.ots$/i.test(name) ? 'ots' : /\.(tsr|tsa)$/i.test(name) ? 'tsr' : undefined;
export const signatureName = name => /\.(sig|asc)$/i.test(name);
export const providerName = id => tsa[id]?.label ?? 'OpenTimestamps';
const targetName = target => target === 'signature' ? '签名文件' : '原文件';
const formatOf = proof => proof.authority ?? proof.type;

async function verifySupportedTsr(blob, target, digest) {
  for (const authority of Object.keys(tsa)) {
    try { return { ...await verifyTsr(blob, target, { ...getTrust(authority), digest }), authority }; }
    catch { /* Identify supported TSA by its signature and chain, never the filename. */ }
  }
  throw new Error('时间戳与打戳对象不匹配，或签发机构不受支持。');
}

async function matchProof(blob, targets) {
  const type = proofType(blob.name);
  if (!type || !blob.size || blob.size > 256 * 1024) throw new Error(`${blob.name}：不是支持的时间戳，或文件大小无效。`);
  for (const [target, candidate] of targets) {
    const { file, digest } = candidate;
    try {
      if (type === 'ots') {
        await verifyOts(blob, file, { digest });
        return { type, target, blob };
      }
      const { authority } = await verifySupportedTsr(blob, file, digest);
      return { type, authority, target, blob };
    } catch { /* A receipt may timestamp either of the selected files. */ }
  }
  throw new Error(`${blob.name}：未匹配任何已选的原文件或签名，或凭证不受支持。`);
}

export async function planMake({ original, signature, kind, target, authorities, existing }) {
  if (!original && !signature) throw new Error('请补充原文件或分离签名。');
  if (!existing.length && !authorities.length) throw new Error('请选择申请新时间戳，或添加已有时间戳。');
  checkOriginal(kind, original);
  const name = original?.name ?? signature.name.replace(/\.(sig|asc)$/i, '');
  checkName(name);
  if (signature) await readDetached(signature);
  const targets = new Map();
  for (const [id, file] of [['file', original], ['signature', signature]]) {
    if (file && (existing.length || id === target)) targets.set(id, { file, digest: await hashBlob(file) });
  }
  const proofs = [];
  for (const blob of existing) {
    const proof = await matchProof(blob, targets);
    const id = formatOf(proof);
    if (proofs.some(item => item.target === proof.target && formatOf(item) === id)) {
      throw new Error(`${blob.name}：同一对象的 ${providerName(id)} 时间戳不能重复。`);
    }
    proofs.push(proof);
  }
  const fresh = authorities.filter(id => !proofs.some(p => p.target === target && formatOf(p) === id));
  checkName(`${name}.${kind}`);
  const lines = [`输出：${name}.${kind}`];
  if (original) lines.push(`原文件：${original.name}${kind === 'asot' ? '（不包含在归档中）' : ''}`);
  if (signature) lines.push(`分离签名：${signature.name}（未验签）`);
  if (proofs.length) lines.push(...proofs.map(p => `已有时间戳：${p.blob.name} → ${targetName(p.target)}`));
  if (fresh.length) lines.push(`将联网给${targetName(target)}打戳：${fresh.map(providerName).join('、')}`);
  else lines.push('不联网，仅打包已有时间戳。');
  return { name, kind, original, signature, proofs, fresh, target, stamped: targets.get(target), lines };
}

export async function executeMake(plan) {
  const { fresh, target, stamped } = plan;
  const proofs = [...plan.proofs];
  const replies = await Promise.allSettled(fresh.map(async id => {
    const { file, digest } = stamped;
    return id === 'ots'
      ? { type: 'ots', target, blob: await stampOts(digest) }
      : { type: 'tsr', authority: id, target, blob: await requestTsa(id, digest, file, getTrust(id)) };
  }));
  const lines = proofs.map(p => `${p.blob.name}：已打包。`);
  replies.forEach((reply, index) => {
    const id = fresh[index], label = providerName(id);
    if (reply.status === 'fulfilled') {
      proofs.push(reply.value);
      lines.push(`${label}：${id === 'ots' ? '已取得回执；上链后可补全。' : '已签发并验证。'}`);
    } else lines.push(`${label}：申请失败；${errorText(reply.reason)}`);
  });
  return { lines, bundle: proofs.length ? makeBundle({ ...plan, proofs }) : undefined };
}

export async function verifyFiles({ original, signature, proofs, publicKey, headers, online }) {
  const lines = [], signatureTimes = [], checks = [];
  let sigValid = false, signatureFailed = false;
  if (signature) {
    if (publicKey && original) {
      try {
        const fingerprint = await verifyPgp(original, signature, publicKey);
        sigValid = true;
        lines.push(`OpenPGP：有效；公钥指纹 ${fingerprint}`);
      } catch (error) { signatureFailed = true; lines.push(`OpenPGP：验签失败；${errorText(error)}`); }
    } else lines.push('OpenPGP：未验签，需要原文件和公钥。');
  }
  for (const proof of proofs) {
    const check = { type: proof.type, target: proof.target };
    checks.push(check);
    const target = proof.target === 'signature' ? signature : original;
    const label = `${proof.label}（${proof.target === 'standalone' ? '打戳对象' : targetName(proof.target)}）`;
    if (!target) { lines.push(`${label}：缺少原文件，未验证。`); continue; }
    try {
      if (proof.type === 'tsr') {
        const { time, authority = proof.authority } = proof.authority
          ? await verifyTsr(proof.blob, target, getTrust(proof.authority))
          : await verifySupportedTsr(proof.blob, target);
        check.time = time;
        lines.push({ prefix: `${label}：有效 · `, time, suffix: ` · ${providerName(authority)}`, verified: true });
        if (proof.target === 'signature') signatureTimes.push(time);
      } else {
        const result = await verifyOts(proof.blob, target, { headers, online });
        if (result.state === 'pending') lines.push(`${label}：匹配，但尚无比特币区块证明，请先联网补全。`);
        else if (result.state === 'needs-headers') lines.push(`${label}：文件匹配，但未验证上链；缺少区块头（高度 ${result.heights.join('、')}）。`);
        else {
          check.time = result.time;
          lines.push({ prefix: `${label}：与${result.via === 'local' ? '提供的本地区块记录' : '两个区块浏览器查询的记录'}相符 · 区块 ${result.height} · 区块标记时间 `, time: result.time, verified: true });
          if (sigValid && proof.target === 'signature') lines.push(`结合验签：这版文件的签名在区块 ${result.height} 上链时已存在。`);
        }
      }
    } catch (error) { lines.push(`${label}：未通过；${errorText(error)}`); }
  }
  if (sigValid && signatureTimes.length) lines.push({ prefix: '结合验签：这版文件最晚在 ', time: signatureTimes.sort()[0], suffix: ' 已被该公钥对应的密钥签名。' });
  return { lines, summary: summarizeTimestamps(checks, { signatureFailed }) };
}
