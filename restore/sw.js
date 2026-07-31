/* Service worker — the app has to open in a basement with no signal.
 *
 * Strategy: precache the whole shell on install (it is small and fully
 * static), serve navigations network-first so a deploy is picked up when
 * there is signal, and serve everything else cache-first for speed. Job data
 * never touches the cache — it lives in IndexedDB. */

const VERSION = 'restoremap-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './css/app.css',
  './js/app.js',
  './js/util.js',
  './js/db.js',
  './js/store.js',
  './js/geom.js',
  './js/psychro.js',
  './js/iicrc.js',
  './js/sketch.js',
  './js/views/jobs.js',
  './js/views/plan.js',
  './js/views/readings.js',
  './js/views/equipment.js',
  './js/views/daily.js',
  './js/views/money.js',
  './js/views/settings.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // addAll rejects the whole install if any single file 404s; add
      // individually so one bad path cannot leave the app uncached.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      });
    }),
  );
});
