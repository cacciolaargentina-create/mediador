// videoProviders/googleMeetProvider.js
// Bloque 28 §5 — Google Meet vía Google Calendar API (conferenceData),
// que es la forma oficial de generar un link de Meet por API. Reusa el
// MISMO client (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET que ya existían
// para el login — spec: "no crear un sistema de login Google nuevo"),
// pero con su PROPIO consentimiento/token: el login (routes/auth.js) pide
// scope 'profile email' y descarta el token; acá hace falta
// 'calendar.events' con acceso offline (refresh_token) para poder crear
// reuniones sin que el mediador tenga que loguearse cada vez. Por eso es
// un flujo de conexión aparte ("Conectar cuenta" en Configuración), no
// una ruta nueva de login.
//
// Sin dependencias nuevas (googleapis no está instalado y el repo
// evita sumar paquetes si alcanza con fetch nativo — ver db.js usando
// node:sqlite en vez de better-sqlite3, mismo criterio).

const { VideoProviderError, ERROR_CODES, hearingTimeRange } = require('./base');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function configured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function callbackUrl() {
  return process.env.GOOGLE_MEET_CALLBACK_URL || '/api/video-providers/google_meet/callback';
}

function getAccount(db, userId) {
  return db.videoProviderAccounts.find((a) => a.userId === userId && a.provider === 'google_meet');
}

// URL de consentimiento — access_type:offline + prompt:consent para
// garantizar un refresh_token incluso si el mediador ya había autorizado
// esta app antes con otro scope.
function buildAuthUrl({ redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens({ code, redirectUri }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new VideoProviderError(ERROR_CODES.AUTH_REQUIRED, 'Google rechazó la autorización', { cause: data });
  return data; // { access_token, refresh_token, expires_in, ... }
}

async function fetchUserEmail(accessToken) {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.email || null;
  } catch (e) {
    return null;
  }
}

async function refreshAccessToken(account) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new VideoProviderError(ERROR_CODES.AUTH_EXPIRED, 'No se pudo renovar el acceso a Google Calendar', { cause: data });
  return data;
}

async function ensureValidToken(db, account) {
  if (account.accessToken && account.expiresAt && account.expiresAt - Date.now() > 60000) {
    return account.accessToken;
  }
  if (!account.refreshToken) {
    throw new VideoProviderError(ERROR_CODES.AUTH_REQUIRED, 'La cuenta de Google Meet no está conectada');
  }
  const data = await refreshAccessToken(account);
  account.accessToken = data.access_token;
  account.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  account.status = 'conectado';
  account.lastError = null;
  account.updatedAt = Date.now();
  return account.accessToken;
}

function joinUrlFrom(eventData) {
  if (eventData.hangoutLink) return eventData.hangoutLink;
  const entry = (eventData.conferenceData?.entryPoints || []).find((e) => e.entryPointType === 'video');
  return entry ? entry.uri : null;
}

