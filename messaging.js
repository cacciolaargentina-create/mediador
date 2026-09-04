// messaging.js
// Helpers de mensajería compartidos entre la web (routes/channels.js) y
// WhatsApp (routes/whatsapp.js) — un mensaje se guarda y transmite igual
// sin importar por dónde entró.

const { nanoid } = require('nanoid');
const { getDB, commit } = require('./db');
const { serializeMessage } = require('./serializers');
const { sendText } = require('./whatsapp');
const { logWhatsappEvent } = require('./whatsappLog');
const { sendPushToUser } = require('./push');

const PATTERN_THRESHOLD = 3;
const NOTIFY_DEBOUNCE_MS = Number(process.env.WHATSAPP_NOTIFY_DEBOUNCE_MS) || 2 * 60 * 1000;

// timers de mensajes en la ventana de "deshacer envío" — si se cancela a
// tiempo, se borra el timer y el mensaje nunca se llega a transmitir. En
// memoria nomás: la ventana es de segundos, no vale la pena persistirlo —
// si el server se reinicia justo en ese margen, en el peor caso el mensaje
// queda pendiente de transmitir un poco más tarde de lo ideal, nunca se
// pierde (deliverAt ya quedó guardado en la fila).
const pendingDeliveries = new Map(); // messageId -> timeout handle

// guarda el mensaje final (original o reformulado, ya decidido) de una
// parte del canal — reemplaza la lógica que antes vivía inline en
// POST /:code/messages de routes/channels.js.
//
// deliverDelayMs > 0 habilita "deshacer envío": el mensaje se guarda ya
// mismo (así el propio remitente lo puede ver optimista en su pantalla),
// pero no se transmite al resto del canal ni dispara notificación hasta
// que pase la ventana — tiempo durante el cual se puede cancelar con
// undoMessage() y nunca le llega nada a nadie más (ver el filtro en
// GET /:code/messages, que oculta estos mensajes a cualquiera que no sea
// el propio remitente mientras deliverAt siga en el futuro).
async function postMessage(io, channel, { senderId, text, flagged, reason, replyToId, deliverDelayMs = 0 }) {
  const db = getDB();
  const now = Date.now();
  // el mensaje citado tiene que ser del MISMO canal — si no, alguien podría
  // mandar el id de un mensaje de otro canal (uno en el que ni siquiera es
  // miembro) y colar su contenido como cita acá.
  const validReplyToId = replyToId && db.messages.some((m) => m.id === replyToId && m.channelId === channel.id)
    ? replyToId
    : null;
  const msg = {
    id: nanoid(), channelId: channel.id, senderId,
    text, flagged: !!flagged, reason: reason || null, pattern: false, readAt: null, createdAt: now,
    replyToId: validReplyToId, deliverAt: deliverDelayMs > 0 ? now + deliverDelayMs : now,
  };
  db.messages.push(msg);
  await commit();

  if (deliverDelayMs > 0) {
    const timer = setTimeout(() => {
      pendingDeliveries.delete(msg.id);
      finalizeMessage(io, channel, msg.id).catch((err) => console.error('Error finalizando mensaje con demora:', err));
    }, deliverDelayMs);
    pendingDeliveries.set(msg.id, timer);
    return serializeMessage(msg); // el remitente lo recibe igual, para mostrarlo optimista con el botón de deshacer
  }

  await finalizeMessage(io, channel, msg.id);
  return serializeMessage(msg);
}

// hace lo que antes hacía postMessage de una — transmitir por socket,
// disparar la alerta de patrón si corresponde, y notificar a la otra
// parte. Separado en su propia función porque ahora puede pasar en el
// momento de guardar (sin demora) o más tarde (con demora, al vencer la
// ventana de deshacer).
async function finalizeMessage(io, channel, messageId) {
  const db = getDB();
  const msg = db.messages.find((m) => m.id === messageId);
  if (!msg) return; // se deshizo antes de que venciera la ventana — nunca se transmite nada
  const sender = db.users.find((u) => u.id === msg.senderId);

  let patternMsg = null;
  if (msg.flagged) {
    const flaggedCount = db.messages.filter(
      (m) => m.channelId === channel.id && m.senderId === msg.senderId && m.flagged
    ).length;
    if (flaggedCount > 0 && flaggedCount % PATTERN_THRESHOLD === 0) {
      patternMsg = {
        id: nanoid(), channelId: channel.id, senderId: null,
        text: `Se detectaron ${flaggedCount} mensajes marcados por el sistema enviados por ${sender ? sender.name : 'un miembro'} en este canal.`,
        flagged: false, reason: null, pattern: true, deliverAt: Date.now(), createdAt: Date.now(),
      };
      db.messages.push(patternMsg);
      await commit();
    }
  }

  io.to(channel.code).emit('message:new', serializeMessage(msg));
  if (patternMsg) io.to(channel.code).emit('message:new', serializeMessage(patternMsg));

  // avisar a la OTRA parte del canal, sin importar si este mensaje vino de
  // la web o de WhatsApp — la notificación es para quien no lo escribió.
  const otherMember = db.members.find(
    (m) => m.channelId === channel.id && m.userId && m.userId !== msg.senderId && (m.role === 'A' || m.role === 'B')
  );
  if (otherMember && sender) {
    scheduleNotification(io, channel, { toUserId: otherMember.userId, fromName: sender.name });
  }
}

