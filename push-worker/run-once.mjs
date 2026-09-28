#!/usr/bin/env node
/* One pass of the sender from plain Node — the same tick.js the Worker runs.
   Useful for testing from this Mac, and the whole of what a GitHub Actions or
   launchd version of the sender would need to call.

   env: GCP_SERVICE_ACCOUNT (the JSON, or a path to it), VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY, VAPID_SUBJECT, SITE_URL */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { tick } = await import('./src/tick.js');

const raw = process.env.GCP_SERVICE_ACCOUNT || '';
const sa = JSON.parse(raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8'));
const report = await tick({
  sa,
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT || 'mailto:ramentooth@gmail.com',
  },
  siteUrl: process.env.SITE_URL || 'https://habitcasino-5d08b.firebaseapp.com/',
});
console.log(JSON.stringify(report));
