/* Service Worker: アプリ本体と問題データをキャッシュし、オフラインでも動くようにする。
   questions.json はネットワーク優先（問題の更新を取り込みやすく）、それ以外はキャッシュ優先。 */
const CACHE_NAME = "study-app-v5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  if (url.pathname.endsWith("questions.json")) {
    // 問題データはネットワーク優先、失敗したらキャッシュ
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // それ以外はキャッシュ優先
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
