// A minimal service worker for the PWA/app wrapper.
//
// IMPORTANT: this deliberately does NOT cache data/weather.json,
// data/history.json, or data/camera.jpg — those must always be fetched
// fresh so the app shows live conditions, not a stale cached snapshot.
// It only caches the app "shell" (the page itself, styles, icons) so the
// app opens instantly and still loads its frame if the network is briefly
// unavailable. Version 2.

const CACHE_NAME = 'weather-app-shell-v1';
const SHELL_FILES = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept the live data files or the Chart.js CDN/API calls —
  // let those always go straight to the network.
  if (
    url.pathname.includes('/data/') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('counterapi.dev')
  ) {
    return;
  }

  // App shell files: try cache first, fall back to network.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
