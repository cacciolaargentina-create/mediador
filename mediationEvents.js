// mediationEvents.js
// Helper compartido para el timeline de Mediador (Bloque 6). Ver
// IMPLEMENTATION_PLAN.md §3.10/3.11 — un push directo a la colección, sin
// bus de eventos ni listeners: lo llaman tanto routes/mediations.js (desde
// cada endpoint) como jobs.js (desde el chequeo diario), para no duplicar
// esta lógica en los dos lugares.

const { nanoid } = require('nanoid');

function logMediationEvent(db, { mediationId, type, actorId, visibility, entityType, entityId, title, description, metadata, causedByEventId }) {
  const event = {
    id: nanoid(), mediationId, type, actorId: actorId || null,
    visibility: visibility || 'public', entityType: entityType || null, entityId: entityId || null,
    title, description: description || null, metadata: metadata || null,
    causedByEventId: causedByEventId || null, createdAt: Date.now(),
  };
  db.mediationEvents.push(event);
  return event;
}

module.exports = { logMediationEvent };
