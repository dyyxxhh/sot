const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const pad = n => (BLOCK - n % BLOCK) % BLOCK;
const zeros = n => new Uint8Array(n);
const isZero = bytes => bytes.every(b => b === 0);
const LIMIT = 128;
export const MAX_ENTRY_SIZE = 8 ** 11 - 1;

export function checkName(name) {
  if (!name || name === '.' || name === '..' || /[/\\:\u0000-\u001f\u007f]/u.test(name) || encoder.encode(name).length > 512) {
    throw new Error('文件名不受支持：须为不含路径或控制字符的文件名。');
  }
  return name;
}

function header(name, size, type = '0') {
  if (size > MAX_ENTRY_SIZE) throw new Error('单个归档条目须小于 8 GiB。');
  const bytes = zeros(BLOCK);
  const put = (at, text) => bytes.set(encoder.encode(text), at);
  put(0, name);
  put(100, '0000644\0');
  put(108, '0000000\0');
  put(116, '0000000\0');
  put(124, size.toString(8).padStart(11, '0') + '\0');
  put(136, '00000000000\0');
  bytes.fill(32, 148, 156);
  put(156, type);
  put(257, 'ustar\0' + '00');
  put(148, bytes.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ');
  return bytes;
}

function paxPath(name) {
  const body = ` path=${name}\n`;
  const size = encoder.encode(body).length;
  let total = size + 1;
  while (size + String(total).length !== total) total = size + String(total).length;
  return encoder.encode(`${total}${body}`);
}

export function packTar(entries) {
  if (!entries.length || entries.length > LIMIT) throw new Error('归档条目数量不合法。');
  const parts = [], seen = new Set();
  for (const { name, blob } of entries) {
    checkName(name);
    if (seen.has(name)) throw new Error(`重复条目：${name}`);
    seen.add(name);
    let short = name;
    if (!/^[\x20-\x7e]{1,100}$/.test(name)) {
      const pax = paxPath(name);
      parts.push(header(`PaxHeader-${seen.size}`, pax.length, 'x'), pax, zeros(pad(pax.length)));
      short = `Entry-${seen.size}`;
    }
    parts.push(header(short, blob.size), blob, zeros(pad(blob.size)));
  }
  return new Blob([...parts, zeros(2 * BLOCK)], { type: 'application/octet-stream' });
}

function field(bytes) {
  const end = bytes.indexOf(0);
  return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function octal(bytes) {
  const text = field(bytes).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('tar 八进制字段无效。');
  return parseInt(text, 8);
}

export async function readTar(blob) {
  const entries = new Map();
  let offset = 0, pax;
  while (offset + 2 * BLOCK <= blob.size) {
    const h = new Uint8Array(await blob.slice(offset, offset + BLOCK).arrayBuffer());
    if (isZero(h)) {
      if (pax !== undefined || !entries.size || blob.size % BLOCK || blob.size - offset > 10240 ||
          !isZero(new Uint8Array(await blob.slice(offset).arrayBuffer()))) throw new Error('tar 结尾无效。');
      return entries;
    }
    if (field(h.subarray(257, 263)) !== 'ustar') throw new Error('不支持的 tar 格式。');
    const checksum = octal(h.subarray(148, 156));
    h.fill(32, 148, 156);
    if (checksum !== h.reduce((a, b) => a + b, 0)) throw new Error('tar 头校验和不匹配。');
    const size = octal(h.subarray(124, 136)), type = h[156];
    const start = offset + BLOCK;
    offset = start + size + pad(size);
    if (offset > blob.size - 2 * BLOCK) throw new Error('tar 被截断。');
    const data = blob.slice(start, start + size);
    if (type === 120) {
      if (size > 1024 || pax !== undefined) throw new Error('不支持的 PAX 扩展。');
      const text = decoder.decode(await data.arrayBuffer());
      const path = /^(\d+) path=([^\n]+)\n$/.exec(text);
      if (!path || Number(path[1]) !== size) throw new Error('无效的 PAX 文件名。');
      pax = checkName(path[2]);
      continue;
    }
    if (type !== 0 && type !== 48 || !isZero(h.subarray(345, 500))) throw new Error('只接受无路径的普通文件。');
    const name = checkName(pax ?? field(h.subarray(0, 100)));
    pax = undefined;
    if (entries.has(name) || entries.size >= LIMIT) throw new Error('归档含重复条目或条目过多。');
    entries.set(name, data);
  }
  throw new Error('tar 缺少结束块。');
}
