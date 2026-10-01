// Minimal service worker — its only real job is to make the app installable
// (Chrome/Edge require one). It also caches the static shell so the menu
// still opens if a friend's connection blips, but it never caches or
// interferes with the WebSocket game traffic.
const CACHE = "last-drop-shell-v40";
const SHELL = [
  "/",
  "/style.css",
  "/game.js",
  "/terrain.js",
  "/structures.js",
  "/weapons.js",
  "/avatar.js",
  "/logo.svg",
  "/dien.jpg",
  "/catgrenade.png",
  "/forest-map.png",
  "/desert-map.png",
  "/jungle-map.png",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Never touch WebSocket upgrades or non-GET requests.
  if (request.method !== "GET") return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches
          .open(CACHE)
          .then((cache) => cache.put(request, copy))
          .catch(() => {});
        return res;
      })
      .catch(() => caches.match(request)),
  );
});
