/* Bildtransformer – Service Worker
   - hält die App offline verfügbar
   - setzt die Header für "Cross-Origin Isolation", damit die KI mehrere Prozessorkerne nutzen kann
   - nimmt Fotos aus dem Android-Teilen-Menü entgegen
   KI-Modelle (.onnx) verwaltet worker.js selbst im Cache "bt-models-v1". */
const VERSION = 'bt-app-v5';
const SHELL = [
  './', './index.html', './app.js', './worker.js', './model-host.js', './core.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
  './ort/ort.wasm.min.mjs', './ort/ort-wasm-simd-threaded.mjs', './ort/ort-wasm-simd-threaded.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('bt-app-') && k !== VERSION) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

function withIsolation(res) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function handleShare(request) {
  try {
    const form = await request.formData();
    const file = form.get('image');
    if (file && file.size) {
      const c = await caches.open('bt-share');
      await c.put(new URL('shared-image', self.registration.scope).href, new Response(file, {
        headers: { 'content-type': file.type || 'image/jpeg', 'x-name': encodeURIComponent(file.name || 'geteiltes-bild.jpg') },
      }));
    }
  } catch (err) { /* ignorieren */ }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share-target')) {
    e.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // fremde Server: Browser regelt das
  if (url.pathname.endsWith('.onnx')) return;                              // Modelle: worker.js cacht selbst

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (req.mode === 'navigate') {
      // Seite: erst Netz (für Updates), sonst Offline-Kopie
      try {
        const net = await fetch(req);
        if (net.ok) cache.put('./index.html', net.clone());
        return withIsolation(net);
      } catch (err) {
        return withIsolation(await cache.match('./index.html') || await cache.match('./'));
      }
    }
    // App-Dateien: sofort aus dem Cache, im Hintergrund aktualisieren
    const hit = await cache.match(req, { ignoreSearch: true });
    const refresh = fetch(req).then((net) => { if (net.ok) cache.put(req, net.clone()); return net; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return withIsolation(hit); }
    const net = await refresh;
    return withIsolation(net || new Response('offline', { status: 503 }));
  })());
});
