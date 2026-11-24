import { createMessage, enums, PacketList, PublicKey, PublicKeyPacket, PublicSubkeyPacket, readSignature, SignaturePacket, unarmor, UserAttributePacket, UserIDPacket, verify } from 'openpgp';

const armored = new TextEncoder().encode('-----BEGIN PGP');
const looksArmored = data => armored.every((byte, i) => data[i] === byte);
const publicPackets = Object.fromEntries(
  [PublicKeyPacket, PublicSubkeyPacket, SignaturePacket, UserAttributePacket, UserIDPacket].map(Packet => [Packet.tag, Packet]),
);

async function readPublicKey(file) {
  if (!file.size || file.size > 1024 * 1024) throw new Error('公钥大小无效。');
  let data = new Uint8Array(await file.arrayBuffer());
  if (looksArmored(data)) {
    const unpacked = await unarmor(new TextDecoder().decode(data));
    if (unpacked.type !== enums.armor.publicKey) throw new Error('请只选择公钥，不要导入私钥。');
    data = unpacked.data;
  }
  // Exclude secret-key packets, including binary exports.
  let packets;
  try { packets = await PacketList.fromBinary(data, publicPackets); }
  catch { throw new Error('文件不是有效的 OpenPGP 公钥；请勿导入私钥。'); }
  if (packets.indexOfTag(enums.packet.publicKey).length !== 1) throw new Error('请选择只含一个 OpenPGP 公钥的文件。');
  return new PublicKey(packets);
}
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
  const signature = await readDetached(detached);
  const verificationKeys = await readPublicKey(publicKey);
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
