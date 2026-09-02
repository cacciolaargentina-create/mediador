// public/sw.js
// Se registra desde app.js. Solo hace dos cosas: mostrar la notificación
// que le manda el servidor, y llevar a la persona al canal correcto si la
// toca. Nada de cacheo offline acá — eso sería un cambio de alcance
// mucho más grande (y con datos que cambian tan seguido como los mensajes
// de un chat, cachear mal puede mostrar información vieja como si fuera
// actual, que es peor que no tener nada offline).

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); }
  catch (e) { payload = { title: 'Puente Digital', body: event.data.text() }; }

  const title = payload.title || 'Puente Digital';
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: payload.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        // si ya hay una pestaña/instancia abierta, la reusa y navega, en vez
        // de abrir una segunda instancia de la app encima de la que ya está.
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
