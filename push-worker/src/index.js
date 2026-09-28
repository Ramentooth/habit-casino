/* Cloudflare Worker entry point. The cron in wrangler.toml fires this every minute;
   everything it does lives in tick.js. */
import { tick } from './tick.js';
import { sendPush } from './webpush.js';
import { dueQueues } from './firestore.js';

function config(env) {
  return {
    sa: JSON.parse(env.GCP_SERVICE_ACCOUNT),
    vapid: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT },
    siteUrl: env.SITE_URL || 'https://habitcasino-5d08b.firebaseapp.com/',
  };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const report = await tick(config(env));
        if (report.checked) console.log('tick', JSON.stringify(report));
      } catch (e) {
        console.log('tick failed:', (e && e.stack) || e);
      }
    })());
  },

  /* Two endpoints, both gated on a secret, both for standing next to your phone and
     finding out what is actually happening:
       /health        — is the worker alive and can it reach Firestore
       /test?uid=...  — send a notification to that user's devices right now  */
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response('habit casino push worker\n');
    if (!env.RUN_KEY || url.searchParams.get('key') !== env.RUN_KEY) {
      return new Response('nope\n', { status: 403 });
    }
    const cfg = config(env);
    try {
      if (url.pathname === '/health') {
        const rows = await dueQueues(cfg.sa, cfg.sa.project_id, Date.now() + 365 * 86400000);
        return Response.json({ ok: true, queues: rows.length,
          devices: rows.map(r => ({ uid: r.uid, subs: (r.data.subs || []).length, items: (r.data.items || []).length })) });
      }
      if (url.pathname === '/run') return Response.json(await tick(cfg));
      if (url.pathname === '/test') {
        const uid = url.searchParams.get('uid');
        const rows = await dueQueues(cfg.sa, cfg.sa.project_id, Date.now() + 365 * 86400000);
        const row = rows.find(r => !uid || r.uid === uid);
        if (!row) return Response.json({ ok: false, why: 'no push queue for that user yet' }, { status: 404 });
        const out = [];
        for (const sub of row.data.subs || []) {
          const res = await sendPush(sub, JSON.stringify({
            web_push: 8030,
            notification: { title: '⚡ Habit Casino', body: 'Test push — notifications are working.',
                            lang: 'en-US', dir: 'auto', tag: 'test', navigate: cfg.siteUrl },
          }), cfg.vapid, { ttl: 60 });
          out.push({ endpoint: sub.endpoint.slice(0, 60) + '…', status: res.status, error: res.text.slice(0, 200) });
        }
        return Response.json({ ok: true, uid: row.uid, results: out });
      }
    } catch (e) {
      return Response.json({ ok: false, error: (e && e.message) || String(e) }, { status: 500 });
    }
    return new Response('not found\n', { status: 404 });
  },
};
