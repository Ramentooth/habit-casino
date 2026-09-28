/* =====================================================================
   ONE PASS of the sender: find reminders that have come due, push them, and
   remember what was sent.

   Nothing in this file is Cloudflare-specific — it needs `fetch` and Web Crypto
   and nothing else, so the same code runs from the Worker (src/index.js, on a
   one-minute cron) or from plain Node (run-once.mjs). Moving the sender somewhere
   else later means writing a new entry point, not rewriting this.
   ===================================================================== */
import { sendPush } from './webpush.js';
import { dueQueues, writeSent, dropSubs } from './firestore.js';

// Clock skew between the phone that wrote the plan and the machine reading it.
const GRACE_MS = 5 * 1000;
// A reminder this far past its moment has been overtaken by events. Swallow it rather
// than buzzing someone about a timer that ran out while the sender was down.
const STALE_MS = 10 * 60 * 1000;
// How long a "we already sent this" marker is worth keeping.
const SENT_TTL_MS = 12 * 60 * 60 * 1000;

/* Understood by both generations of iOS: on 18.4+ the `web_push: 8030` envelope is
   shown by the system itself, with no service worker involved; on 16.4–18.3 the same
   JSON arrives at the service worker's push handler, which reads the same fields. */
export function payloadFor(item, siteUrl) {
  return JSON.stringify({
    web_push: 8030,
    notification: {
      title: item.title || 'Habit Casino',
      body: item.body || '',
      lang: 'en-US',
      dir: 'auto',
      tag: item.id || undefined,
      navigate: siteUrl,
    },
  });
}

export async function tick(cfg, nowMs = Date.now()) {
  const { sa, vapid, siteUrl } = cfg;
  const pid = cfg.projectId || sa.project_id;
  const rows = await dueQueues(sa, pid, nowMs + GRACE_MS);
  const report = { checked: rows.length, sent: 0, failed: 0, dropped: 0, stale: 0 };

  for (const row of rows) {
    const items = row.data.items || [];
    const subs = row.data.subs || [];
    const sent = { ...row.sent };
    const gone = [];

    for (const item of items) {
      if (!item || !Number.isFinite(item.at)) continue;
      if (item.at > nowMs + GRACE_MS) continue;                 // not yet
      const key = `${item.id}:${item.at}`;                      // id AND time: a rescheduled reminder is a new one
      if (sent[key]) continue;
      if (item.at < nowMs - STALE_MS) { sent[key] = nowMs; report.stale++; continue; }

      for (const sub of subs) {
        try {
          const res = await sendPush(sub, payloadFor(item, siteUrl), vapid, { ttl: 300, urgency: 'high' });
          if (res.gone) { gone.push(sub.endpoint); report.dropped++; }
          else if (res.ok) report.sent++;
          else { report.failed++; console.log(`push ${res.status} for ${row.uid}: ${res.text.slice(0, 200)}`); }
        } catch (e) {
          report.failed++;
          console.log(`push threw for ${row.uid}: ${(e && e.message) || e}`);
        }
      }
      // Marked either way. A push that failed is not worth retrying every minute until
      // it goes stale — the app rewrites the whole plan whenever anything changes, so a
      // genuinely still-relevant reminder comes back with a fresh time.
      sent[key] = nowMs;
    }

    for (const k of Object.keys(sent)) if (sent[k] < nowMs - SENT_TTL_MS) delete sent[k];

    // Next wake-up: the soonest item still ahead of us that hasn't been sent. Zero means
    // "nothing pending", which drops this user out of the query entirely.
    const pending = items
      .filter(i => i && Number.isFinite(i.at) && !sent[`${i.id}:${i.at}`] && i.at > nowMs)
      .map(i => i.at);
    await writeSent(sa, pid, row.name, sent, pending.length ? Math.min(...pending) : 0);
    if (gone.length) await dropSubs(sa, pid, row.name, row.data, gone);
  }
  return report;
}
