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

// puede VER esta mediación (cualquier rol de mediation_access, no solo
// mediador/asistente) — mismo criterio que requireMediationAccess en
// routes/mediations.js, como función pura. Bloque 19: esto es lo que
// autoriza a alguien del equipo a unirse por Socket.IO a un canal de la
// mediación (leer no es lo mismo que poder mandar mensajes — eso lo
// sigue validando cada endpoint HTTP con requireEditAccess aparte).
function canAccessMediation(db, user, mediation) {
  if (isAdminUser(user)) return true;
  if (mediation.mediatorUserId === user.id) return true;
  if (user.studioId && user.studioRole === 'admin') {
    const owner = db.users.find((u) => u.id === mediation.mediatorUserId);
    if (owner && owner.studioId === user.studioId) return true;
  }
  return db.mediationAccess.some((a) => a.mediationId === mediation.id && a.userId === user.id);
}

// Bloque 19 — autorización de Socket.IO para un canal de Mediador
// (channel.mediationId seteado). Dos caminos válidos, nada más:
//   1) alguien del equipo con acceso a ESA mediación (cualquier hilo:
//      interno, con cualquier parte, con cualquier abogado)
//   2) la parte o el abogado dueño/a de ESE hilo puntual — nunca el de
//      un hilo ajeno de la misma mediación
// No confiar en members: un asistente recién asignado puede no tener
// todavía una fila en members de este canal puntual, y aun así debe
// poder unirse — por eso esto reemplaza (no complementa) el chequeo de
// members para canales de Mediador.
function canAccessMediationChannel(db, userId, channel) {
  const mediation = db.mediations.find((m) => m.id === channel.mediationId);
  if (!mediation) return false;
  const user = db.users.find((u) => u.id === userId);
  if (user && canAccessMediation(db, user, mediation)) return true;
  if (channel.partyId) {
    const party = db.parties.find((p) => p.id === channel.partyId);
    if (party && party.linkedUserId === userId) return true;
  }
  if (channel.lawyerId) {
    const lawyer = db.lawyers.find((l) => l.id === channel.lawyerId);
    if (lawyer && lawyer.linkedUserId === userId) return true;
  }
  return false;
}

// Bloque 22 (Parte 2) — cantidad de mediaciones ACTIVAS (no cerradas)
// donde esta persona es titular o tiene mediation_access. Mismo criterio
// de pertenencia que getMyMediations, filtrado a "no cerrada".
function getActiveMediationCount(db, userId) {
  const accessIds = new Set(db.mediationAccess.filter((a) => a.userId === userId).map((a) => a.mediationId));
  return db.mediations.filter((m) => !m.closedAt && (m.mediatorUserId === userId || accessIds.has(m.id))).length;
}

// Sugiere, entre los mediadores del estudio (rol 'mediador' puntual —
// no admin, no asistente), a quien tiene menos mediaciones activas en
// este momento. Sin ponderar especialidad, historial ni nada más
// sofisticado — a propósito, esta parte es deliberadamente simple.
// Devuelve null si no hay una elección real que sugerir (0 o 1
// candidato: no hay entre quién elegir).
function suggestAssigneeForStudio(db, studioId) {
  const candidates = db.users.filter((u) => u.studioId === studioId && u.studioRole === 'mediador');
  if (candidates.length < 2) return null;
  const withLoad = candidates.map((u) => ({ id: u.id, name: u.name, activeCount: getActiveMediationCount(db, u.id) }));
  withLoad.sort((a, b) => a.activeCount - b.activeCount);
  return withLoad[0];
}

module.exports = { getMyMediations, canEditMediation, canAccessMediation, canAccessMediationChannel, getActiveMediationCount, suggestAssigneeForStudio };
