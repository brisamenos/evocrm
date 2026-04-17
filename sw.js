// EvoCRM — Service Worker
// Mantém notificações funcionando mesmo com aba em segundo plano

const CACHE_NAME = 'evocrm-v1';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

// Exibe notificações push recebidas
self.addEventListener('push', (event) => {
    if (!event.data) return;
    try {
        const data = event.data.json();
        event.waitUntil(
            self.registration.showNotification(data.title || 'EvoCRM', {
                body: data.body || '',
                icon: '/icon.png',
                badge: '/icon.png',
                tag: data.tag || 'evocrm',
                renotify: true,
                data: data
            })
        );
    } catch(e) {}
});

// Abre/foca o app ao clicar na notificação
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow('/');
            }
        })
    );
});
