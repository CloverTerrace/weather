// Clover Terrace Weather — service worker
// Version 9: full 4-page shell + genuinely-bypassed network-first fetch
//
// HTML, CSS and JS use NETWORK-FIRST so GitHub Pages updates are picked up
// promptly. Cached copies remain available as an offline fallback.
// Live data files are NEVER cached by this worker.
//
// NOTE: bump this CACHE_NAME (and the matching ?v= on every local css/js
// reference in each page's <head>/<body>) together, every time any shell
// file changes. Bumping this alone forces old caches to be deleted on
// activate; bumping the ?v= alone forces a fresh fetch even when a
// network-first fetch would otherwise be satisfied by the browser's own
// (non-Cache-Storage) HTTP cache -- see the explicit {cache:'reload'}
// below for why that HTTP-cache layer needed its own fix too.

const CACHE_NAME = 'weather-app-shell-v9';

const SHELL_FILES = [
  './index.html',
  './gardening.html',
  './atmosphere.html',
  './space.html',
  './manifest.json',

  './icons/icon-192.png',
  './icons/icon-512.png',

  './chart.umd.min.js',
  './suncalc.js',

  './css/site.css',
  './css/navigation.css',
  './css/gardening.css',
  './css/atmosphere.css',
  './css/space.css',

  './js/navigation.js',
  './js/site.js',
  './js/gardening.js',
  './js/garden-sprites.js',
  './js/atmosphere.js',
  './js/space.js',
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
  const request = event.request;
  const url = new URL(request.url);

  // ---------------------------------------------------------------
  // NEVER CACHE LIVE WEATHER DATA
  // ---------------------------------------------------------------

  if (
    url.pathname.includes('/data/') ||
    url.hostname.includes('spc.noaa.gov') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('counterapi.dev')
  ) {
    return;
  }

  // ---------------------------------------------------------------
  // HTML — NETWORK FIRST
  // ---------------------------------------------------------------

  if (request.mode === 'navigate') {
    event.respondWith(
      // {cache:'reload'} matters here: without it, "network first" can
      // silently be satisfied by the browser's own HTTP cache (GitHub
      // Pages sends Cache-Control headers) instead of actually going to
      // the network, which defeats the point of this whole branch.
      fetch(request, { cache: 'reload' })
        .then((response) => {
          const copy = response.clone();

          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, copy);
          });

          return response;
        })
        .catch(() =>
          caches.match(request).then(
            (cached) => cached || caches.match('./index.html')
          )
        )
    );

    return;
  }

  // ---------------------------------------------------------------
  // CSS + JS — NETWORK FIRST
  //
  // This is the important fix for the Garden theme.
  // GitHub gets a chance to provide the newest CSS/JS every time.
  // If the network is unavailable, the cached version is used.
  // ---------------------------------------------------------------

  const isCSS =
    request.destination === 'style' ||
    url.pathname.endsWith('.css');

  const isJS =
    request.destination === 'script' ||
    url.pathname.endsWith('.js');

  if (isCSS || isJS) {
    event.respondWith(
      // same {cache:'reload'} fix as the HTML branch above.
      fetch(request, { cache: 'reload' })
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();

            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, copy);
            });
          }

          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => {
            if (cached) return cached;
            return fetch(request);
          })
        )
    );

    return;
  }

  // ---------------------------------------------------------------
  // OTHER STATIC ASSETS — CACHE FIRST
  // ---------------------------------------------------------------

  event.respondWith(
    caches.match(request).then(
      (cached) => cached || fetch(request)
    )
  );
});

// ---------------------------------------------------------------
// BACKGROUND WEATHER SYNC
// ---------------------------------------------------------------

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-weather-data') {
    event.waitUntil(syncWeatherData());
  }
});

async function syncWeatherData() {
  try {
    const [weatherRes, historyRes, cameraRes] =
      await Promise.allSettled([
        fetch('./data/weather.json?t=' + Date.now()),
        fetch('./data/history.json?t=' + Date.now()),
        fetch('./data/camera.jpg?t=' + Date.now()),
      ]);

    const clients = await self.clients.matchAll();

    if (clients.length > 0) {
      const dataUpdate = {
        type: 'background-sync-complete',
        timestamp: new Date().toISOString(),

        weatherAvailable:
          weatherRes.status === 'fulfilled' &&
          weatherRes.value.ok,

        historyAvailable:
          historyRes.status === 'fulfilled' &&
          historyRes.value.ok,

        cameraAvailable:
          cameraRes.status === 'fulfilled' &&
          cameraRes.value.ok,
      };

      clients.forEach((client) => {
        client.postMessage(dataUpdate);
      });
    }
  } catch (err) {
    console.error('Background sync failed:', err);
  }
}

// ---------------------------------------------------------------
// REQUEST BACKGROUND SYNC
// ---------------------------------------------------------------

self.addEventListener('message', (event) => {
  if (
    event.data &&
    event.data.type === 'SCHEDULE_SYNC'
  ) {
    if ('sync' in self.registration) {
      self.registration.sync
        .register('sync-weather-data')
        .catch((err) => {
          console.warn(
            'Failed to register background sync:',
            err
          );
        });
    }
  }
});
