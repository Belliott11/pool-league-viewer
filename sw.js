// Offline support for the dashboard and the viewer. Network first, so a new version shows up as
// soon as there's a connection; when there isn't, the last copy this phone saw is used instead.
// Caches this site's own files plus Google Fonts. Never videos: they're huge, and they're
// fetched in byte ranges that don't cache cleanly.
const CACHE = "poolean-offline-v1";
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(["./", "./index.html"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// The page sends the files it already loaded before this worker took over, so the very first
// visit is enough to work offline afterward.
self.addEventListener("message", event => {
  const urls = (event.data && event.data.cacheUrls) || [];
  event.waitUntil(caches.open(CACHE).then(c => Promise.all(urls.map(u => c.add(u).catch(() => {})))));
});

function cacheable(request) {
  if (request.method !== "GET" || request.headers.has("range")) return false;
  const url = new URL(request.url);
  if (/\.(mp4|mov|webm|m4v)$/i.test(url.pathname)) return false;
  return url.origin === self.location.origin || FONT_HOSTS.includes(url.hostname);
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (!cacheable(request)) return;
  event.respondWith(
    fetch(request).then(response => {
      if (response.ok || response.type === "opaque") {
        const copy = response.clone();
        caches.open(CACHE).then(c => c.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request, { ignoreSearch: true })
      .then(hit => hit || (request.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});
