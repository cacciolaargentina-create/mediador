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

// guarda el mensaje final (original o reformulado, ya decidido) de una
// parte del canal — reemplaza la lógica que antes vivía inline en
// POST /:code/messages de routes/channels.js.
async function postMessage(io, channel, { senderId, text, flagged, reason }) {
  const db = getDB();
  const sender = db.users.find((u) => u.id === senderId);
  const msg = {
    id: nanoid(), channelId: channel.id, senderId,
    text, flagged: !!flagged, reason: reason || null, pattern: false, readAt: null, createdAt: Date.now(),
  };
  db.messages.push(msg);

  let patternMsg = null;
  if (flagged) {
    const flaggedCount = db.messages.filter(
      (m) => m.channelId === channel.id && m.senderId === senderId && m.flagged
    ).length;
    if (flaggedCount > 0 && flaggedCount % PATTERN_THRESHOLD === 0) {
      patternMsg = {
        id: nanoid(), channelId: channel.id, senderId: null,
        text: `Se detectaron ${flaggedCount} mensajes marcados por el sistema enviados por ${sender ? sender.name : 'un miembro'} en este canal.`,
        flagged: false, reason: null, pattern: true, createdAt: Date.now(),
      };
      db.messages.push(patternMsg);
    }
  }
  await commit();

  const out = serializeMessage(msg);
  io.to(channel.code).emit('message:new', out);
  if (patternMsg) io.to(channel.code).emit('message:new', serializeMessage(patternMsg));

  // avisar a la OTRA parte del canal, sin importar si este mensaje vino de
  // la web o de WhatsApp — la notificación es para quien no lo escribió.
  const otherMember = db.members.find(
    (m) => m.channelId === channel.id && m.userId && m.userId !== senderId && (m.role === 'A' || m.role === 'B')
  );
  if (otherMember && sender) {
    scheduleNotification(io, channel, { toUserId: otherMember.userId, fromName: sender.name });
  }

  return out;
}

// mensaje de sistema (sender: null) — join de canal, confirmaciones de
// calendario, etc. No dispara notificación de WhatsApp (no es contenido
// de una parte, es un aviso administrativo que ya se ve por socket).
async function postSystemMessage(io, channel, text) {
  const db = getDB();
  const msg = {
    id: nanoid(), channelId: channel.id, senderId: null,
    text, flagged: false, reason: null, pattern: false, createdAt: Date.now(),
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

module.exports = { postMessage, postSystemMessage, scheduleNotification, accessLinkFor, getPendingNotificationsCount };
