/* =====================================================================
   FIRESTORE, over REST, with a service account — Web Crypto only so it runs
   in a Worker.

   Only three fields are ever touched, and two of them are plain strings:

     pushQueue/{uid}
       nextAt     number   when the soonest unsent reminder is due (0 = nothing pending)
       data       string   JSON the APP writes:    { subs: [...], items: [...] }
       sentData   string   JSON the WORKER writes: { sent: { "<id>:<at>": <ms> } }

   The app and the worker each own their own field, so neither can overwrite what
   the other just wrote — which is what keeps a reminder from being sent twice when
   a plan update lands mid-send. Packing the structure into a JSON string also keeps
   this file free of Firestore's typed-value encoding for maps and arrays.
   ===================================================================== */

const enc = new TextEncoder();
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pemToBytes(pem) {
  const body = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* A service account's own JWT, exchanged for an access token. Tokens last an hour;
   a Worker instance may handle many cron ticks, so the live one is reused. */
let cachedToken = null;
export async function accessToken(sa) {
  if (cachedToken && cachedToken.exp > Date.now() / 1000 + 60) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const input = `${b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))}.${b64u(enc.encode(JSON.stringify(claim)))}`;
  const key = await crypto.subtle.importKey('pkcs8', pemToBytes(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input)));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${sig}` }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  cachedToken = { token: json.access_token, exp: now + (json.expires_in || 3600) };
  return cachedToken.token;
}

const base = pid => `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;

/* Everyone with a reminder due. Two conditions on one field is a range query, which
   Firestore serves from the automatic single-field index — no index to deploy. */
export async function dueQueues(sa, pid, nowMs) {
  const res = await fetch(`${base(pid)}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(sa)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'pushQueue' }],
        where: { compositeFilter: { op: 'AND', filters: [
          { fieldFilter: { field: { fieldPath: 'nextAt' }, op: 'GREATER_THAN', value: { integerValue: '0' } } },
          { fieldFilter: { field: { fieldPath: 'nextAt' }, op: 'LESS_THAN_OR_EQUAL', value: { integerValue: String(nowMs) } } },
        ] } },
        orderBy: [{ field: { fieldPath: 'nextAt' }, direction: 'ASCENDING' }],
        limit: 100,
      },
    }),
  });
  if (!res.ok) throw new Error(`runQuery failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return rows.filter(r => r.document).map(r => {
    const f = r.document.fields || {};
    const str = k => (f[k] && f[k].stringValue) || '';
    const parse = (k, dflt) => { try { return str(k) ? JSON.parse(str(k)) : dflt; } catch { return dflt; } };
    return {
      name: r.document.name,                       // full resource path, for the write-back
      uid: r.document.name.split('/').pop(),
      nextAt: Number((f.nextAt && (f.nextAt.integerValue ?? f.nextAt.doubleValue)) || 0),
      data: parse('data', { subs: [], items: [] }),
      sent: parse('sentData', { sent: {} }).sent || {},
    };
  });
}

/* Only the worker's own two fields go back, named in the update mask so the app's
   `data` field is left exactly as the app last wrote it. */
export async function writeSent(sa, pid, docName, sent, nextAt) {
  const url = `https://firestore.googleapis.com/v1/${docName}`
    + '?updateMask.fieldPaths=sentData&updateMask.fieldPaths=nextAt&updateMask.fieldPaths=workerAt';
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await accessToken(sa)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      sentData: { stringValue: JSON.stringify({ sent }) },
      nextAt: { integerValue: String(Math.round(nextAt || 0)) },
      workerAt: { integerValue: String(Date.now()) },
    } }),
  });
  if (!res.ok) throw new Error(`patch failed: ${res.status} ${await res.text()}`);
}

/* A subscription the push service says is gone is dropped from the app's own field —
   the one case where the worker touches `data`, because a dead endpoint would
   otherwise be retried on every tick until the app happens to resubscribe. */
export async function dropSubs(sa, pid, docName, data, goneEndpoints) {
  const kept = (data.subs || []).filter(s => !goneEndpoints.includes(s.endpoint));
  const res = await fetch(`https://firestore.googleapis.com/v1/${docName}?updateMask.fieldPaths=data`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await accessToken(sa)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { data: { stringValue: JSON.stringify({ ...data, subs: kept }) } } }),
  });
  if (!res.ok) throw new Error(`patch (drop subs) failed: ${res.status} ${await res.text()}`);
}
