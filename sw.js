// Guarda la app (no los datos) para que abra rápido. Los datos siempre se piden a la nube.
const CACHE = 'honor-equipos-nube-v1';
const FILES = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png', './favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return; // datos: siempre en línea
  const propio = url.origin === location.origin;
  const fuentes = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!propio && !fuentes) return;
  const key = req.mode === 'navigate' ? './' : req;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key, { ignoreSearch: true });
    const red = fetch(req).then(r => { if (r.ok || r.type === 'opaque') cache.put(key, r.clone()); return r; }).catch(() => null);
    if (cached){ e.waitUntil(red); return cached; }
    return (await red) || new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
