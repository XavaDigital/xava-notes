// Service worker: cache the app shell for offline use and fast loads.
// Note data is cached separately in IndexedDB by the app.

const CACHE = 'xava-notes-v23';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/config.js',
  './js/auth.js',
  './js/drive.js',
  './js/store.js',
  './js/note.js',
  './js/frontmatter.js',
  './js/markdown.js',
  './js/import.js',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never touch Google API / auth traffic.
  if (url.origin !== self.location.origin) return;

  // Network-first for everything same-origin: always get the latest code when
  // online (prevents stale-asset mismatches), fall back to cache when offline.
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached || caches.match('./index.html'))
      )
  );
});
