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
    .map((m) => ({ role: m.role, label: m.label || null, user: publicUser(m.userId), lastSeenAt: m.lastSeenAt || null }));
  return {
    code: channel.code, status: channel.status || 'abierto', createdAt: channel.createdAt, guestToken: channel.guestToken || null, members,
    lastSummary: channel.lastSummary || null,
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
    createdAt: e.createdAt,
  };
}

module.exports = { publicUser, serializeChannel, serializeMessage, serializeEvent };
