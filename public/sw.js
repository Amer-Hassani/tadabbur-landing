// Tadabbur service worker — minimal app-shell caching.
// Bump CACHE_VERSION whenever caching behavior changes so old caches are dropped.
const CACHE_VERSION = 'tadabbur-v1';
const HTML_CACHE = `${CACHE_VERSION}-html`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;

const APP_SHELL_URLS = ['/', '/manifest.webmanifest', '/favicon.svg'];

// Never let the service worker touch the tafsir API — search must always
// hit the network live, and caching it could serve stale/incorrect verses.
function isApiRequest(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.hostname.endsWith('workers.dev') ||
    url.hostname.includes('tadabbur-tafsir-api')
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(HTML_CACHE);
        await cache.addAll(APP_SHELL_URLS);
      } catch (err) {
        // Non-fatal: shell will just be cached lazily on first fetch instead.
      }
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => key.startsWith('tadabbur-') && !key.startsWith(CACHE_VERSION))
            .map((key) => caches.delete(key))
        );
      } catch (err) {
        // Ignore — worst case, an old cache lingers until next activate.
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle same-origin requests, and never intercept API calls.
  if (url.origin !== self.location.origin || isApiRequest(url)) {
    return;
  }

  const isHTML =
    request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html');

  if (isHTML) {
    // Network-first for documents: fresh content when online, cached shell offline.
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          try {
            const cache = await caches.open(HTML_CACHE);
            cache.put(request, response.clone());
          } catch (err) {}
          return response;
        } catch (err) {
          const cached = await caches.match(request);
          return cached || caches.match('/');
        }
      })()
    );
    return;
  }

  // Cache-first for static assets (fingerprinted CSS/JS, fonts, images).
  // Astro hashes filenames per build, so we populate this cache dynamically
  // as assets are requested rather than hardcoding names.
  event.respondWith(
    (async () => {
      try {
        const cached = await caches.match(request);
        if (cached) return cached;

        const response = await fetch(request);
        try {
          if (response && response.ok) {
            const cache = await caches.open(ASSET_CACHE);
            cache.put(request, response.clone());
          }
        } catch (err) {}
        return response;
      } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw err;
      }
    })()
  );
});
