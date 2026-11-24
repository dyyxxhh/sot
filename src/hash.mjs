import { createSHA256, createSHA384, createSHA512 } from 'hash-wasm';

const algorithms = { 'SHA-256': createSHA256, 'SHA-384': createSHA384, 'SHA-512': createSHA512 };
export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export function unhex(text) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(text)) throw new Error('十六进制数据无效。');
  return Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));
}

export async function hashBlob(blob, algorithm = 'SHA-256') {
  const create = algorithms[algorithm];
  if (!create) throw new Error(`不支持的哈希算法：${algorithm}`);
  const hash = await create();
  for await (const chunk of blob.stream()) hash.update(chunk);
  return hash.digest('binary');
}

export async function readLimited(response, limit) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error('远程回执为空。');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return new Blob(chunks);
      size += value.length;
      if (size > limit) throw new Error('远程回执超出大小限制。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
}
