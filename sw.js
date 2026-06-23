// Service worker: cache the app shell for offline use and fast loads.
// Note data is cached separately in IndexedDB by the app.

const CACHE = 'xava-notes-v53';
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

// Receive shared files/text from the Android share sheet (Web Share Target,
// POST). Stash everything in a cache and redirect into the app with ?shared=1.
async function handleShareTarget(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open('xn-shared');
    const meta = {
      title: form.get('title') || '',
      text: form.get('text') || '',
      url: form.get('url') || '',
      files: [],
    };
    let i = 0;
    for (const f of form.getAll('files')) {
      if (!f || typeof f === 'string') continue;
      const key = `./shared-file-${i}`;
      await cache.put(new Request(key), new Response(f, {
        headers: { 'Content-Type': f.type || 'application/octet-stream' },
      }));
      meta.files.push({ key, name: f.name || `file-${i}`, type: f.type || 'application/octet-stream' });
      i++;
    }
    await cache.put(new Request('./shared-meta'), new Response(JSON.stringify(meta), {
      headers: { 'Content-Type': 'application/json' },
    }));
  } catch (e) { /* ignore; still redirect */ }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShareTarget(request));
    return;
  }
  if (request.method !== 'GET') return;

  // Never touch Google API / auth traffic.
  if (url.origin !== self.location.origin) return;

  // Network-first for everything same-origin: always get the latest code when
  // online (prevents stale-asset mismatches), fall back to cache when offline.
  // `cache: 'no-cache'` forces revalidation so the browser's HTTP cache can't
  // serve a stale asset after a deploy.
  event.respondWith(
    fetch(request, { cache: 'no-cache' })
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
