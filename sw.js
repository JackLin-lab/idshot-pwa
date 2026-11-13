/* Service Worker：App 殼層預先快取；OCR 引擎／語言包於首次使用時快取 */
const VER = 'idshot-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'parse.js', 'docx-lite.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const CDN_HOSTS = ['cdn.jsdelivr.net', 'tessdata.projectnaptha.com', 'unpkg.com'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VER);
    await Promise.all(SHELL.map((u) => c.add(u).catch(() => {})));
    try { await c.add(TESS_URL); } catch (_) { /* 沒網路也沒關係，之後再快取 */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isCdn = CDN_HOSTS.includes(url.hostname);
  if (!sameOrigin && !isCdn) return;

  e.respondWith((async () => {
    const cache = await caches.open(VER);
    const hit = await cache.match(req, { ignoreSearch: sameOrigin });
    const fetchAndStore = fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    });
    if (hit) {
      // 殼層：先給快取，背景更新（下次開啟即為新版）；CDN 檔案不變動，直接用快取
      if (sameOrigin) fetchAndStore.catch(() => {});
      return hit;
    }
    try {
      return await fetchAndStore;
    } catch (err) {
      if (req.mode === 'navigate') {
        const fallback = await cache.match('index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
