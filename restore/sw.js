// Offline shell. Techs work in basements and crawlspaces with no signal, so the
// app has to load from cache and never depend on the network.

const CACHE = 'dryplan-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './css/app.css',
  './js/app.js',
  './js/util.js',
  './js/ui.js',
  './js/store.js',
  './js/idb.js',
  './js/psychro.js',
  './js/standards.js',
  './js/equipment.js',
  './js/derive.js',
  './js/sketch.js',
  './js/screens/jobs.js',
  './js/screens/overview.js',
  './js/screens/plan.js',
  './js/screens/moisture.js',
  './js/screens/atmo.js',
  './js/screens/equipment.js',
  './js/screens/daily.js',
  './js/screens/contacts.js',
  './js/screens/drive.js',
  './js/screens/estimate.js',
  './js/screens/costs.js',
  './js/screens/report.js',
  './js/screens/settings.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Cache first for app files, network fallback — the app owns its own data, so
// there is nothing dynamic to keep fresh.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('./index.html'))),
  );
});
