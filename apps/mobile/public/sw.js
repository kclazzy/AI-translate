/* AI Translate service worker: offline app shell + Android share target. */
self.__PRECACHE__ = [];
const CACHE = 'ait-__VERSION__';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(self.__PRECACHE__)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ait-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

function idbPut(key, value) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ai-translate', 1);
    req.onupgradeneeded = () => {
      for (const s of ['results', 'history', 'projects', 'assets', 'contexts', 'kv', 'usage']) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    // Files shared from the gallery/browser: keep them for the page, then open the app.
    event.respondWith(
      (async () => {
        const form = await event.request.formData();
        const files = [];
        for (const f of form.getAll('files')) if (f instanceof File) files.push({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
        await idbPut('shared-files', files);
        return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
      })(),
    );
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ||
        fetch(event.request).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        }),
    ),
  );
});