async function createMeeting(db, { mediatorUserId, hearing, mediation }) {
  if (!configured()) throw new VideoProviderError(ERROR_CODES.NOT_CONFIGURED, 'Google Meet no está configurado (falta GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)');
  const account = getAccount(db, mediatorUserId);
  if (!account || account.status !== 'conectado') {
    throw new VideoProviderError(ERROR_CODES.AUTH_REQUIRED, 'Conectá tu cuenta de Google Meet en Configuración → Videoconferencias');
  }
  const range = hearingTimeRange(hearing);
  if (!range) throw new VideoProviderError(ERROR_CODES.CREATE_FAILED, 'La audiencia necesita fecha y hora para crear la reunión');

  const token = await ensureValidToken(db, account);
  const body = {
    summary: `Audiencia de mediación — ${mediation.code}`,
    description: `Mediación ${mediation.code}${mediation.object ? ': ' + mediation.object : ''}`.slice(0, 1000),
    start: { dateTime: range.startISO },
    end: { dateTime: range.endISO },
    conferenceData: { createRequest: { requestId: hearing.id, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
  };
  const res = await fetch(`${CALENDAR_EVENTS_URL}?conferenceDataVersion=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new VideoProviderError(ERROR_CODES.CREATE_FAILED, 'Google Calendar rechazó la creación de la reunión', { cause: data });
  const joinUrl = joinUrlFrom(data);
  if (!joinUrl) throw new VideoProviderError(ERROR_CODES.CREATE_FAILED, 'Google Calendar no devolvió un link de Meet', { cause: data });

  return {
    meetingId: data.id,
    joinUrl,
    hostUrl: null, // Google Meet no diferencia host/join — el organizador entra con el mismo link, autenticado con su cuenta
    metadata: { calendarEventId: data.id, htmlLink: data.htmlLink || null },
    status: 'creada',
  };
}

async function updateMeeting(db, { mediatorUserId, hearing, mediation }) {
  if (!hearing.meetingId) return createMeeting(db, { mediatorUserId, hearing, mediation });
  const account = getAccount(db, mediatorUserId);
  if (!account || account.status !== 'conectado') {
    throw new VideoProviderError(ERROR_CODES.AUTH_REQUIRED, 'Conectá tu cuenta de Google Meet en Configuración → Videoconferencias');
  }
  const range = hearingTimeRange(hearing);
  if (!range) throw new VideoProviderError(ERROR_CODES.UPDATE_FAILED, 'La audiencia necesita fecha y hora para actualizar la reunión');
  const token = await ensureValidToken(db, account);
  const res = await fetch(`${CALENDAR_EVENTS_URL}/${encodeURIComponent(hearing.meetingId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: { dateTime: range.startISO }, end: { dateTime: range.endISO } }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404 || res.status === 410) throw new VideoProviderError(ERROR_CODES.NOT_FOUND, 'El evento de Calendar ya no existe', { cause: data });
  if (!res.ok) throw new VideoProviderError(ERROR_CODES.UPDATE_FAILED, 'Google Calendar rechazó la actualización de la reunión', { cause: data });
  const joinUrl = joinUrlFrom(data) || hearing.meetingUrl;
  return { joinUrl, hostUrl: null, metadata: { calendarEventId: data.id, htmlLink: data.htmlLink || null }, status: 'actualizada' };
}

async function cancelMeeting(db, { mediatorUserId, hearing }) {
  if (!hearing.meetingId) return { status: 'cancelada' };
  const account = getAccount(db, mediatorUserId);
  if (!account || account.status !== 'conectado') {
    // no bloquea la cancelación de la AUDIENCIA por esto — solo se informa
    // que la reunión externa puede haber quedado viva (spec §10).
    throw new VideoProviderError(ERROR_CODES.AUTH_REQUIRED, 'No se pudo cancelar la reunión en Google Calendar: la cuenta no está conectada');
  }
  const token = await ensureValidToken(db, account);
  const res = await fetch(`${CALENDAR_EVENTS_URL}/${encodeURIComponent(hearing.meetingId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const data = await res.json().catch(() => ({}));
    throw new VideoProviderError(ERROR_CODES.CANCEL_FAILED, 'Google Calendar rechazó la cancelación de la reunión', { cause: data });
  }
  return { status: 'cancelada' };
}

async function getStatus(db, mediatorUserId) {
  if (!configured()) return { status: 'no_configurada', accountEmail: null, lastError: null };
  const account = getAccount(db, mediatorUserId);
  if (!account) return { status: 'requiere_autorizacion', accountEmail: null, lastError: null };
  return { status: account.status, accountEmail: account.accountEmail || null, lastError: account.lastError || null };
}

async function isConfigured(db, mediatorUserId) {
  if (!configured()) return false;
  const account = getAccount(db, mediatorUserId);
  return !!account && account.status === 'conectado';
}

module.exports = {
  name: 'google_meet',
  label: 'Google Meet',
  perMediatorAccount: true,
  isConfigured,
  getStatus,
  createMeeting,
  updateMeeting,
  cancelMeeting,
  // usados solo por routes/video-providers.js (flujo de conexión OAuth) —
  // no forman parte del contrato VideoProvider genérico.
  configured,
  callbackUrl,
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUserEmail,
};
