import { createMessage, enums, readKey, readSignature, verify } from 'openpgp';

const armored = new TextEncoder().encode('-----BEGIN PGP');
const looksArmored = data => armored.every((byte, i) => data[i] === byte);
export async function readDetached(detached) {
  if (!detached.size || detached.size > 1024 * 1024) throw new Error('签名大小无效。');
  const sig = new Uint8Array(await detached.arrayBuffer());
  const signature = await readSignature(looksArmored(sig) ? { armoredSignature: new TextDecoder().decode(sig) } : { binarySignature: sig });
  if (signature.packets.length !== 1 || signature.packets[0].signatureType !== enums.signature.binary) {
    throw new Error('需要一个对原文件字节生成的二进制分离签名；可用 ASCII 装甲。');
  }
  return signature;
}

export async function verifyPgp(original, detached, publicKey) {
  if (!original || !detached || !publicKey) throw new Error('原文件、分离签名和公钥均必需。');
  if (publicKey.size > 1024 * 1024) throw new Error('公钥过大。');
  const signature = await readDetached(detached);
  const key = new Uint8Array(await publicKey.arrayBuffer());
  const verificationKeys = await readKey(looksArmored(key) ? { armoredKey: new TextDecoder().decode(key) } : { binaryKey: key });
  if (verificationKeys.isPrivate()) throw new Error('请只选择公钥，不要导入私钥。');
  const message = await createMessage({ binary: original.stream() });
  const { signatures, data } = await verify({ message, signature, verificationKeys, format: 'binary' });
  if (signatures.length !== 1) throw new Error('没有可验证的 OpenPGP 签名。');
  // Reading this branch drives the verifier's passive clone. Use the method
  // patched by OpenPGP.js, not the native Symbol.asyncIterator on the input.
  if (data?.getReader) {
    const reader = data.getReader();
    try { while (!(await reader.read()).done) { /* discard verified payload */ } }
    finally { reader.releaseLock(); }
  }
  await signatures[0].verified;
  return verificationKeys.getFingerprint();
}
