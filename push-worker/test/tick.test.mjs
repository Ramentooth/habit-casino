/* The sender, end to end, with the network faked: a stub Firestore that serves one
   queue document, and a stub push endpoint that DECRYPTS what we send it using a
   subscription key pair generated here. So these tests check the thing that actually
   matters — the right person gets the right words at the right minute — and not just
   that some bytes were posted.

   Run: node test/tick.test.mjs */
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { tick } = await import('../src/tick.js');
const { bytesToB64u, b64uToBytes } = await import('../src/webpush.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};

// ---- a subscription, the way a browser would hand one over ----
const uaPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaPair.publicKey));
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const SUB = { endpoint: 'https://web.push.apple.com/DEVICE-ONE', deviceId: 'dev1',
              p256dh: bytesToB64u(uaPublic), auth: bytesToB64u(authSecret) };

const enc = new TextEncoder();
const cat = (...ps) => { const o = new Uint8Array(ps.reduce((n, p) => n + p.length, 0)); let a = 0; for (const p of ps) { o.set(p, a); a += p.length; } return o; };
const hkdf = async (salt, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits(
  { name: 'HKDF', hash: 'SHA-256', salt, info },
  await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), len * 8));

// What the phone does with the bytes that arrive.
async function decryptAsDevice(body) {
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 86);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPair.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, cat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, cat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);
  const clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 },
    await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), body.slice(86)));
  return JSON.parse(new TextDecoder().decode(clear.slice(0, -1)));
}

// ---- the fake world ----
const SA = { client_email: 'worker@example.iam.gserviceaccount.com', project_id: 'habitcasino-5d08b',
             // a throwaway RSA key, only ever used to sign a token this test itself answers
             private_key: null };
{
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let b64 = Buffer.from(pkcs8).toString('base64').replace(/(.{64})/g, '$1\n');
  SA.private_key = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

function makeWorld(docFields) {
  const world = { pushes: [], patches: [], queryBodies: [], tokenCalls: 0, doc: { ...docFields } };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      world.tokenCalls++;
      return new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 3600 }),
        { headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes(':runQuery')) {
      world.queryBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify([{ document: {
        name: 'projects/p/databases/(default)/documents/pushQueue/UID1',
        fields: world.doc,
      } }]), { headers: { 'Content-Type': 'application/json' } });
    }
    if (init.method === 'PATCH') {
      world.patches.push({ url: u, fields: JSON.parse(init.body).fields });
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    }
    if (u.startsWith('https://web.push.apple.com/')) {
      world.pushes.push({ endpoint: u, headers: init.headers, body: new Uint8Array(init.body) });
      return new Response('', { status: 201 });
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return world;
}

const VAPID = await (await import('./keys.mjs')).testVapid();
const cfg = { sa: SA, vapid: { ...VAPID, subject: 'mailto:you@example.com' }, siteUrl: 'https://habitcasino-5d08b.firebaseapp.com/' };
const NOW = 1_800_000_000_000;
const qdoc = (items, sent = {}, subs = [SUB]) => ({
  data: { stringValue: JSON.stringify({ subs, items }) },
  sentData: { stringValue: JSON.stringify({ sent }) },
  nextAt: { integerValue: String(items.length ? Math.min(...items.map(i => i.at)) : 0) },
});

