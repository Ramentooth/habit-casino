/* sw.js is the half of web push that runs on the phone. It can't be exercised in a
   browser here, so it's loaded into a stand-in ServiceWorkerGlobalScope and its
   handlers are fired by hand — the same events iOS 16.4–18.3 will deliver.
   (On iOS 18.4+ the system shows the notification itself and none of this runs.) */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};

function loadSW() {
  const handlers = {}, shown = [], opened = [], focused = [], posted = [];
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => {},
    registration: { showNotification: (title, opts) => { shown.push({ title, opts }); return Promise.resolve(); } },
    clients: {
      _windows: [],
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(self.clients._windows),
      openWindow: url => { opened.push(url); return Promise.resolve(); },
    },
  };
  const ctx = vm.createContext({ self, console });
  ctx.globalThis = ctx;
  vm.runInContext(readFileSync(new URL('../../sw.js', import.meta.url), 'utf8'), ctx);
  const fire = async (type, event) => {
    let held = null;
    const ev = { ...event, waitUntil: p => { held = p; } };
    handlers[type](ev);
    if (held) await held;
  };
  return { self, handlers, shown, opened, focused, posted, fire };
}

console.log('\nA declarative payload arriving on iOS 16.4–18.3');
{
  const sw = loadSW();
  await sw.fire('push', { data: { json: () => ({
    web_push: 8030,
    notification: { title: '⌛ Movie night', body: 'Your 30m is up.', tag: 'rw-1',
                    navigate: 'https://habitcasino-5d08b.firebaseapp.com/' },
  }) } });
  ok('one notification is shown', sw.shown.length === 1);
  ok('title comes from the payload', sw.shown[0].title === '⌛ Movie night');
  ok('body comes from the payload', sw.shown[0].opts.body === 'Your 30m is up.');
  ok('tag is carried through, so a repeat replaces the old one', sw.shown[0].opts.tag === 'rw-1');
  ok('renotify is set, so a replacement still buzzes', sw.shown[0].opts.renotify === true);
  ok('the icon is the app icon', sw.shown[0].opts.icon === '/icon-192.png');
  ok('the tap target is stashed on the notification', sw.shown[0].opts.data.url === 'https://habitcasino-5d08b.firebaseapp.com/');
}

console.log('\nPayloads that are not the expected shape');
{
  const sw = loadSW();
  await sw.fire('push', { data: { json: () => ({ title: 'Bare', body: 'no envelope' }) } });
  ok('a bare notification object still shows', sw.shown[0].title === 'Bare' && sw.shown[0].opts.body === 'no envelope');

  const sw2 = loadSW();
  await sw2.fire('push', { data: { json: () => { throw new SyntaxError('not json'); }, text: () => 'plain words' } });
  ok('non-JSON falls back to the raw text', sw2.shown[0].opts.body === 'plain words');

  const sw3 = loadSW();
  await sw3.fire('push', {});
  ok('an empty push still shows something rather than nothing', sw3.shown.length === 1 && sw3.shown[0].title === 'Habit Casino');
}

console.log('\nTapping the notification');
{
  const sw = loadSW();
  let closed = false, focusedOne = false;
  sw.self.clients._windows = [{ focus: () => { focusedOne = true; return Promise.resolve(); } }];
  await sw.fire('notificationclick', {
    notification: { close: () => { closed = true; }, data: { url: 'https://example.test/' } },
  });
  ok('the notification is dismissed', closed);
  ok('an open window is focused rather than duplicated', focusedOne && sw.opened.length === 0);

  const sw2 = loadSW();
  await sw2.fire('notificationclick', {
    notification: { close: () => {}, data: { url: 'https://example.test/' } },
  });
  ok('with nothing open, the app is opened at the payload url', sw2.opened[0] === 'https://example.test/');
}

console.log('\nAn endpoint rotated by the push service');
{
  const sw = loadSW();
  const msgs = [];
  sw.self.clients._windows = [{ postMessage: m => msgs.push(m) }];
  await sw.fire('pushsubscriptionchange', {});
  ok('the page is told to re-subscribe', msgs[0] && msgs[0].type === 'pushsubscriptionchange');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
