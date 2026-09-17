// videoProviders/base.js
// Bloque 28 — contrato común de VideoProvider. Cada adapter (google_meet,
// zoom, teams, manual) implementa las mismas operaciones conceptuales de
// la spec: createMeeting/updateMeeting/cancelMeeting/getStatus. Nada de
// esto conoce hearings ni Express — eso vive en videoConferencing.js y en
// routes/mediations.js, para que agregar un proveedor nuevo el día de
// mañana no toque la lógica central de audiencias (spec §"NO acoplar la
// lógica de hearings directamente a Zoom").
//
// Interfaz que debe cumplir cada adapter:
//   name: string                                    — 'google_meet'|'zoom'|'teams'|'manual'
//   label: string                                    — nombre para mostrar
//   perMediatorAccount: boolean                      — true si cada mediador conecta SU cuenta (Google Meet);
//                                                       false si es una sola cuenta de la app para todos (Zoom S2S, Teams app-only)
//   async isConfigured(db, mediatorUserId) -> boolean
//   async getStatus(db, mediatorUserId) -> { status, accountEmail, lastError }
//   async createMeeting(db, { mediatorUserId, hearing, mediation, meetingUrl }) -> { meetingId, joinUrl, hostUrl, metadata, status }
//   async updateMeeting(db, { mediatorUserId, hearing, mediation, meetingUrl }) -> { joinUrl, hostUrl, metadata, status }
//   async cancelMeeting(db, { mediatorUserId, hearing, mediation }) -> { status }

const ERROR_CODES = {
  NOT_CONFIGURED: 'VIDEO_PROVIDER_NOT_CONFIGURED',
  AUTH_REQUIRED: 'VIDEO_PROVIDER_AUTH_REQUIRED',
  AUTH_EXPIRED: 'VIDEO_PROVIDER_AUTH_EXPIRED',
  CREATE_FAILED: 'VIDEO_MEETING_CREATE_FAILED',
  UPDATE_FAILED: 'VIDEO_MEETING_UPDATE_FAILED',
  CANCEL_FAILED: 'VIDEO_MEETING_CANCEL_FAILED',
  NOT_FOUND: 'VIDEO_MEETING_NOT_FOUND',
};

// mensaje genérico para el usuario final — nunca el detalle crudo del
// proveedor externo (spec §18: "no mostrar stack traces al usuario").
const ERROR_MESSAGES = {
  [ERROR_CODES.NOT_CONFIGURED]: 'Este proveedor de videoconferencia no está configurado todavía.',
  [ERROR_CODES.AUTH_REQUIRED]: 'Hace falta conectar la cuenta de este proveedor en Configuración → Videoconferencias.',
  [ERROR_CODES.AUTH_EXPIRED]: 'La conexión con este proveedor venció — hay que reconectarla en Configuración.',
  [ERROR_CODES.CREATE_FAILED]: 'No se pudo crear la reunión. La audiencia no fue vinculada a una videollamada.',
  [ERROR_CODES.UPDATE_FAILED]: 'No se pudo actualizar la reunión en el proveedor externo.',
  [ERROR_CODES.CANCEL_FAILED]: 'No se pudo cancelar la reunión en el proveedor externo.',
  [ERROR_CODES.NOT_FOUND]: 'La reunión ya no existe en el proveedor externo.',
};

class VideoProviderError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message || ERROR_MESSAGES[code] || code);
    this.code = code || ERROR_CODES.CREATE_FAILED;
    // cause se loguea internamente (console.error en videoConferencing.js),
    // nunca se manda tal cual al cliente — puede traer el body crudo del
    // proveedor externo.
    this.cause = cause || null;
  }
}

// Buenos Aires es UTC-3 fijo, sin horario de verano (mismo criterio que
// routes/agenda.js) — evita depender de en qué zona horaria corre el
// proceso de Node para armar los datetime que se mandan a Google/Zoom.
function formatBaIso(ms) {
  const d = new Date(ms + 3 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00-03:00`;
}

// Rango horario de la audiencia en ISO con offset fijo -03:00, listo para
// mandar a una API externa. Sin startTime no hay nada que crear (una
// audiencia sin hora todavía no tiene "cuándo" real) — el llamador decide
// qué hacer en ese caso (spec: no se exige hora para crear la audiencia).
function hearingTimeRange(hearing, defaultDurationMinutes = 60) {
  if (!hearing.date || !hearing.startTime) return null;
  const startISO = `${hearing.date}T${hearing.startTime}:00-03:00`;
  const startMs = new Date(startISO).getTime();
  if (Number.isNaN(startMs)) return null;
  let endMs = null;
  if (hearing.endTime) {
    endMs = new Date(`${hearing.date}T${hearing.endTime}:00-03:00`).getTime();
  }
  if (endMs == null || Number.isNaN(endMs) || endMs <= startMs) {
    endMs = startMs + defaultDurationMinutes * 60000;
  }
  const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));
  return { startISO, endISO: formatBaIso(endMs), durationMinutes };
}

module.exports = { ERROR_CODES, ERROR_MESSAGES, VideoProviderError, hearingTimeRange, formatBaIso };
