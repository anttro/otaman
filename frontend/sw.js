const CACHE = 'otaman-v13';
const URLS = [
  'index.html',
  'help.html',
  'help-ru.html',
  'style.css',
  'sim.png',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'manifest.json',
  'des-bundle.js',
  'aes-bundle.js',
  'sim.svg',
  'sim_anim.svg',
  'nosim.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith('http')) return;
  if (new URL(e.request.url).pathname.startsWith('/api/')) return;  // live data, never cache
  if (e.request.method !== 'GET') return;
  const isNavigate = e.request.mode === 'navigate' || e.request.url.endsWith('sw.js');
  if (isNavigate) {
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }))
    );
  }
});