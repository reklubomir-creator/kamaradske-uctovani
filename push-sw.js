self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  if (!event.data) return;
  let message;
  try { message = event.data.json(); }
  catch { return; }
  if (!message || typeof message.title !== 'string' || typeof message.body !== 'string') return;
  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body,
    icon: './app-icon.png',
    data: { groupId: typeof message.groupId === 'string' && /^[\w-]{1,80}$/.test(message.groupId) ? message.groupId : '' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(self.registration.scope);
  const groupId = event.notification.data?.groupId;
  if (groupId) {
    target.searchParams.set('_activeGroup', groupId);
    target.searchParams.set('_push', '1');
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = windows.find(client => client.url.startsWith(self.registration.scope));
    if (app) {
      const current = new URL(app.url);
      // Keep an already-open form intact and let the app refresh its active group.
      if (current.searchParams.get('_activeGroup') === groupId) {
        app.postMessage({ type: 'shared-expense-push', groupId });
        return app.focus();
      }
      return app.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});
