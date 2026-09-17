// videoProviders/zoomProvider.js
// Bloque 28 §6 — Zoom vía Server-to-Server OAuth (la modalidad que Zoom
// recomienda para apps de un solo tenant/cuenta, sin consentimiento
// interactivo por usuario): se configura UNA vez con las credenciales de
// la cuenta de Zoom del estudio/mediador (ZOOM_ACCOUNT_ID/CLIENT_ID/
// CLIENT_SECRET), nunca por audiencia. No hay "conectar cuenta" por
// mediador acá — es una única cuenta de Zoom para toda la instalación,
// coherente con cómo se usa S2S OAuth en la práctica.

const { VideoProviderError, ERROR_CODES, hearingTimeRange } = require('./base');

const TOKEN_URL = 'https://zoom.us/oauth/token';
const API_BASE = 'https://api.zoom.us/v2';

function configured() {
  return !!(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);
}

// cache en memoria del proceso — el token S2S dura 1h y no es un dato de
// UN mediador puntual, así que no tiene sentido persistirlo por usuario
// (spec §17: nunca en hearings; acá directamente no se persiste en
// ningún lado, se pide de nuevo si el proceso reinicia).
let cachedToken = null;

async function getAccessToken() {
  if (!configured()) throw new VideoProviderError(ERROR_CODES.NOT_CONFIGURED, 'Zoom no está configurado (falta ZOOM_ACCOUNT_ID/ZOOM_CLIENT_ID/ZOOM_CLIENT_SECRET)');
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60000) return cachedToken.token;
  const basic = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(process.env.ZOOM_ACCOUNT_ID)}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new VideoProviderError(ERROR_CODES.AUTH_REQUIRED, 'No se pudo autenticar con Zoom (Server-to-Server OAuth)', { cause: data });
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function createMeeting(db, { hearing, mediation }) {
  const range = hearingTimeRange(hearing);
  const token = await getAccessToken();
  const body = {
    topic: `Audiencia de mediación — ${mediation.code}`,
    type: range ? 2 : 3, // 2 = reunión programada con horario; 3 = "recurrente sin horario fijo" si todavía no hay fecha/hora
    settings: { join_before_host: false, waiting_room: true, approval_type: 2 },
  };
  if (range) {
    body.start_time = range.startISO;
    body.duration = range.durationMinutes;
    body.timezone = 'America/Argentina/Buenos_Aires';
  }
  const res = await fetch(`${API_BASE}/users/me/meetings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new VideoProviderError(ERROR_CODES.CREATE_FAILED, 'Zoom rechazó la creación de la reunión', { cause: data });
  if (!data.join_url) throw new VideoProviderError(ERROR_CODES.CREATE_FAILED, 'Zoom no devolvió un link de reunión', { cause: data });

  // separación estricta join/host (spec §6): join_url va a partes/
  // abogados vía meetingUrl, start_url (host) SOLO se guarda en hostUrl,
  // que los serializers de portal jamás incluyen.
  return {
    meetingId: String(data.id),
    joinUrl: data.join_url,
    hostUrl: data.start_url || null,
    metadata: { zoomMeetingNumber: data.id, hasPassword: !!data.password },
    status: 'creada',
  };
}

async function updateMeeting(db, { hearing }) {
  if (!hearing.meetingId) throw new VideoProviderError(ERROR_CODES.NOT_FOUND, 'Esta audiencia no tiene una reunión de Zoom para actualizar');
  const range = hearingTimeRange(hearing);
  if (!range) throw new VideoProviderError(ERROR_CODES.UPDATE_FAILED, 'La audiencia necesita fecha y hora para actualizar la reunión');
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}/meetings/${encodeURIComponent(hearing.meetingId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_time: range.startISO, duration: range.durationMinutes, timezone: 'America/Argentina/Buenos_Aires' }),
  });
  if (res.status === 404) throw new VideoProviderError(ERROR_CODES.NOT_FOUND, 'La reunión ya no existe en Zoom');
  if (!res.ok && res.status !== 204) {
    const data = await res.json().catch(() => ({}));
    throw new VideoProviderError(ERROR_CODES.UPDATE_FAILED, 'Zoom rechazó la actualización de la reunión', { cause: data });
  }
  // PATCH de Zoom devuelve 204 sin body — el join/host URL no cambia al
  // reprogramar, así que se conservan los que ya estaban guardados.
  return { joinUrl: hearing.meetingUrl, hostUrl: hearing.hostUrl || null, metadata: hearing.meetingMetadata || null, status: 'actualizada' };
}

async function cancelMeeting(db, { hearing }) {
  if (!hearing.meetingId) return { status: 'cancelada' };
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}/meetings/${encodeURIComponent(hearing.meetingId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new VideoProviderError(ERROR_CODES.CANCEL_FAILED, 'Zoom rechazó la cancelación de la reunión', { cause: data });
  }
  return { status: 'cancelada' };
}

async function getStatus() {
  if (!configured()) return { status: 'no_configurada', accountEmail: null, lastError: null };
  try {
    await getAccessToken();
    return { status: 'conectado', accountEmail: null, lastError: null };
  } catch (err) {
    return { status: 'error', accountEmail: null, lastError: err.message };
  }
}

async function isConfigured() {
  if (!configured()) return false;
  try { await getAccessToken(); return true; }
  catch (e) { return false; }
}

module.exports = {
  name: 'zoom',
  label: 'Zoom',
  perMediatorAccount: false,
  isConfigured,
  getStatus,
  createMeeting,
  updateMeeting,
  cancelMeeting,
};
