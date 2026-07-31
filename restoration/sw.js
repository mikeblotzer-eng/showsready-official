/**
 * Service worker.
 *
 * The app has to open in a basement with no bars, so the shell is precached
 * and served cache-first. Bump CACHE when shipping — the old cache is dropped
 * on activate and clients are claimed immediately.
 */

const CACHE = 'dryline-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './icons/icon.svg',
  './js/app.js',
  './js/store.js',
  './js/ui.js',
  './js/util.js',
  './js/psychro.js',
  './js/iicrc.js',
  './js/sketch.js',
  './js/estimate.js',
  './js/jobcalc.js',
  './js/drive.js',
  './js/views/jobs.js',
  './js/views/job.js',
  './js/views/plan.js',
  './js/views/readings.js',
  './js/views/equipment.js',
  './js/views/field.js',
  './js/views/money.js',
  './js/views/report.js',
  './js/views/settings.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll fails the whole install if any single request 404s; add
    // individually so a missing optional asset cannot brick the install.
    await Promise.all(SHELL.map((url) => cache.add(url).catch((err) => {
      console.warn('[sw] could not cache', url, err);
    })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let sync calls go straight to the network

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) {
      // Refresh in the background so the next launch is current.
      event.waitUntil(refresh(request));
      return cached;
    }
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch (err) {
      // A navigation with no cache entry still needs to land somewhere.
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

async function refresh(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(request, response);
    }
  } catch {
    // Offline is the normal case here, not an error worth reporting.
  }
}
