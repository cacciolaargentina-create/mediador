// serializers.js
// Convierte los registros crudos de db.js a la forma que consume el
// frontend. Compartido entre routes/channels.js y routes/guest.js para que
// un canal se vea igual sin importar si el pedido vino de Persona A
// (Google) o Persona B (link de invitado).

const { getDB } = require('./db');

function publicUser(userId) {
  const db = getDB();
  const u = db.users.find((x) => x.id === userId);
  return u ? { id: u.id, name: u.name, avatar: u.avatar } : null;
}

function serializeChannel(channel) {
  const db = getDB();
  const members = db.members
    .filter((m) => m.channelId === channel.id)
    .map((m) => {
      const rawUser = db.users.find((u) => u.id === m.userId);
      return {
        role: m.role, label: m.label || null, user: publicUser(m.userId), lastSeenAt: m.lastSeenAt || null,
        // insignia de "profesional verificado" (ver admin.js / roles.js) —
        // solo tiene sentido en un rol que no sea A/B: es la plataforma
        // certificando que ESE mediador/a o estudio pasó la revisión
        // manual de un admin, no que la parte misma esté "verificada".
        verified: !!(rawUser && rawUser.verifiedProfessional && m.role !== 'A' && m.role !== 'B'),
      };
    });
  return {
    code: channel.code, status: channel.status || 'abierto', createdAt: channel.createdAt, guestToken: channel.guestToken || null, members,
    lastSummary: channel.lastSummary || null,
  };
}

// vista chica del mensaje citado, para el "responder" estilo WhatsApp —
// solo lo que hace falta para mostrar la cita arriba del mensaje nuevo
// (quién y un fragmento), no el mensaje entero.
function replyPreview(replyToId) {
  if (!replyToId) return null;
  const db = getDB();
  const original = db.messages.find((m) => m.id === replyToId);
  if (!original) return null; // pudo haberse ido de la ventana cargada, o (raro) borrado — no rompe el mensaje que lo cita
  return {
    id: original.id,
    senderName: original.senderId ? (publicUser(original.senderId)?.name || null) : (original.pattern ? 'Alerta de patrón' : 'Sistema'),
    text: original.text.length > 140 ? original.text.slice(0, 140) + '…' : original.text,
  };
}

function serializeMessage(m) {
  return {
    id: m.id,
    sender: m.senderId ? publicUser(m.senderId) : null,
    text: m.text,
    flagged: m.flagged,
    reason: m.reason,
    pattern: m.pattern || false,
    eventId: m.eventId || null,
    readAt: m.readAt || null,
    createdAt: m.createdAt,
    // igual a createdAt salvo mientras está en su ventana de "deshacer
    // envío" (ver messaging.js) — el frontend lo usa para saber si todavía
    // se puede deshacer y para el conteo regresivo de la barra.
    deliverAt: m.deliverAt || m.createdAt,
    replyTo: replyPreview(m.replyToId),
  };
}

function serializeEvent(e) {
  return {
    id: e.id,
    date: e.date,
    detail: e.detail,
    requestedBy: publicUser(e.requestedBy),
    status: e.status,
    seriesId: e.seriesId || null,
    swapId: e.swapId || null,
    createdAt: e.createdAt,
    kind: e.kind || 'entrega',
  };
}

module.exports = { publicUser, serializeChannel, serializeMessage, serializeEvent };
