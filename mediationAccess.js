// mediationAccess.js
// "Cuáles son mis mediaciones" — extraído de routes/mediations.js (Bloque
// 15) para que routes/agenda.js pueda reusar exactamente la misma lógica,
// en vez de duplicarla. Ni mediation_access ni studioId/studioRole
// cambian de significado acá — esto solo centraliza el cálculo que ya
// existía.

const { isAdminUser } = require('./roles');

function getMyMediations(db, user) {
  if (isAdminUser(user)) return db.mediations;
  const accessIds = new Set(db.mediationAccess.filter((a) => a.userId === user.id).map((a) => a.mediationId));
  if (user.studioId && user.studioRole === 'admin') {
    const studioUserIds = new Set(db.users.filter((u) => u.studioId === user.studioId).map((u) => u.id));
    return db.mediations.filter((m) => m.mediatorUserId === user.id || accessIds.has(m.id) || studioUserIds.has(m.mediatorUserId));
  }
  return db.mediations.filter((m) => m.mediatorUserId === user.id || accessIds.has(m.id));
}

// puede editar (crear/reprogramar/cancelar audiencias) de esta mediación
// puntual — mismo criterio que requireEditAccess en routes/mediations.js,
// pero como función pura para poder llamarla desde agenda.js sin pasar
// por el middleware de Express.
function canEditMediation(db, user, mediation) {
  if (isAdminUser(user)) return true;
  if (mediation.mediatorUserId === user.id) return true;
  if (user.studioId && user.studioRole === 'admin') {
    const owner = db.users.find((u) => u.id === mediation.mediatorUserId);
    if (owner && owner.studioId === user.studioId) return true;
  }
  const access = db.mediationAccess.find((a) => a.mediationId === mediation.id && a.userId === user.id);
  return !!access && ['mediador', 'asistente'].includes(access.role);
}

module.exports = { getMyMediations, canEditMediation };
