/* =====================================================================
   HABIT CASINO — service worker.

   This exists for ONE reason: iOS only lets a web app receive push
   notifications if it has a service worker. It deliberately does NOT cache
   anything and has no fetch handler — the app is a single ~1 MB file that
   changes with every deploy, and a cache would serve yesterday's build.
   Registering this worker must never change what page you get.

   Two paths deliver the same JSON:
     · iOS 18.4+ — Declarative Web Push. The system reads the payload and shows
       the notification itself; the `push` handler below is never called.
     · iOS 16.4–18.3 and other browsers — the payload arrives here instead, and
       the handler pulls the same fields out of it.
   ===================================================================== */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  if (event.data) {
    try { data = event.data.json(); }
    catch { data = { notification: { title: 'Habit Casino', body: event.data.text() } }; }
  }
  // Accept both the declarative envelope and a bare notification object, so a payload
  // built either way still shows something rather than nothing.
  const n = data.notification || data;
  event.waitUntil(self.registration.showNotification(n.title || 'Habit Casino', {
    body: n.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: n.tag || undefined,
    // Same tag = replace the old one, and still buzz. A reminder for the same timer
    // shouldn't stack up three deep.
    renotify: !!n.tag,
    data: { url: n.navigate || '/' },
  }));
});

// Tapping the notification goes to the app — the window that's already open if there is
// one, so you land where you left off rather than on a fresh copy.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) { await client.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});

/* A subscription can be rotated by the push service. The page re-subscribes and re-uploads
   on every launch, so the practical fix is to make sure the next launch happens — but
   clearing the dead one here stops the old endpoint being reported as live. */
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach(c => c.postMessage({ type: 'pushsubscriptionchange' }));
  })());
});
