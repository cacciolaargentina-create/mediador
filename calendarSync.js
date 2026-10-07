// calendarSync.js
// Bloque 44 — sincroniza CUALQUIER audiencia (presencial, telefónica, con
// cualquier proveedor de video) con el Google Calendar del mediador
// responsable, si lo conectó. Es un concepto DISTINTO de videoConferencing.js
// (que crea la REUNIÓN del proveedor elegido): acá no hace falta elegir
// Google Meet como videoconferencia para que la audiencia aparezca en el
// calendario — conectar la cuenta de Google en Configuración alcanza.
//
// Nunca bloquea la operación principal sobre la audiencia (crear/reprogramar/
// cancelar) si falla o si el mediador no conectó Google — mismo criterio que
// videoConferencing.js con los proveedores de video: un calendario personal
// desincronizado es siempre preferible a una audiencia que no se pudo
// guardar. Por eso estas funciones atrapan sus propios errores y jamás los
// relanzan — el llamador (routes/mediations.js) las invoca sin try/catch.

const googleMeet = require('./videoProviders/googleMeetProvider');
const { logMediationEvent } = require('./mediationEvents');

// Si el proveedor de video de la audiencia YA ES google_meet, el evento de
// Calendar que crea createMeeting (con el link de Meet adentro) ES el
// evento de esta audiencia — sincronizar de nuevo acá duplicaría el evento
// en el calendario del mediador.
function shouldSkip(hearing) {
  return hearing.videoProvider === 'google_meet';
}

async function syncHearingToCalendar(db, { hearing, mediation, actorId }) {
  if (shouldSkip(hearing)) return { ok: true, skipped: true };
  const account = googleMeet.getAccount(db, mediation.mediatorUserId);
  if (!account || account.status !== 'conectado') return { ok: true, skipped: true };
  try {
    const result = hearing.calendarSyncEventId
      ? await googleMeet.updateSyncEvent(db, { mediatorUserId: mediation.mediatorUserId, hearing, mediation })
      : await googleMeet.createSyncEvent(db, { mediatorUserId: mediation.mediatorUserId, hearing, mediation });
    if (!result) return { ok: true, skipped: true }; // sin fecha/hora todavía, por ejemplo — nada que sincronizar
    hearing.calendarSyncEventId = result.eventId;
    hearing.calendarSyncStatus = 'sincronizado';
    hearing.calendarSyncUpdatedAt = Date.now();
    return { ok: true };
  } catch (err) {
    console.error('[calendarSync] error sincronizando audiencia', hearing.id, err.cause || err);
    hearing.calendarSyncStatus = 'error';
    hearing.calendarSyncUpdatedAt = Date.now();
    logMediationEvent(db, {
      mediationId: mediation.id, type: 'CALENDAR_SYNC_ERROR', actorId,
      entityType: 'hearing', entityId: hearing.id,
      title: 'No se pudo sincronizar la audiencia con Google Calendar',
      metadata: { message: err.message || null },
    });
    return { ok: false };
  }
}

async function removeHearingFromCalendar(db, { hearing, mediation, actorId }) {
  if (shouldSkip(hearing)) return { ok: true, skipped: true };
  if (!hearing.calendarSyncEventId) return { ok: true, skipped: true };
  try {
    await googleMeet.deleteSyncEvent(db, { mediatorUserId: mediation.mediatorUserId, hearing });
    hearing.calendarSyncEventId = null;
    hearing.calendarSyncStatus = null;
    hearing.calendarSyncUpdatedAt = Date.now();
    return { ok: true };
  } catch (err) {
    console.error('[calendarSync] error quitando audiencia de Calendar', hearing.id, err.cause || err);
    logMediationEvent(db, {
      mediationId: mediation.id, type: 'CALENDAR_SYNC_ERROR', actorId,
      entityType: 'hearing', entityId: hearing.id,
      title: 'No se pudo quitar la audiencia de Google Calendar',
      metadata: { message: err.message || null },
    });
    return { ok: false };
  }
}

module.exports = { syncHearingToCalendar, removeHearingFromCalendar };
