// Bump this with every deploy. It busts the cache below AND should match the
// ?v= query string on style.css/app.js/manifest.json in index.html, so
// browsers (and this service worker) always pick up the new files.
const VERSION = 'v23';
const CACHE_NAME = `sl5x5-cache-${VERSION}`;

const PRECACHE_ASSETS = [
  './',
  './index.html',
  `./style.css?v=${VERSION}`,
  `./app.js?v=${VERSION}`,
  `./manifest.json?v=${VERSION}`,
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Network-first for everything: always try to fetch the latest version, and
// only fall back to the cache when offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
