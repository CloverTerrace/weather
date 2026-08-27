// Clover Terrace Weather — service worker
//
// the service worker keeps the site usable offline, but HTML navigations
// prefer the network so GitHub Pages updates are not hidden behind an old
// cached index.html or gardening.html.
//
// live data is never cached.

const CACHE_NAME = 'weather-app-shell-v3';

const SHELL_FILES = [
  './index.html',
  './gardening.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './chart.umd.min.js',
  './suncalc.js',
  './css/site.css',
  './css/navigation.css',
  './css/gardening.css',
  './js/navigation.js',
  './js/gardening.js',
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

  // Never intercept live data or external API/CDN requests.
  if (
    url.pathname.includes('/data/') ||
    url.hostname.includes('spc.noaa.gov') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('counterapi.dev')
  ) {
    return;
  }

  // HTML/page navigation:
  // Network first, cached page only as an offline fallback.
  //
  // This prevents an old cached index.html from reappearing after
  // navigating between pages.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();

          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, copy);
          });

          return response;
        })
        .catch(() =>
          caches.match(request).then(
            (cached) =>
              cached ||
              caches.match('./index.html')
          )
        )
    );

    return;
  }

  // Static shell assets:
  // Cache first for fast loading, with the network as a fallback.
  event.respondWith(
    caches.match(request).then(
      (cached) => cached || fetch(request)
    )
  );
});

// Background sync: periodically fetch fresh weather data when the app is
// running in the background.
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
