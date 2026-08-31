// whatsappLog.js
// Log liviano de actividad de WhatsApp para el panel de admin: notificaciones
// agrupadas que se mandaron (o fallaron), onboarding (CREAR/UNIRSE), mensajes
// entrantes procesados, y firmas de webhook inválidas. Recortado a las últimas
// MAX_ENTRIES para no crecer sin límite — mismo criterio que audit.js.
//
// El log de payloads crudos del webhook es un archivo aparte a propósito: es
// contenido más pesado y más sensible (texto real de mensajes de WhatsApp),
// pensado solo para debug técnico, no para la vista de actividad normal.

const { nanoid } = require('nanoid');

const MAX_LOG = 500;
const MAX_RAW = 100;

function logWhatsappEvent(db, { kind, phone, userName, channelCode, detail }) {
  db.whatsappLog.push({
    id: nanoid(), kind, phone: phone || null, userName: userName || null,
    channelCode: channelCode || null, detail: detail || null, createdAt: Date.now(),
  });
  if (db.whatsappLog.length > MAX_LOG) {
    db.whatsappLog.splice(0, db.whatsappLog.length - MAX_LOG);
  }
}

function logWebhookRaw(db, payload) {
  db.whatsappWebhookRaw.push({ id: nanoid(), payload: JSON.stringify(payload), createdAt: Date.now() });
  if (db.whatsappWebhookRaw.length > MAX_RAW) {
    db.whatsappWebhookRaw.splice(0, db.whatsappWebhookRaw.length - MAX_RAW);
  }
}

module.exports = { logWhatsappEvent, logWebhookRaw };
