// MyPlanner 서비스워커 — 웹 푸시 전용.
//
// 일부러 캐시는 건드리지 않는다. 앱이 index.html 한 덩어리라
// 캐시를 잡으면 배포해도 옛 화면이 남는 문제가 생긴다.

const APP_URL = './index.html';

self.addEventListener('install', (event) => {
  // 새 버전을 바로 쓰게 한다 (기다렸다 바뀌면 알림이 옛 코드로 뜬다)
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 서버가 보낸 알림 표시
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    // JSON 이 아니면 본문을 그대로 쓴다
    data = { title: 'MyPlanner', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'MyPlanner';
  const options = {
    body: data.body || '',
    // 아이콘은 앱 아이콘과 같은 것을 쓴다 (manifest 의 SVG)
    icon: data.icon || './icon-192.png',
    badge: data.badge || './icon-192.png',
    tag: data.tag || 'myplanner',          // 같은 tag 면 덮어써서 알림이 쌓이지 않는다
    renotify: !!data.renotify,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || APP_URL, kind: data.kind || '' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// 알림을 탭하면 이미 열린 앱으로 가고, 없으면 새로 연다
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || APP_URL;

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      // 같은 출처의 창이 이미 있으면 그걸 앞으로
      if ('focus' in client) {
        try { await client.focus(); } catch (e) {}
        if ('navigate' in client && target) {
          try { await client.navigate(target); } catch (e) {}
        }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

// 구독이 만료돼 브라우저가 새로 발급하면 앱에 알려 다시 등록하게 한다
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) client.postMessage({ type: 'push-subscription-changed' });
  })());
});
