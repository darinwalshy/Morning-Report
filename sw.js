// ==========================================
// 🛠️ UNIQUE IDENTIFIERS FOR THIS APP
// ==========================================
const BASE_PREFIX = 'morning_report_v1'; 
const APP_PREFIX = `${BASE_PREFIX}1_00_`; // Initial version setup
const CACHE_NAME = APP_PREFIX + 'cache';

// Exact GitHub repository name matching your URL path
const REPO_NAME = '/Morning-Report';      

const ASSETS = [
  `${REPO_NAME}/`,
  `${REPO_NAME}/index.html`,
  `${REPO_NAME}/manifest.json`
];

// Install event: Pre-caches core app files
self.addEventListener('install', (event) => {
  self.skipWaiting(); 
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

// Activate event: Purges older versions of the Morning Report cache
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key.startsWith(BASE_PREFIX) && key !== CACHE_NAME) {
            console.log(`[Service Worker] Cleared old app cache: ${key}`);
            return caches.delete(key);
          }
        })
      );
    })
  );
});

// Fetch event: Network-first falling back to cache
self.addEventListener('fetch', (event) => {
  const requestUrl = event.request.url;

  // Intercept GET requests scoped strictly to this repository path
  if (event.request.method === 'GET' && requestUrl.includes(self.location.origin) && requestUrl.includes(REPO_NAME)) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(event.request).then((response) => {
          return response || caches.match(`${REPO_NAME}/index.html`);
        });
      })
    );
  }
});