// cancela un mensaje todavía dentro de su ventana de "deshacer" — solo
// quien lo escribió puede deshacerlo, y solo mientras no se haya
// transmitido todavía (deliverAt en el futuro). Devuelve false sin tirar
// error si ya es tarde — no es un caso de uso incorrecto, solo perdió la
// ventana, y el frontend ya debería haber ocultado el botón para ese caso.
async function undoMessage(channel, messageId, requesterId) {
  const db = getDB();
  const idx = db.messages.findIndex((m) => m.id === messageId && m.channelId === channel.id);
  if (idx === -1) return false;
  const msg = db.messages[idx];
  if (msg.senderId !== requesterId) return false;
  if (msg.deliverAt <= Date.now()) return false; // ya se transmitió, es tarde para deshacer

  const timer = pendingDeliveries.get(messageId);
  if (timer) { clearTimeout(timer); pendingDeliveries.delete(messageId); }
  db.messages.splice(idx, 1);
  await commit();
  return true;
}

// mensaje de sistema (sender: null) — join de canal, confirmaciones de
// calendario, etc. No dispara notificación de WhatsApp (no es contenido
// de una parte, es un aviso administrativo que ya se ve por socket).
async function postSystemMessage(io, channel, text) {
  const db = getDB();
  const now = Date.now();
  const msg = {
    id: nanoid(), channelId: channel.id, senderId: null,
    text, flagged: false, reason: null, pattern: false, deliverAt: now, createdAt: now,
  };
  db.messages.push(msg);
  await commit();
  const out = serializeMessage(msg);
  io.to(channel.code).emit('message:new', out);
  return out;
}

function baseUrl() {
  return process.env.FRONTEND_URL || `http://localhost:${process.env.PORT || 3000}`;
}

// link de acceso sin login para quien no tiene cuenta de Google: el token
// del guest-link clásico (Persona B invitada desde la web) o el
// webAccessToken de quien se sumó por WhatsApp (A o B).
function accessLinkFor(channel, user) {
  if (user.googleId) return `${baseUrl()}/?channel=${channel.code}`;
  const db = getDB();
  const member = db.members.find((m) => m.channelId === channel.id && m.userId === user.id);
  const token = (member && member.webAccessToken) || channel.guestToken;
  return `${baseUrl()}/?guest=${token}`;
}

// Map<`${channelId}:${toUserId}`, { count, fromName, timer }> — agrupa
// varios mensajes seguidos de la misma persona en UNA sola notificación de
// WhatsApp, en vez de una por mensaje (eso es lo que evita pagarle a Meta
// por cada línea de chat).
const pendingNotifications = new Map();

function scheduleNotification(io, channel, { toUserId, fromName }) {
  const db = getDB();
  const toUser = db.users.find((u) => u.id === toUserId);
  // antes esto cortaba acá si la persona no tenía teléfono cargado — pero
  // push por navegador no necesita teléfono, así que alguien sin WhatsApp
  // vinculado igual puede recibir el aviso si activó notificaciones.
  if (!toUser) return;

  const key = `${channel.id}:${toUserId}`;
  const existing = pendingNotifications.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.count += 1;
    existing.timer = setTimeout(() => fireNotification(key), NOTIFY_DEBOUNCE_MS);
    return;
  }
  const entry = {
    count: 1,
    fromName,
    timer: setTimeout(() => fireNotification(key), NOTIFY_DEBOUNCE_MS),
  };
  pendingNotifications.set(key, entry);
}

async function fireNotification(key) {
  const entry = pendingNotifications.get(key);
  if (!entry) return;
  pendingNotifications.delete(key);

  const [channelId, toUserId] = key.split(':');
  const db = getDB();
  const channel = db.channels.find((c) => c.id === channelId);
  const toUser = db.users.find((u) => u.id === toUserId);
  if (!channel || !toUser) return;

  const link = accessLinkFor(channel, toUser);
  const plural = entry.count > 1 ? `${entry.count} mensajes nuevos` : 'un mensaje nuevo';

  if (toUser.phone) {
    const text = `Tenés ${plural} de ${entry.fromName} en Puente Digital. Verlo: ${link}`;
    try {
      await sendText(toUser.phone, text);
      logWhatsappEvent(db, {
        kind: 'notification_sent', phone: toUser.phone, userName: toUser.name,
        channelCode: channel.code, detail: `${plural} de ${entry.fromName}`,
      });
    } catch (err) {
      console.error('No se pudo enviar la notificación de WhatsApp:', err);
      logWhatsappEvent(db, {
        kind: 'notification_failed', phone: toUser.phone, userName: toUser.name,
        channelCode: channel.code, detail: err.message || String(err),
      });
    }
  }

  // independiente de si tiene WhatsApp vinculado — si además (o en cambio)
  // aceptó notificaciones push del navegador, le llega por los dos lados.
  try {
    await sendPushToUser(db, commit, toUserId, {
      title: 'Puente Digital',
      body: `Tenés ${plural} de ${entry.fromName}`,
      url: link,
    });
  } catch (err) {
    console.error('No se pudo enviar la notificación push:', err);
  }

  await commit();
}

function getPendingNotificationsCount() {
  return pendingNotifications.size;
}

module.exports = { postMessage, postSystemMessage, undoMessage, scheduleNotification, accessLinkFor, getPendingNotificationsCount };
