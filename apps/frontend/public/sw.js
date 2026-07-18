// Bumping this version forces every installed client to drop its old cache —
// including any previously cached API GET responses (see fetch handler notes
// below), which otherwise stay stale forever until a hard reload.
const CACHE_NAME = "portivox-shell-v2";
const CORE_ASSETS = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg", "/icons.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ).then(() => self.clients.claim()),
  );
});

// Only the immutable, content-hashed Vite build output belongs in a
// cache-first strategy — it never changes under a given filename.
function isImmutableStaticAsset(pathname) {
  return pathname.startsWith("/assets/");
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match("/index.html")) || Response.error();
        }),
    );
    return;
  }

  // Every other request — in particular every `/api/*` call (tunnels, keys,
  // devices, usage, admin, inspect, /l/, /r/, /healthz, /readyz, etc.) — is
  // dynamic and must always reach the network. Serving these from Cache
  // Storage is what caused deletes/updates to appear to "not take effect"
  // until a hard reload bypassed the service worker. Only intercept (and
  // cache-first) the content-hashed static build assets and the known shell
  // files; everything else is left alone so the browser fetches it normally.
  const isShellFile = CORE_ASSETS.includes(url.pathname);
  if (!isImmutableStaticAsset(url.pathname) && !isShellFile) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== "basic") {
          return response;
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    }),
  );
});
