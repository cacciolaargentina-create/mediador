// audit.js
// Log de auditoría liviano para el panel de admin: quién exportó qué canal,
// quién asignó/quitó a un profesional. No registra cada clic — solo
// acciones sensibles, para no terminar siendo un duplicado del historial
// de mensajes. Se guarda en la misma db.json (colección auditLog) y se
// recorta a las últimas MAX_ENTRIES para no crecer sin límite.

const { nanoid } = require('nanoid');

const MAX_ENTRIES = 1000;

// db: instancia de getDB() ya obtenida por quien llama (evita otro require circular)
function logAudit(db, { actorId, action, channelCode, meta }) {
  db.auditLog.push({
    id: nanoid(), actorId, action, channelCode: channelCode || null,
    meta: meta || null, createdAt: Date.now(),
  });
  if (db.auditLog.length > MAX_ENTRIES) {
    db.auditLog.splice(0, db.auditLog.length - MAX_ENTRIES);
  }
}

module.exports = { logAudit };
