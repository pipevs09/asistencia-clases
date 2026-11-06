const CACHE_NAME = 'asistencia-shell-v118';
const TRANSPARENT_NOTIFICATION_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css?v=110',
  '/app.js?v=117',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/notification-badge.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request, { cache: 'no-store' })
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('/index.html');
        return Response.error();
      })
  );
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  event.waitUntil(self.registration.showNotification(data.title || 'Registro de Asistencia', {
    body: data.body || 'Tienes una actividad próxima.',
    icon: TRANSPARENT_NOTIFICATION_ICON,
    badge: '/notification-badge.png',
    tag: data.tag || 'asistencia-recordatorio',
    data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    for (const client of clients) {
      if ('navigate' in client) await client.navigate(target);
      return client.focus();
    }
    return self.clients.openWindow(target);
  }));
});
