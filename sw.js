/* ===== Sprout & Paw: offline support =====
   Saves the app files on the phone so it opens without internet.
   (Your photos are stored separately and are never affected by this.)
   IMPORTANT: after editing any file, change the version below (v1 -> v2)
   so phones download the new files. */
const CACHE = 'sprout-paw-v3';

const FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './photo.js',
  './manifest.json',
  './icon.svg',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true })
      .then(saved => saved || fetch(e.request))
  );
});
