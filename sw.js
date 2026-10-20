const CACHE = 'xianying-v6';
const ASSETS = [
  './', './index.html', './fx.js', './manifest.webmanifest',
  './vendor/gsap.min.js', './vendor/lenis.min.js', './vendor/lenis.css',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  // cache:'reload'：繞過瀏覽器的 HTTP 快取（GitHub Pages 會讓檔案快取 10 分鐘），確保裝進來的是新版
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 不碰 API

  // 換頁：網路優先（更新才進得來），離線退回快取
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put('./index.html', copy));
        return r;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 其他同源資源：先回快取（快、離線可用），同時背景更新，下次就是新的
  e.respondWith(
    caches.open(CACHE).then(c =>
      c.match(req).then(hit => {
        const net = fetch(req).then(r => { if (r && r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
        return hit || net;
      })
    )
  );
});

// 頁面在今天的時刻到來時呼叫
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'moment') {
    self.registration.showNotification('現在。', {
      body: '有兩分鐘。拍下你現在看到的。',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'moment-' + (d.day || ''),
      renotify: false,
      requireInteraction: false,
      data: { url: './' }
    });
  }
});

// 之後若加伺服器推播，這裡已經接好
self.addEventListener('push', e => {
  let p = { title: '現在。', body: '有兩分鐘。拍下你現在看到的。' };
  try { if (e.data) p = Object.assign(p, e.data.json()); } catch (_) {}
  e.waitUntil(self.registration.showNotification(p.title, {
    body: p.body, icon: './icon-192.png', badge: './icon-192.png',
    tag: 'moment-push', data: { url: './' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    if (clients.openWindow) return clients.openWindow('./');
  }));
});
