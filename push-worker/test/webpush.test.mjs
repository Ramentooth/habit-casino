/* The RFC 8291 §5 example, run through our own encryptPayload with the salt and the
   sender key pinned to the ones the RFC used. If the body comes out byte-identical to
   the one printed in the RFC, every step in between — ECDH, both HKDF stages, the
   record header, AES-GCM — is right. Then the same keys are used to decrypt it back,
   which is what a phone will do. */
import { encryptPayload, vapidHeader, b64uToBytes, bytesToB64u } from '../src/webpush.js';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};

const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic:  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPublic:  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  auth:      'BTBZMqHH6r4Tts7J_aSIgg',
  salt:      'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
      + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
      + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

console.log('\nRFC 8291 §5 — push message encryption');
const body = await encryptPayload(V.plaintext, V.uaPublic, V.auth,
  { salt: V.salt, asPrivate: V.asPrivate, asPublic: V.asPublic });
const got = bytesToB64u(body);
ok('encrypted body matches the RFC byte for byte', got === V.body,
   got === V.body ? '' : `got ${got}\n       want ${V.body}`);
// 16 salt + 4 record size + 1 key-id length + 65 key + 58 ciphertext. (The RFC's own
// HTTP example says Content-Length: 145; its base64url body decodes to 144, so the
// body above — which matches that body exactly — is the thing to trust.)
ok('body is 144 bytes: an 86-byte header and one 58-byte record', body.length === 144, `got ${body.length}`);
ok('header carries the 16-byte salt', bytesToB64u(body.slice(0, 16)) === V.salt);
ok('record size field is 4096', new DataView(body.buffer, body.byteOffset).getUint32(16) === 4096);
ok('key id is the 65-byte sender public key', body[20] === 65 && bytesToB64u(body.slice(21, 86)) === V.asPublic);

/* Decrypt it back the way a browser does — from the RECEIVER's private key — so the
   test proves the message is readable by the subscriber, not merely stable. */
console.log('\nRound trip — the subscriber can read it');
const { webcrypto: wc } = await import('node:crypto');
const enc = new TextEncoder();
const cat = (...ps) => { const o = new Uint8Array(ps.reduce((n, p) => n + p.length, 0)); let a = 0; for (const p of ps) { o.set(p, a); a += p.length; } return o; };
const hkdf = async (salt, ikm, info, len) => new Uint8Array(await wc.subtle.deriveBits(
  { name: 'HKDF', hash: 'SHA-256', salt, info },
  await wc.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));

const uaPub = b64uToBytes(V.uaPublic), asPub = b64uToBytes(V.asPublic);
const uaPriv = await wc.subtle.importKey('jwk', {
  kty: 'EC', crv: 'P-256', ext: true, d: V.uaPrivate,
  x: bytesToB64u(uaPub.slice(1, 33)), y: bytesToB64u(uaPub.slice(33, 65)),
}, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
const asPubKey = await wc.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
const shared = new Uint8Array(await wc.subtle.deriveBits({ name: 'ECDH', public: asPubKey }, uaPriv, 256));
ok('ECDH secret matches the RFC', bytesToB64u(shared) === 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs');

const ikm = await hkdf(b64uToBytes(V.auth), shared,
  cat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPub, asPub), 32);
ok('IKM matches the RFC', bytesToB64u(ikm) === 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg');
const cek = await hkdf(b64uToBytes(V.salt), ikm, cat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
const nonce = await hkdf(b64uToBytes(V.salt), ikm, cat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);
ok('CEK matches the RFC', bytesToB64u(cek) === 'oIhVW04MRdy2XN9CiKLxTg');
ok('nonce matches the RFC', bytesToB64u(nonce) === '4h_95klXJ5E_qnoN');

const clear = new Uint8Array(await wc.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 },
  await wc.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), body.slice(86)));
ok('decrypts to the original text', new TextDecoder().decode(clear.slice(0, -1)) === V.plaintext);
ok('last byte is the 0x02 end-of-record delimiter', clear[clear.length - 1] === 2);

/* A fresh ephemeral sender key every time is what keeps two identical messages from
   producing the same bytes — worth asserting, because pinning the key is a test-only path. */
console.log('\nEphemeral sender keys');
const a = bytesToB64u(await encryptPayload('same', V.uaPublic, V.auth));
const b = bytesToB64u(await encryptPayload('same', V.uaPublic, V.auth));
ok('two sends of the same payload differ', a !== b);

console.log('\nVAPID (RFC 8292)');
const vapid = await (await import('./keys.mjs')).testVapid();
const hdr = await vapidHeader('https://web.push.apple.com/abc123', vapid.publicKey, vapid.privateKey, 'mailto:you@example.com', 1_700_000_000);
const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(hdr);
ok('header is "vapid t=<jwt>, k=<public key>"', !!m);
const head = JSON.parse(new TextDecoder().decode(b64uToBytes(m[1])));
const claims = JSON.parse(new TextDecoder().decode(b64uToBytes(m[2])));
ok('alg is ES256', head.alg === 'ES256' && head.typ === 'JWT');
ok('aud is the push service ORIGIN, not the full endpoint', claims.aud === 'https://web.push.apple.com');
ok('exp is 12 hours out, inside the 24h the spec allows', claims.exp === 1_700_000_000 + 43200);
ok('sub carries the contact', claims.sub === 'mailto:you@example.com');
ok('k is the public key the app subscribes with', m[4] === vapid.publicKey);
ok('signature is a raw 64-byte P-256 pair', b64uToBytes(m[3]).length === 64);

// The signature has to verify against the PUBLIC key — that is the whole point of it.
const vpub = b64uToBytes(vapid.publicKey);
const verifyKey = await wc.subtle.importKey('jwk', {
  kty: 'EC', crv: 'P-256', ext: true,
  x: bytesToB64u(vpub.slice(1, 33)), y: bytesToB64u(vpub.slice(33, 65)),
}, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
ok('signature verifies against the public key', await wc.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' }, verifyKey, b64uToBytes(m[3]), enc.encode(`${m[1]}.${m[2]}`)));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
