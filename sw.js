// ScanDeals – Service Worker
// Strategien:
//   App-Shell (index.html, styles.css, js/*, manifest, Icons): cache-first mit Hintergrund-Update
//   Navigationen (offline): gecachte index.html
//   Open Food Facts / Open Prices (*.openfoodfacts.org): network-first, Fallback Cache
//   alles andere (z. B. CDN-Module, TF-Modellgewichte): stale-while-revalidate
//   *.workers.dev (KI-Server) und alle Nicht-GET-Requests: nie gecacht, direkt ans Netz

const CACHE = 'scandeals-v5';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/api.js',
  './js/scanner.js',
  './js/motion.js',
  './js/sheet.js',
  './js/splash.js',
  './js/config.js',
  './js/vision.js',
  './js/overlay.js',
  './js/ki.js',
  './manifest.webmanifest',
  './icons/logo.svg',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

const SHELL_URLS = new Set(SHELL.map((p) => new URL(p, self.location.href).href));
const API_HOST = /(^|\.)openfoodfacts\.org$/;
const WORKER_HOST = 'workers.dev';

function stripSearch(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Einzeln hinzufügen, damit ein fehlendes Asset die übrige Shell nicht blockiert
    await Promise.all(SHELL.map(async (path) => {
      try {
        await cache.add(path);
      } catch (err) {
        // Fehler ignorieren – das Asset wird beim nächsten Aufruf nachgeladen
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function shellResponse(event) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  const key = stripSearch(req.url);
  const cached = await cache.match(key);

  const update = fetch(req).then(async (res) => {
    if (res.ok) await cache.put(key, res.clone());
    return res;
  });

  if (cached) {
    event.waitUntil(update.catch(() => {}));
    return cached;
  }

  try {
    return await update;
  } catch (err) {
    if (req.mode === 'navigate') {
      const index = await cache.match(new URL('./index.html', self.location.href).href);
      if (index) return index;
    }
    return Response.error();
  }
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return Response.error();
  }
}

async function staleWhileRevalidate(event) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);

  const network = fetch(req).then((res) => {
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
    return res;
  });

  if (cached) {
    event.waitUntil(network.catch(() => {}));
    return cached;
  }

  try {
    return await network;
  } catch (err) {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Nur GET wird behandelt; POST & Co. gehen unverändert ans Netz
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // KI-Server (Cloudflare Workers): nie cachen, direkt durchreichen
  if (url.hostname.includes(WORKER_HOST)) return;

  // App-Shell und Navigationen auf eigener Origin
  if (url.origin === self.location.origin &&
      (req.mode === 'navigate' || SHELL_URLS.has(stripSearch(req.url)))) {
    event.respondWith(shellResponse(event));
    return;
  }

  // Open Food Facts / Open Prices: network-first
  if (API_HOST.test(url.hostname)) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Externe Seitennavigationen (z. B. Google Maps, Shops) nicht abfangen
  if (req.mode === 'navigate') return;

  // Alles andere (CDN etc.): stale-while-revalidate
  event.respondWith(staleWhileRevalidate(event));
});
