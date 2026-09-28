/* A throwaway VAPID pair, generated per run. The real one is NOT in this repo — the repo
   is public — and the tests don't need it: what they check is that the signature verifies
   against whatever public key was used, which is true of any valid pair. */
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const b64u = b => Buffer.from(b).toString('base64url');
export async function testVapid() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: b64u(raw), privateKey: jwk.d };
}
