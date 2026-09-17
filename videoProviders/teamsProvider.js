// videoProviders/teamsProvider.js
// Bloque 28 §7 — Microsoft Teams, adapter preparado con el mismo
// contrato que los demás (client-credentials contra Microsoft Graph,
// igual criterio "una sola configuración por cuenta" que Zoom §6), pero
// SIN simular ninguna integración: si no hay credenciales de una app de
// Azure AD con permiso OnlineMeetings.ReadWrite.All consentido, isConfigured()
// da false y getStatus() devuelve 'no_configurada' — routes/mediations.js
// nunca intenta crear una reunión con este adapter en ese caso, y
// Configuración muestra "Microsoft Teams no está configurado." (spec §7).

const { VideoProviderError, ERROR_CODES, hearingTimeRange } = require('./base');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

function configured() {
  return !!(process.env.MICROSOFT_TENANT_ID && process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET && process.env.MICROSOFT_ORGANIZER_UPN);
}

let cachedToken = null;

async function getAccessToken() {
  if (!configured()) throw new VideoProviderError(ERROR_CODES.NOT_CONFIGURED, 'Microsoft Teams no está configurado');
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60000) return cachedToken.token;
  const tokenUrl = `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new VideoProviderError(ERROR_CODES.AUTH_REQUIRED, 'No se pudo autenticar con Microsoft Graph', { cause: data });
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

// app-only: la reunión se crea "en nombre de" un organizador fijo
// (MICROSOFT_ORGANIZER_UPN) — Graph no permite crear onlineMeetings
// app-only para un usuario arbitrario sin ese permiso delegado. Queda
// documentado como limitación conocida en docs/VIDEO_CONFERENCING.md.
async function createMeeting(db, { hearing, mediation }) {
  const range = hearingTimeRange(hearing);
  if (!range) throw new VideoProviderError(ERROR_CODES.CREATE_FAILED, 'La audiencia necesita fecha y hora para crear la reunión');
  const token = await getAccessToken();
  const endMs = new Date(range.endISO).getTime();
  const res = await fetch(`${GRAPH_BASE}/users/${encodeURIComponent(process.env.MICROSOFT_ORGANIZER_UPN)}/onlineMeetings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: `Audiencia de mediación — ${mediation.code}`,
      startDateTime: range.startISO,
      endDateTime: new Date(endMs).toISOString(),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new VideoProviderError(ERROR_CODES.CREATE_FAILED, 'Microsoft Teams rechazó la creación de la reunión', { cause: data });
  if (!data.joinWebUrl) throw new VideoProviderError(ERROR_CODES.CREATE_FAILED, 'Microsoft Teams no devolvió un link de reunión', { cause: data });
  return { meetingId: data.id, joinUrl: data.joinWebUrl, hostUrl: null, metadata: { organizerUpn: process.env.MICROSOFT_ORGANIZER_UPN }, status: 'creada' };
}

async function updateMeeting(db, { hearing, mediation }) {
  // Graph no soporta reprogramar un onlineMeeting existente (solo
  // create/get/delete) — se recrea y se reemplaza el link, dejando
  // constancia en el timeline vía videoConferencing.js (spec §9: "si el
  // proveedor no permite actualizar determinado dato, informar
  // claramente y usar el mecanismo seguro correspondiente").
  await cancelMeeting(null, { hearing });
  return createMeeting(db, { hearing, mediation });
}

async function cancelMeeting(db, { hearing }) {
  if (!hearing.meetingId) return { status: 'cancelada' };
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}/users/${encodeURIComponent(process.env.MICROSOFT_ORGANIZER_UPN)}/onlineMeetings/${encodeURIComponent(hearing.meetingId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new VideoProviderError(ERROR_CODES.CANCEL_FAILED, 'Microsoft Teams rechazó la cancelación de la reunión', { cause: data });
  }
  return { status: 'cancelada' };
}

async function getStatus() {
  if (!configured()) return { status: 'no_configurada', accountEmail: null, lastError: null };
  try {
    await getAccessToken();
    return { status: 'conectado', accountEmail: process.env.MICROSOFT_ORGANIZER_UPN, lastError: null };
  } catch (err) {
    return { status: 'error', accountEmail: null, lastError: err.message };
  }
}

async function isConfigured() {
  return configured();
}

module.exports = {
  name: 'teams',
  label: 'Microsoft Teams',
  perMediatorAccount: false,
  isConfigured,
  getStatus,
  createMeeting,
  updateMeeting,
  cancelMeeting,
};
