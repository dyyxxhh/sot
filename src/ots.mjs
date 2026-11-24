import { hashBlob, hex, readLimited, same, unhex } from './hash.mjs';
import { calendars, calendarOrigins } from './providers.mjs';

const get = () => {
  if (!globalThis.OpenTimestamps) throw new Error('OpenTimestamps 库未加载。');
  return globalThis.OpenTimestamps;
};
const bytes = arr => Uint8Array.from(arr);
function records(stamp) {
  const output = [], stack = [stamp.timestamp];
  while (stack.length) {
    const node = stack.pop();
    for (const att of node.attestations) output.push({ node, att });
    for (const child of node.ops.values()) stack.push(child);
  }
  return output;
}
const asBlob = stamp => new Blob([bytes(stamp.serializeToBytes())]);
async function deserialize(blob) {
  if (!blob.size || blob.size > 256 * 1024) throw new Error('OTS 回执大小无效。');
  return get().DetachedTimestampFile.deserialize(bytes(new Uint8Array(await blob.arrayBuffer())));
}
async function fetchCalendar(url, digest, post = false) {
  const response = await fetch(`${url}${post ? '/digest' : `/timestamp/${hex(digest)}`}`, {
    method: post ? 'POST' : 'GET', body: post ? bytes(digest) : undefined, credentials: 'omit', redirect: 'error',
    headers: { Accept: 'application/vnd.opentimestamps.v1', ...(post && { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    signal: AbortSignal.timeout(8500),
  });
  const payload = await readLimited(response, 64 * 1024);
  const ots = get();
  return ots.Timestamp.deserialize(new ots.Context.StreamDeserialization(bytes(new Uint8Array(await payload.arrayBuffer()))), Array.from(digest));
}
export async function stampOts(digest) {
  const ots = get();
  const stamp = ots.DetachedTimestampFile.fromHash(new ots.Ops.OpSHA256(), Array.from(digest));
  const tip = stamp.timestamp.add(new ots.Ops.OpAppend(Array.from(crypto.getRandomValues(new Uint8Array(16))))).add(new ots.Ops.OpSHA256());
  const attempts = await Promise.allSettled(calendars.map(url => fetchCalendar(url, tip.msg, true)));
  for (const item of attempts) if (item.status === 'fulfilled') tip.merge(item.value);
  if (!records(stamp).length) throw new Error('没有日历服务器返回时间戳回执。');
  return asBlob(stamp);
}
export async function upgradeOts(blob) {
  const ots = get(), stamp = await deserialize(blob);
  if (records(stamp).some(({ att }) => att instanceof ots.Notary.BitcoinBlockHeaderAttestation)) return { blob, complete: true };
  const pending = records(stamp).filter(({ att }) => att instanceof ots.Notary.PendingAttestation && calendarOrigins.has(att.uri.replace(/\/$/, ''))).slice(0, 16);
  const replies = await Promise.allSettled(pending.map(({ node, att }) => fetchCalendar(att.uri.replace(/\/$/, ''), node.msg)));
  replies.forEach((item, i) => { if (item.status === 'fulfilled') pending[i].node.merge(item.value); });
  const complete = records(stamp).some(({ att }) => att instanceof ots.Notary.BitcoinBlockHeaderAttestation);
  return { blob: asBlob(stamp), complete };
}

const explorers = ['https://blockstream.info/api', 'https://mempool.space/api'];
async function lookup(height) {
  const text = async url => (await (await readLimited(await fetch(url, { signal: AbortSignal.timeout(9000), credentials: 'omit' }), 512)).text()).trim();
  const hashes = await Promise.all(explorers.map(site => text(`${site}/block-height/${height}`)));
  if (!/^[0-9a-f]{64}$/.test(hashes[0]) || hashes[0] !== hashes[1]) throw new Error('两个区块浏览器未返回一致的区块哈希。');
  return { height, hash: hashes[0], header: await text(`${explorers[0]}/block/${hashes[0]}/header`) };
}
async function validateHeader(record, height, commitment) {
  if (record.height !== height || !/^[a-f0-9]{64}$/i.test(record.hash) || !/^[a-f0-9]{160}$/i.test(record.header)) throw new Error('区块记录格式有误。');
  const header = unhex(record.header);
  const once = await crypto.subtle.digest('SHA-256', header);
  const hash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', once)).reverse());
  // The proof commitment is in wire order, like the header field itself.
  if (hash !== record.hash.toLowerCase() || !same(header.slice(36, 68), bytes(commitment))) throw new Error('区块头或 Merkle 根与证明不匹配。');
  return new Date(new DataView(header.buffer).getUint32(68, true) * 1000).toISOString();
}
export async function verifyOts(blob, target, { headers = [], online = false, digest } = {}) {
  const ots = get(), stamp = await deserialize(blob);
  if (!(stamp.fileHashOp instanceof ots.Ops.OpSHA256) || !same(bytes(stamp.fileDigest()), digest ?? await hashBlob(target))) throw new Error('OTS 与文件不匹配或使用了不支持的哈希。');
  const anchors = records(stamp).filter(({ att }) => att instanceof ots.Notary.BitcoinBlockHeaderAttestation);
  if (!anchors.length) {
    if (!records(stamp).some(({ att }) => att instanceof ots.Notary.PendingAttestation)) throw new Error('回执没有比特币区块证明或待确认的日历证明。');
    return { state: 'pending' };
  }
  const heights = [...new Set(anchors.map(({ att }) => att.height))].sort((a, b) => a - b);
  if (!online && !headers.length) return { state: 'needs-headers', heights };
  for (const height of heights.slice(0, 8)) {
    const local = headers.find(h => h.height === height);
    if (!local && !online) continue;
    const block = local ?? await lookup(height);
    for (const { node, att } of anchors.filter(({ att }) => att.height === height)) {
      try { return { state: 'verified', time: await validateHeader(block, height, node.msg), height, via: local ? 'local' : 'explorers' }; }
      catch { /* a proof may offer more than one commitment for a height */ }
    }
  }
  if (!online && !headers.some(h => heights.includes(h.height))) return { state: 'needs-headers', heights };
  throw new Error('无法将 OTS 证明与提供的区块头匹配。');
}
