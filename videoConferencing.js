// videoConferencing.js
// Bloque 28 — capa que conecta hearings con videoProviders/. Es lo único
// que routes/mediations.js llama: crear/actualizar/cancelar la reunión de
// una audiencia. Nunca conoce Express, nunca conoce el proveedor
// concreto más allá de pedírselo a videoProviders/index.js — así sumar
// un proveedor nuevo no toca este archivo.
//
// Estados de la REUNIÓN (hearing.meetingStatus), separados del estado de
// la AUDIENCIA (hearing.status) — spec §19: pueden estar en
// combinaciones "raras" a propósito (ej. audiencia programada +
// videoconferencia en error), y de eso se entera el mediador por la
// tarjeta de videoconferencia, no por magia.
const MEETING_STATUS = {
  NO_CONFIGURADA: 'no_configurada',
  CREANDO: 'creando',
  CREADA: 'creada',
  ACTUALIZANDO: 'actualizando',
  ACTUALIZADA: 'actualizada',
  ERROR: 'error',
  CANCELADA: 'cancelada',
};

const { getProvider } = require('./videoProviders');
const { VideoProviderError, ERROR_CODES, ERROR_MESSAGES } = require('./videoProviders/base');
const { logMediationEvent } = require('./mediationEvents');

const PROVIDER_LABELS = { google_meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams', manual: 'Enlace manual' };

function toClientError(err) {
  const code = err instanceof VideoProviderError ? err.code : ERROR_CODES.CREATE_FAILED;
  return { code, message: (err instanceof VideoProviderError && err.message) || ERROR_MESSAGES[code] };
}

// hearing puede ser un objeto todavía NO empujado a db.hearings (creación)
// o uno ya persistido (reprogramación) — en los dos casos esta función
// solo MUTA el objeto en memoria; el llamador decide cuándo pushear/
// commitear, y si hace falta abortar toda la operación cuando falla
// (spec §5: "NO crear una audiencia aparentemente virtual sin enlace").
async function createHearingMeeting(db, { hearing, mediation, provider, meetingUrl, actorId }) {
  const providerName = provider || (meetingUrl ? 'manual' : null);
  if (!providerName) return { ok: true, skipped: true };

  hearing.videoProvider = providerName;
  hearing.meetingStatus = MEETING_STATUS.CREANDO;
  try {
    const adapter = getProvider(providerName);
    const result = await adapter.createMeeting(db, { mediatorUserId: mediation.mediatorUserId, hearing, mediation, meetingUrl });
    hearing.meetingId = result.meetingId || null;
    hearing.meetingUrl = result.joinUrl;
    hearing.hostUrl = result.hostUrl || null;
    hearing.meetingMetadata = result.metadata || null;
    hearing.meetingStatus = result.status || MEETING_STATUS.CREADA;
    hearing.meetingCreatedAt = Date.now();
    hearing.meetingUpdatedAt = Date.now();
    logMediationEvent(db, {
      mediationId: mediation.id, type: 'VIDEO_MEETING_CREATED', actorId,
      entityType: 'hearing', entityId: hearing.id,
      title: `Videoconferencia creada (${PROVIDER_LABELS[providerName] || providerName})`,
      metadata: { provider: providerName },
    });
    return { ok: true };
  } catch (err) {
    hearing.meetingStatus = MEETING_STATUS.ERROR;
    console.error('[video] error creando reunión', providerName, hearing.id, err.cause || err);
    const clientError = toClientError(err);
    logMediationEvent(db, {
      mediationId: mediation.id, type: 'VIDEO_MEETING_ERROR', actorId,
      entityType: 'hearing', entityId: hearing.id,
      title: `Error al crear la videoconferencia (${PROVIDER_LABELS[providerName] || providerName})`,
      description: clientError.message,
      metadata: { provider: providerName, code: clientError.code, action: 'create' },
    });
    return { ok: false, error: clientError };
  }
}

// Se llama SOLO cuando cambia fecha/hora/duración de una audiencia que ya
// tiene un proveedor real detrás — spec §9: "no crear una reunión nueva
// innecesariamente". Si la audiencia no tiene videoProvider (presencial,
// o virtual con link manual sin proveedor asociado), no hay nada que
// actualizar del lado del proveedor externo.
async function updateHearingMeeting(db, { hearing, mediation, actorId }) {
  if (!hearing.videoProvider) return { ok: true, skipped: true };
  const providerName = hearing.videoProvider;
  const previousStatus = hearing.meetingStatus;
  hearing.meetingStatus = MEETING_STATUS.ACTUALIZANDO;
  try {
    const adapter = getProvider(providerName);
    const result = await adapter.updateMeeting(db, { mediatorUserId: mediation.mediatorUserId, hearing, mediation, meetingUrl: hearing.meetingUrl });
    hearing.meetingUrl = result.joinUrl || hearing.meetingUrl;
    hearing.hostUrl = result.hostUrl !== undefined ? result.hostUrl : hearing.hostUrl;
    hearing.meetingMetadata = result.metadata !== undefined ? result.metadata : hearing.meetingMetadata;
    hearing.meetingStatus = result.status || MEETING_STATUS.ACTUALIZADA;
    hearing.meetingUpdatedAt = Date.now();
    logMediationEvent(db, {
      mediationId: mediation.id, type: 'VIDEO_MEETING_UPDATED', actorId,
      entityType: 'hearing', entityId: hearing.id,
      title: `Videoconferencia actualizada (${PROVIDER_LABELS[providerName] || providerName})`,
      metadata: { provider: providerName },
    });
    return { ok: true };
  } catch (err) {
    hearing.meetingStatus = MEETING_STATUS.ERROR;
    console.error('[video] error actualizando reunión', providerName, hearing.id, err.cause || err);
    const clientError = toClientError(err);
    logMediationEvent(db, {
      mediationId: mediation.id, type: 'VIDEO_MEETING_ERROR', actorId,
      entityType: 'hearing', entityId: hearing.id,
      title: `Error al actualizar la videoconferencia (${PROVIDER_LABELS[providerName] || providerName})`,
      description: clientError.message,
      metadata: { provider: providerName, code: clientError.code, action: 'update', previousStatus },
    });
    // la audiencia SIGUE reprogramada — el link viejo queda como estaba,
    // el mediador ve el error en la tarjeta y decide (spec §9/§19).
    return { ok: false, error: clientError };
  }
}

// Se llama al cancelar la audiencia. Nunca bloquea la cancelación de la
// AUDIENCIA si el proveedor externo falla (spec §10: "la audiencia de
// Mediador debe mantener su estado real") — solo deja constancia del
// error para que el mediador sepa que puede haber quedado una reunión
// viva del otro lado.
async function cancelHearingMeeting(db, { hearing, mediation, actorId }) {
  if (!hearing.videoProvider) return { ok: true, skipped: true };
  const providerName = hearing.videoProvider;
  try {
    const adapter = getProvider(providerName);
    await adapter.cancelMeeting(db, { mediatorUserId: mediation.mediatorUserId, hearing, mediation });
    hearing.meetingStatus = MEETING_STATUS.CANCELADA;
    hearing.meetingUpdatedAt = Date.now();
    logMediationEvent(db, {
      mediationId: mediation.id, type: 'VIDEO_MEETING_CANCELLED', actorId,
      entityType: 'hearing', entityId: hearing.id,
      title: `Videoconferencia cancelada (${PROVIDER_LABELS[providerName] || providerName})`,
      metadata: { provider: providerName },
    });
    return { ok: true };
  } catch (err) {
    console.error('[video] error cancelando reunión', providerName, hearing.id, err.cause || err);
    const clientError = toClientError(err);
    hearing.meetingStatus = MEETING_STATUS.ERROR;
    hearing.meetingUpdatedAt = Date.now();
    logMediationEvent(db, {
      mediationId: mediation.id, type: 'VIDEO_MEETING_ERROR', actorId,
      entityType: 'hearing', entityId: hearing.id,
      title: `Error al cancelar la videoconferencia (${PROVIDER_LABELS[providerName] || providerName})`,
      description: clientError.message,
      metadata: { provider: providerName, code: clientError.code, action: 'cancel' },
    });
    return { ok: false, error: clientError };
  }
}

// campos seguros para el mediador/equipo (nunca para portales de parte/
// abogado — esos serializers ya whitelistean sus propios campos y jamás
// tocan hostUrl/meetingMetadata, ver routes/party-portal.js y
// routes/lawyer-portal.js).
function serializeHearingVideo(hearing) {
  if (!hearing.videoProvider) return null;
  return {
    provider: hearing.videoProvider,
    providerLabel: PROVIDER_LABELS[hearing.videoProvider] || hearing.videoProvider,
    meetingStatus: hearing.meetingStatus || null,
    joinUrl: hearing.meetingUrl || null,
    hostUrl: hearing.hostUrl || null,
    createdAt: hearing.meetingCreatedAt || null,
    updatedAt: hearing.meetingUpdatedAt || null,
  };
}

module.exports = {
  MEETING_STATUS, PROVIDER_LABELS,
  createHearingMeeting, updateHearingMeeting, cancelHearingMeeting,
  serializeHearingVideo,
};
