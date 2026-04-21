// BasicUniformPOS Service Worker — offline resilience (v3).
// R33-H3: bumped CACHE_NAME to v3 so the `activate` cleanup deletes
// the v2 cache (which may have auth-page HTML baked in by prior
// `cache.addAll(SHELL_URLS)` calls that happened while the first
// user was logged in — R31-M3 stopped NEW caching but couldn't
// evict existing entries). The fetch handler already skips auth
// pages (R31-M3), so there's nothing left to pre-cache: drop the
// SHELL_URLS list entirely and install as a pure bookkeeping step.
const CACHE_NAME = "basicuniformpos-v3";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME));
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

  // Navigation requests — network-first, fallback to cache.
  // R31-M3: DO NOT cache authenticated pages. /admin/* and /register/*
  // RSC payloads embed per-user / per-org data inline (customer lists,
  // transaction totals, employee info). Caching them means a shared
  // POS tablet can serve user A's rendered HTML to user B after A
  // logs out + B logs in + network drops. Cache ONLY the public shell
  // (/, /login, /signup) so the PWA still has offline-first UX for
  // the entry surfaces.
  if (request.mode === "navigate") {
    const url = new URL(request.url);
    const isAuthenticatedPage =
      url.pathname.startsWith("/admin") ||
      url.pathname.startsWith("/register") ||
      url.pathname.startsWith("/pos") ||
      url.pathname.startsWith("/dashboard") ||
      url.pathname.startsWith("/customer-display");
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && !isAuthenticatedPage) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // On network failure, only serve from cache for non-
          // authenticated pages. For authenticated pages, return a
          // bare offline page — the user must reconnect + log in
          // again, not see a stale predecessor's data.
          if (isAuthenticatedPage) {
            return new Response(
              "<html><body style='font-family:sans-serif;padding:2em'><h1>Offline</h1><p>Reconnect and refresh to continue.</p></body></html>",
              { headers: { "Content-Type": "text/html" } },
            );
          }
          return caches.match(request).then((cached) => {
            if (cached) return cached;
            return caches.match("/");
          });
        })
    );
    return;
  }
});
