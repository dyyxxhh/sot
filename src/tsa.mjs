import * as asn from 'asn1js';
import * as pki from 'pkijs';
import { hashBlob, hex, readLimited, same } from './hash.mjs';

const SHA = {
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};
const TST = '1.2.840.113549.1.9.16.1.4';
const ATTR = '1.2.840.113549.1.9.';
const bytes = x => x.valueBlock.valueHexView;
const objectID = x => x?.valueBlock?.toString();
let configured = false;
function engine() {
  if (!configured) {
    pki.setEngine('WebCrypto', new pki.CryptoEngine({ name: 'WebCrypto', crypto: globalThis.crypto }));
    configured = true;
  }
}
export function makeRequest(digest) {
  if (digest.length !== 32) throw new Error('时间戳请求需要 SHA-256 摘要。');
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  nonce[0] = (nonce[0] & 127) | 1;
  return new pki.TimeStampReq({ version: 1, certReq: true, nonce: new asn.Integer({ valueHex: nonce }),
    messageImprint: new pki.MessageImprint({ hashAlgorithm: new pki.AlgorithmIdentifier({ algorithmId: '2.16.840.1.101.3.4.2.1' }),
      hashedMessage: new asn.OctetString({ valueHex: digest }) }) }).toSchema().toBER(false);
}

export function checkRelayRequest(buf) {
  const parsed = asn.fromBER(buf);
  const req = new pki.TimeStampReq({ schema: parsed.result });
  if (parsed.offset !== buf.byteLength || req.version !== 1 || SHA[req.messageImprint.hashAlgorithm.algorithmId] !== 'SHA-256' ||
      bytes(req.messageImprint.hashedMessage).length !== 32 || req.certReq !== true || !req.nonce || req.reqPolicy || req.extensions?.length ||
      !same(new Uint8Array(req.toSchema().toBER(false)), new Uint8Array(buf)) || bytes(req.nonce).length !== 16 ||
      req.messageImprint.hashAlgorithm.algorithmParams) throw new Error('不支持的时间戳请求。');
}

export function readCertificate(pem) {
  const encoded = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem)?.[1];
  if (!encoded) throw new Error('证书 PEM 无效。');
  return pki.Certificate.fromBER(Uint8Array.from(atob(encoded.replace(/\s/g, '')), ch => ch.charCodeAt(0)));
}

function attribute(attrs, oid) {
  const found = attrs.filter(a => a.type === oid);
  if (found.length !== 1 || found[0].values.length !== 1) throw new Error('时间戳签名属性缺失或重复。');
  return found[0].values[0];
}

async function checkESS(attrs, certificate) {
  const v2 = ATTR + '16.2.47', v1 = ATTR + '16.2.12';
  const oid = attrs.some(a => a.type === v2) ? v2 : v1;
  const first = attribute(attrs, oid).valueBlock.value?.[0]?.valueBlock.value?.[0]?.valueBlock.value;
  if (!first?.length) throw new Error('时间戳签名证书标识无效。');
  let alg = oid === v2 ? 'SHA-256' : 'SHA-1';
  let imprint = first[0];
  if (oid === v2 && imprint instanceof asn.Sequence) {
    alg = SHA[objectID(imprint.valueBlock.value[0])];
    imprint = first[1];
  }
  const certDER = certificate.toSchema().toBER(false);
  if (!alg || !(imprint instanceof asn.OctetString) || !same(bytes(imprint), new Uint8Array(await crypto.subtle.digest(alg, certDER)))) {
    throw new Error('时间戳签名证书标识不匹配。');
  }
}

export async function verifyTsr(blob, target, { root, signer, nonce, digest } = {}) {
  engine();
  const raw = await blob.arrayBuffer();
  const parsed = asn.fromBER(raw);
  const resp = new pki.TimeStampResp({ schema: parsed.result });
  if (parsed.offset !== raw.byteLength || ![0, 1].includes(resp.status.status) || resp.timeStampToken?.contentType !== pki.ContentInfo.SIGNED_DATA) {
    throw new Error(`不是有效的 RFC 3161 成功回执（状态 ${resp.status.status}）。`);
  }
  const signed = new pki.SignedData({ schema: resp.timeStampToken.content });
  const content = signed.encapContentInfo.eContent;
  if (signed.signerInfos.length !== 1 || signed.encapContentInfo.eContentType !== TST || !(content instanceof asn.OctetString)) throw new Error('时间戳 CMS 结构无效。');
  const attrs = signed.signerInfos[0].signedAttrs?.attributes ?? [];
  if (objectID(attribute(attrs, ATTR + '3')) !== TST) throw new Error('时间戳签名内容类型不匹配。');
  attribute(attrs, ATTR + '4');
  const info = pki.TSTInfo.fromBER(content.getValue());
  const alg = SHA[info.messageImprint.hashAlgorithm.algorithmId];
  if (info.version !== 1 || !alg || !Number.isFinite(info.genTime.getTime()) || !same(bytes(info.messageImprint.hashedMessage), digest && alg === 'SHA-256' ? digest : await hashBlob(target, alg))) throw new Error('时间戳与文件不匹配。');
  if (nonce && (!info.nonce || !same(bytes(nonce), bytes(info.nonce)))) throw new Error('时间戳请求随机数不匹配。');
  if (!root) throw new Error('没有为这家机构配置可信根证书。');
  // A reply can include a cross-signed copy of the pinned root. Omit it so
  // PKI.js builds the path to our trust anchor, not to the cross-signing CA.
  signed.certificates = (signed.certificates ?? []).filter(cert => cert instanceof pki.Certificate && !cert.subject.isEqual(root.subject));
  if (signer && !signed.certificates.some(cert => same(new Uint8Array(cert.toSchema().toBER(false)), new Uint8Array(signer.toSchema().toBER(false))))) {
    signed.certificates.push(signer);
  }
  // PKI.js's TSTInfo path needs the entire file in memory and rejects empty input.
  // The streaming imprint was checked above. CMS still verifies the unchanged
  // eContent and signed attributes; its content-type attribute was checked explicitly.
  signed.encapContentInfo.eContentType = pki.ContentInfo.DATA;
  const result = await signed.verify({ signer: 0, checkChain: true, trustedCerts: [root], checkDate: info.genTime, extendedMode: true });
  const cert = result.signerCertificate;
  const chainRoot = result.certificatePath?.at(-1);
  if (!result.signatureVerified || !result.signerCertificateVerified || !cert || !chainRoot ||
      !same(new Uint8Array(chainRoot.toSchema().toBER(false)), new Uint8Array(root.toSchema().toBER(false)))) throw new Error('时间戳签名或信任链验证失败。');
  const eku = cert.extensions?.filter(e => e.extnID === '2.5.29.37') ?? [];
  if (eku.length !== 1 || !eku[0].critical || eku[0].parsedValue?.keyPurposes?.join(',') !== '1.3.6.1.5.5.7.3.8') throw new Error('签名证书未限定为时间戳用途。');
  await checkESS(attrs, cert);
  return { time: info.genTime.toISOString(), imprint: hex(bytes(info.messageImprint.hashedMessage)) };
}

export async function requestTsa(id, digest, target, trust) {
  const query = makeRequest(digest);
  const blob = await readLimited(await fetch(`/api/tsa/${id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: query, signal: AbortSignal.timeout(16000),
  }), 256 * 1024);
  await verifyTsr(blob, target, { ...trust, nonce: pki.TimeStampReq.fromBER(query).nonce, digest });
  return blob;
}
