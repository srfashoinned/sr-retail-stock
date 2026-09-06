const CACHE_NAME = "sr-receivables-v40";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css?v=39",
  "/app.js?v=39",
  "/cache-data.json",
  "/sr-fashion-logo.png",
  "/site.webmanifest",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
  "/mstile-150x150.png"
];

async function seedCache() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(APP_SHELL.map(async url => {
    try {
      await cache.add(url);
    } catch (_) {}
  }));
}

self.addEventListener("install", event => {
  event.waitUntil(seedCache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (_) {
    return (await cache.match(request)) || cache.match("/index.html") || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  if (event.request.mode === "navigate" || url.pathname.startsWith("/api/") || url.pathname === "/cache-data.json") {
    event.respondWith(networkFirst(event.request));
    return;
  }
  event.respondWith(cacheFirst(event.request));
});
