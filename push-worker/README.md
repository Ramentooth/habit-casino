# Habit Casino push sender

Reminders for the **Home Screen web app** — so an iPhone gets buzzed when a reward's
timer runs out or a habit passes its usual length, without the wrapper app from Xcode.

## Why this exists at all

A web page cannot schedule a notification for later. There is no API for it in any
browser, and a page that isn't running can't run a timer. The only thing that reaches a
closed app is a **push**, sent at that moment by a server.

So the app mirrors the reminder plan it already derives into Firestore, and this — a cron
that runs every minute — sends whatever has come due:

```
 the app (iPhone)                 Firestore                 this worker            Apple
 ───────────────────              ─────────                 ───────────            ─────
 reminderPlan()  ──writes──▶  pushQueue/{uid}  ──reads──▶  due? encrypt   ──POST──▶ APNs
                                                            + sign VAPID            │
                                            ◀──writes sentData──                    ▼
                                                                            🔔 on the phone
```

`pushQueue/{uid}` has three fields, and the two sides own separate ones so neither can
overwrite the other:

| field      | written by | holds                                                   |
|------------|-----------|----------------------------------------------------------|
| `data`     | the app   | `{ subs: [...devices], items: [...future reminders] }`     |
| `sentData` | the worker| `{ sent: { "<id>:<at>": <ms> } }` — what has gone out      |
| `nextAt`   | either    | when the soonest unsent reminder is due; `0` = nothing     |

## What runs where

- `src/webpush.js` — payload encryption (RFC 8291) and VAPID auth (RFC 8292).
- `src/firestore.js` — service-account OAuth and the two REST calls it needs.
- `src/tick.js` — one pass: find what's due, send it, write back what was sent.
- `src/index.js` — the Cloudflare Worker: a cron that calls `tick()`, plus `/health`,
  `/run` and `/test` for standing next to your phone and finding out what's happening.
- `run-once.mjs` — the same `tick()` from plain Node.

Nothing outside `index.js` is Cloudflare-specific: `tick.js` needs `fetch` and Web Crypto
and nothing else. Moving the sender somewhere else means a new entry point, not a rewrite.

## Setting it up

You need a Cloudflare account (free, no card) and a service-account key for the Firebase
project.

**1. A service-account key.** Either reuse the JSON already behind the GitHub secret
`FIREBASE_SERVICE_ACCOUNT_HABITCASINO_5D08B`, or make a fresh one:

```bash
gcloud iam service-accounts keys create ~/hc-push-sa.json \
  --iam-account=firebase-adminsdk@habitcasino-5d08b.iam.gserviceaccount.com
```

(Firebase console → Project settings → Service accounts → Generate new private key does
the same thing.) This file is a credential — keep it off GitHub.

**2. Deploy the worker.**

```bash
cd push-worker
npx wrangler login
npx wrangler deploy
```

**3. Give it its secrets.** `VAPID_PRIVATE_KEY` is in `vapid.json` next to the app's
working file — it is deliberately *not* in this repo, because the repo is public.

```bash
npx wrangler secret put GCP_SERVICE_ACCOUNT   # paste the whole JSON, one line
npx wrangler secret put VAPID_PRIVATE_KEY     # from vapid.json
npx wrangler secret put VAPID_PUBLIC_KEY      # from vapid.json — must match the app
npx wrangler secret put VAPID_SUBJECT         # mailto:ramentooth@gmail.com
npx wrangler secret put RUN_KEY               # any random string; guards the endpoints
```

**4. Deploy the Firestore rule** that lets the app write its own queue document:

```bash
firebase deploy --only firestore:rules
```

## On the phone

Web push on iOS only works for an **installed** web app — a Safari tab has no
`PushManager` at all. So: open the beta URL in Safari, Share → **Add to Home Screen**,
open it from the Home Screen icon, then Settings → 🔔 Reminders → **Turn on push
notifications**. You also have to be signed in under ☁️ Cloud Save, because the sender
reads the plan from your account.

## Checking it

```bash
curl "https://habit-casino-push.<your-subdomain>.workers.dev/health?key=$RUN_KEY"
curl "https://habit-casino-push.<your-subdomain>.workers.dev/test?key=$RUN_KEY"   # buzz the phone now
npx wrangler tail                                                                 # watch the cron live
```

`/health` lists every account with a queue, how many devices it has and how many
reminders are pending — which is usually enough to tell whether the phone's subscription
ever arrived.

## Tests

```bash
npm test
```

- `test/webpush.test.mjs` — the RFC 8291 §5 example, byte for byte, plus a round trip
  decrypted with the receiver's key, plus VAPID signature verification.
- `test/tick.test.mjs` — the whole sender against a fake Firestore and a fake push
  endpoint that **decrypts** what it receives: due/not due, no double sends, a
  rescheduled reminder counting as new, stale reminders swallowed, two devices, and a
  410 dropping a dead subscription.
- `test/sw.test.mjs` — the service worker's push and notificationclick handlers.

## If you'd rather not run this on Cloudflare

`run-once.mjs` is the whole sender in one Node call:

```bash
GCP_SERVICE_ACCOUNT=~/hc-push-sa.json \
VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… VAPID_SUBJECT=mailto:ramentooth@gmail.com \
node run-once.mjs
```

- **GitHub Actions** (`schedule: cron: "*/5 * * * *"`) needs no new account and reuses the
  service-account secret that already deploys the site — but GitHub's scheduler runs at
  most every five minutes and is routinely 5–15 minutes late, so "your 30 minutes is up"
  would often arrive well after the fact.
- **Firebase Cloud Functions** would be exact to the second via Cloud Tasks, and lives in
  the project already — but Cloud Functions needs the Blaze plan, i.e. a card on file.
  This volume stays inside the free allowance, so it would cost about nothing; the card
  is the price of entry.