console.log('\nA reminder that has come due');
{
  const w = makeWorld(qdoc([
    { id: 'rw-1', at: NOW - 1000, title: '⌛ Movie night', body: 'Your 30m is up.' },
    { id: 'ov-2', at: NOW + 20 * 60000, title: '⏱ Cello', body: 'Past the usual 30m.' },
  ]));
  const report = await tick(cfg, NOW);
  ok('one push sent, the future one left alone', w.pushes.length === 1, JSON.stringify(report));
  ok('sent to this device\'s endpoint', w.pushes[0].endpoint === SUB.endpoint);
  const payload = await decryptAsDevice(w.pushes[0].body);
  ok('payload is the declarative envelope iOS 18.4+ reads itself', payload.web_push === 8030);
  ok('title survives the trip', payload.notification.title === '⌛ Movie night');
  ok('body survives the trip', payload.notification.body === 'Your 30m is up.');
  ok('navigate points at the app', payload.notification.navigate === 'https://habitcasino-5d08b.firebaseapp.com/');
  ok('tag is the reminder id, so a repeat replaces rather than stacks', payload.notification.tag === 'rw-1');

  const h = w.pushes[0].headers;
  ok('Authorization is a VAPID header', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/.test(h.Authorization));
  ok('Content-Encoding is aes128gcm', h['Content-Encoding'] === 'aes128gcm');
  ok('TTL is short — a stale reminder is noise', Number(h.TTL) <= 600);

  const fields = w.patches[0].fields;
  ok('what was sent is written back', JSON.parse(fields.sentData.stringValue).sent[`rw-1:${NOW - 1000}`] === NOW);
  ok('nextAt moves to the still-pending reminder', Number(fields.nextAt.integerValue) === NOW + 20 * 60000);
  ok('the app\'s own field is not touched by that write', !('data' in fields));
}

console.log('\nThe same reminder on the next tick');
{
  const w = makeWorld(qdoc([{ id: 'rw-1', at: NOW - 1000, title: 'x', body: 'y' }],
                           { [`rw-1:${NOW - 1000}`]: NOW - 500 }));
  await tick(cfg, NOW);
  ok('already-sent reminder is not sent twice', w.pushes.length === 0);
  ok('nextAt drops to 0 — nothing left pending', Number(w.patches[0].fields.nextAt.integerValue) === 0);
}

console.log('\nA reminder rescheduled to a new time');
{
  const w = makeWorld(qdoc([{ id: 'rw-1', at: NOW - 1000, title: 'x', body: 'y' }],
                           { [`rw-1:${NOW - 99999}`]: NOW - 99999 }));   // sent at its OLD time
  await tick(cfg, NOW);
  ok('a new time makes it a new reminder', w.pushes.length === 1);
}

console.log('\nA reminder the sender slept through');
{
  const w = makeWorld(qdoc([{ id: 'rw-1', at: NOW - 40 * 60000, title: 'x', body: 'y' }]));
  const report = await tick(cfg, NOW);
  ok('40 minutes late: swallowed, not buzzed', w.pushes.length === 0 && report.stale === 1);
  ok('still marked, so it never comes back', !!JSON.parse(w.patches[0].fields.sentData.stringValue).sent[`rw-1:${NOW - 40 * 60000}`]);
}

console.log('\nTwo devices');
{
  const w = makeWorld(qdoc([{ id: 'rw-1', at: NOW - 1000, title: 'x', body: 'y' }], {},
    [SUB, { ...SUB, endpoint: 'https://web.push.apple.com/DEVICE-TWO', deviceId: 'dev2' }]));
  await tick(cfg, NOW);
  ok('both phones get it', w.pushes.length === 2);
  ok('each to its own endpoint', new Set(w.pushes.map(p => p.endpoint)).size === 2);
}

console.log('\nA subscription the push service says is gone');
{
  const w = makeWorld(qdoc([{ id: 'rw-1', at: NOW - 1000, title: 'x', body: 'y' }]));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://web.push.apple.com/')) return new Response('gone', { status: 410 });
    return realFetch(url, init);
  };
  const report = await tick(cfg, NOW);
  ok('410 is reported as a dead subscription', report.dropped === 1);
  const drop = w.patches.find(p => p.fields.data);
  ok('the dead device is removed from the app\'s list', drop && JSON.parse(drop.fields.data.stringValue).subs.length === 0);
}

console.log('\nOnly what is due is even looked at');
{
  const w = makeWorld(qdoc([{ id: 'a', at: NOW + 60000, title: 'x', body: 'y' }]));
  await tick(cfg, NOW);
  const f = w.queryBodies[0].structuredQuery.where.compositeFilter.filters;
  ok('the query asks for nextAt > 0 and nextAt <= now', f.length === 2
     && f[0].fieldFilter.op === 'GREATER_THAN' && f[1].fieldFilter.op === 'LESS_THAN_OR_EQUAL');
  ok('a future reminder sends nothing', w.pushes.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
