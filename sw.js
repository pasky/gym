'use strict';
// Service worker: network-first for the app's own files.
//  - Online: every file is revalidated with the server (cheap 304s), so a new version shows up on the
//    next load instead of after GitHub Pages' 10-minute browser cache.
//  - Offline: the last copy is served, so the app also opens at the gym without signal.
// Only same-origin GETs are handled; GitHub API calls (sync) never touch this.
const CACHE = 'gym-app';
const key = url => { const u = new URL(url); return u.origin + u.pathname; };   // ignore ?v=… cache busters

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
      if (res.ok) (await caches.open(CACHE)).put(key(req.url), res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(key(req.url));
      if (hit) return hit;
      throw err;
    }
  })());
});
