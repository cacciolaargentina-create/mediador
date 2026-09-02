// push.js
// Notificaciones push del navegador (Web Push / VAPID) — canal alternativo
// a las de WhatsApp en messaging.js, para quien no vinculó teléfono pero sí
// agregó la app a su pantalla de inicio y aceptó notificaciones.
//
// Requiere un par de claves VAPID propias del proyecto (no de un usuario ni
// de Meta) — se generan una sola vez con scripts/generate-vapid-keys.js.

const webpush = require('web-push');

function configure() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.warn('⚠ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY no configurados — las notificaciones push del navegador quedan deshabilitadas hasta que corras scripts/generate-vapid-keys.js.');
    return false;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:soporte@caosmatik.com.ar',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  return true;
}
const configured = configure();

// Le manda la notificación a TODOS los dispositivos que esa persona haya
// suscripto (puede tener el celu y la compu, por ejemplo). Si alguna
// suscripción ya venció del lado del navegador (404/410), la borra sola en
// vez de seguir intentando mandarle algo a un destino que ya no existe.
async function sendPushToUser(db, commit, userId, { title, body, url }) {
  if (!configured) return;
  const subs = db.pushSubscriptions.filter((s) => s.userId === userId);
  if (!subs.length) return;

  const payload = JSON.stringify({ title, body, url });
  let changed = false;
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        const idx = db.pushSubscriptions.findIndex((s) => s.id === sub.id);
        if (idx >= 0) { db.pushSubscriptions.splice(idx, 1); changed = true; }
      } else {
        console.error('Error mandando push:', err.statusCode, err.body || err.message);
      }
    }
  }
  if (changed) await commit();
}

module.exports = { sendPushToUser, pushConfigured: () => configured };
