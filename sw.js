// A minimal service worker for the PWA/app wrapper.
//
// IMPORTANT: this deliberately does NOT cache data/weather.json,
// data/history.json, or data/camera.jpg — those must always be fetched
// fresh so the app shows live conditions, not a stale cached snapshot.
// It only caches the app "shell" (the page itself, styles, icons) so the
// app opens instantly and still loads its frame if the network is briefly
// unavailable. Version 3: Added background sync support.

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
    url.hostname.includes('spc.noaa.gov') ||
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

// Background Sync: periodically fetch fresh weather data when the app is running in background
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-weather-data') {
    event.waitUntil(syncWeatherData());
  }
});

async function syncWeatherData() {
  try {
    // Fetch all three data files fresh from the network
    const [weatherRes, historyRes, cameraRes] = await Promise.allSettled([
      fetch('./data/weather.json?t=' + Date.now()),
      fetch('./data/history.json?t=' + Date.now()),
      fetch('./data/camera.jpg?t=' + Date.now()),
    ]);

    // Notify all clients that new data is available (they can refresh if desired)
    const clients = await self.clients.matchAll();
    if (clients.length > 0) {
      const dataUpdate = {
        type: 'background-sync-complete',
        timestamp: new Date().toISOString(),
        weatherAvailable: weatherRes.status === 'fulfilled' && weatherRes.value.ok,
        historyAvailable: historyRes.status === 'fulfilled' && historyRes.value.ok,
        cameraAvailable: cameraRes.status === 'fulfilled' && cameraRes.value.ok,
      };
      clients.forEach((client) => {
        client.postMessage(dataUpdate);
      });
    }
  } catch (err) {
    console.error('Background sync failed:', err);
  }
}

// Request a background sync every time the page loads or becomes visible
// (browser may retry this periodically if connectivity is lost)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SCHEDULE_SYNC') {
    if ('sync' in self.registration) {
      self.registration.sync.register('sync-weather-data').catch((err) => {
        console.warn('Failed to register background sync:', err);
      });
    }
  }
});
