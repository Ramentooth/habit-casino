/* =====================================================================
   WEB PUSH — RFC 8291 payload encryption + RFC 8292 (VAPID) auth.

   Written against Web Crypto ONLY, with no Node built-ins, so the exact
   same file runs in a Cloudflare Worker and under `node --test`. That is
   what lets the RFC 8291 test vector in ../test/ prove the crypto here is
   right without a phone in the loop.

   The flow, once: the browser hands you a subscription — an endpoint URL
   belonging to Apple (or Google, or Mozilla), the subscriber's public key
   `p256dh`, and a 16-byte shared `auth` secret. You encrypt the payload so
   only that browser can read it, sign a token proving who you are, and POST
   it to the endpoint. The push service stores and forwards it; it never sees
   the contents.
   ===================================================================== */

const enc = new TextEncoder();

export function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64u(b) {
  let s = '';
  const a = new Uint8Array(b);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// HKDF (extract + expand in one call, which is exactly what Web Crypto's HKDF does).
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

// A P-256 private key given as the raw 32-byte scalar `d`. The public point is
// needed alongside it because JWK import wants x and y as well — for the VAPID key
// the caller has both; for an ephemeral key we generate the pair and never split it.
async function importEcdhPrivate(d, publicPoint) {
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    d: bytesToB64u(d),
    x: bytesToB64u(publicPoint.slice(1, 33)),
    y: bytesToB64u(publicPoint.slice(33, 65)),
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

/* ---- Payload encryption (RFC 8291 §3.4, content coding aes128gcm from RFC 8188).
   Returns the complete request body: a single record, header and all. ---- */
export async function encryptPayload(payload, p256dhB64u, authB64u, opts = {}) {
  const uaPublic = b64uToBytes(p256dhB64u);          // the subscriber's public point
  const authSecret = b64uToBytes(authB64u);          // 16 bytes, shared with the subscriber
  const salt = opts.salt ? b64uToBytes(opts.salt) : crypto.getRandomValues(new Uint8Array(16));

  // The sender's key is ephemeral — one message, one key pair — unless a test pins it.
  let asPublic, asPrivKey;
  if (opts.asPrivate && opts.asPublic) {
    asPublic = b64uToBytes(opts.asPublic);
    asPrivKey = await importEcdhPrivate(b64uToBytes(opts.asPrivate), asPublic);
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    asPrivKey = pair.privateKey;
  }

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivKey, 256));

  // Two-stage derivation: the auth secret and both public keys bind the key to THIS
  // subscription, then the random salt binds it to this one message.
  const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  // 0x02 is the delimiter that says "this is the last record" — one record is all we send.
  const plaintext = concat(typeof payload === 'string' ? enc.encode(payload) : payload, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext));

  // Header: salt(16) | record size(4, big-endian) | key id length(1) | key id (the sender's public key)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

/* ---- VAPID (RFC 8292): an ES256 JWT saying who is sending, plus the public key that
   verifies it. This is what ties a push to your application server rather than to a
   subscription, and Apple's push service rejects anything without it. ---- */
export async function vapidHeader(endpoint, vapidPublicB64u, vapidPrivateB64u, subject, nowSec) {
  const aud = new URL(endpoint).origin;
  const now = nowSec || Math.floor(Date.now() / 1000);
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  // 12 hours: comfortably inside the 24h the spec allows, so clock skew can't expire it early.
  const body = bytesToB64u(enc.encode(JSON.stringify({ aud, exp: now + 12 * 3600, sub: subject })));
  const signingInput = enc.encode(`${header}.${body}`);

  const pub = b64uToBytes(vapidPublicB64u);
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    d: vapidPrivateB64u,
    x: bytesToB64u(pub.slice(1, 33)),
    y: bytesToB64u(pub.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput);
  const jwt = `${header}.${body}.${bytesToB64u(sig)}`;
  return `vapid t=${jwt}, k=${vapidPublicB64u}`;
}

/* ---- One push, start to finish. Returns the push service's status so the caller can
   drop a subscription the service says is dead (404/410) instead of retrying it
   forever. ---- */
export async function sendPush(sub, payload, vapid, opts = {}) {
  const body = await encryptPayload(payload, sub.p256dh, sub.auth, opts);
  const auth = await vapidHeader(sub.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject, opts.nowSec);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': auth,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': String(opts.ttl ?? 600),          // a reminder that's ten minutes stale is noise
      'Urgency': opts.urgency || 'high',
    },
    body,
  });
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410,
           text: res.ok ? '' : await res.text().catch(() => '') };
}
