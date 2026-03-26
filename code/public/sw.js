// BasicUniformPOS Service Worker — offline resilience (v2)
const CACHE_NAME = "basicuniformpos-v2";
const SHELL_URLS = ["/register", "/admin"];

// Cache the app shell on install
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

// Clean old caches on activate
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first with cache fallback for navigation requests
// Cache-first for static assets
// Never cache API POST requests (let offline-sync handle those)
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Never cache the health endpoint — it must always hit the network for connectivity detection
  if (url.pathname === "/api/health") return;

  // Never cache API data endpoints — we want fresh data when online
  if (url.pathname.startsWith("/api/")) return;

  // Static assets (JS, CSS, images, fonts) — cache-first
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/file.") ||
    url.pathname.match(/\.(js|css|png|jpg|svg|woff2?|ico)$/)
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        }).catch(() => {
          // If fetch fails and no cache, return a basic offline response
          return new Response("", { status: 503 });
        });
      })
    );
    return;
  }

  // Navigation requests — network-first, fallback to cache
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(request).then((cached) => {
            if (cached) return cached;
            // Fall back to register page for any navigation
            return caches.match("/register");
          });
        })
    );
    return;
  }
});
