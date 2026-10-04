/* ===== JumpCam: offline support =====
   Two caches:
   - APP_CACHE: this app's own files. Change APP_VERSION after editing any file.
   - LIB_CACHE: the MediaPipe library, WASM files, and pose model (about 20 MB).
     Kept separate so app updates don't re-download it. Its name includes the
     MediaPipe version; change it if you change MP_VERSION in app.js. */
const APP_VERSION = 'v1';
const APP_CACHE = 'jumpcam-app-' + APP_VERSION;
const LIB_CACHE = 'jumpcam-lib-1.0.1';

const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-512.png'
];

// Files from these hosts are the AI library and model
const LIB_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== APP_CACHE && k !== LIB_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // AI library and model: use the saved copy; download and save it the first time.
  if (LIB_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(LIB_CACHE).then(async cache => {
        const saved = await cache.match(req);
        if (saved) return saved;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // This app's own files: saved copy first, network as a backup.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(saved => {
        if (saved) return saved;
        return fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
      })
    );
  }
});
