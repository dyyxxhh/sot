import digicert from '../public/roots/digicert.pem?raw';
import freetsa from '../public/roots/freetsa.pem?raw';
import freetsaSigner from '../public/roots/freetsa-signer.pem?raw';
import { readCertificate } from './tsa.mjs';

// Embed the pinned PEMs in the client so offline actions never fetch trust data.
const trust = {
  digicert: { root: readCertificate(digicert) },
  freetsa: { root: readCertificate(freetsa), signer: readCertificate(freetsaSigner) },
};
export function getTrust(id) {
  if (!Object.hasOwn(trust, id)) throw new Error(`没有为 ${id} 配置信任根。`);
  return trust[id];
}