// ics.js
// Generadores de feed iCalendar (RFC 5545) de solo lectura — sin
// dependencias externas, funciones puras sin acceso a Express ni a la DB
// (cada ruta arma la lista de eventos/audiencias, esto solo las convierte
// a texto). Dos usos distintos que comparten el mismo formato:
//   - buildCalendarFeed: coparentalidad — eventos confirmados de un canal
//     (routes/channels.js GET /:code/calendar.ics)
//   - buildHearingsIcsFeed: Mediador — audiencias de un mediador
//     (routes/agenda.js GET /feed.ics)

// escapa texto para un campo ICS (RFC 5545 §3.3.11) — sin esto, una coma o
// un punto y coma en el texto rompería el parseo del archivo entero en el
// cliente de calendario.
function icsEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// ================= coparentalidad (canal) =================

function addDaysToYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return (
    dt.getUTCFullYear().toString().padStart(4, '0') +
    (dt.getUTCMonth() + 1).toString().padStart(2, '0') +
    dt.getUTCDate().toString().padStart(2, '0')
  );
}

function formatStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// eventos ya filtrados/serializados: [{ id, date:'YYYY-MM-DD', detail, requestedBy:{name}, createdAt }]
function buildCalendarFeed(channelCode, events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Puente Digital//Calendario compartido//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:Puente Digital — ${channelCode}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  events.forEach((ev) => {
    const start = ev.date.replace(/-/g, '');
    const end = addDaysToYmd(ev.date, 1);
    const who = ev.requestedBy ? ev.requestedBy.name : null;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.id}@puente-digital`,
      `DTSTAMP:${formatStamp(ev.createdAt)}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${icsEscape(ev.detail)}`,
      `DESCRIPTION:${icsEscape('Confirmado en Puente Digital.' + (who ? ' Pedido por ' + who + '.' : ''))}`,
      'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ================= Mediador (audiencias) =================

// Buenos Aires es UTC-3 fijo, sin horario de verano desde 2009 (mismo
// criterio que ya usa agenda.js) — convertir a UTC es sumar 3 horas, sin
// necesitar Intl ni una librería de zonas horarias.
const ART_OFFSET_MINUTES = 3 * 60;
const DEFAULT_DURATION_MINUTES = 60; // mismo default que checkHearingConflicts en agenda.js cuando no hay endTime

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

// "YYYY-MM-DD" + "HH:MM" (hora de Buenos Aires) -> "YYYYMMDDTHHMMSSZ" (UTC)
function toIcsUtcDateTime(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const utcMs = Date.UTC(y, mo - 1, d, h, mi, 0) + ART_OFFSET_MINUTES * 60 * 1000;
  const dt = new Date(utcMs);
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}${pad(dt.getUTCSeconds())}Z`;
}

function toIcsDate(dateStr) {
  return dateStr.replace(/-/g, '');
}

// un día calendario después, para DTEND;VALUE=DATE de un evento de todo el día
function nextIcsDate(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return `${next.getUTCFullYear()}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`;
}

function nowIcsUtc() {
  const dt = new Date();
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}${pad(dt.getUTCSeconds())}Z`;
}

const HEARING_MODALITY_LABELS = { presencial: 'Presencial', virtual: 'Virtual', hibrida: 'Híbrida' };

function addMinutesToTime(hhmm, minutesToAdd) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutesToAdd;
  return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
}

function buildHearingEvent(h) {
  const lines = ['BEGIN:VEVENT', `UID:hearing-${h.id}@mediador.puentedigital`, `DTSTAMP:${nowIcsUtc()}`];

  if (h.startTime) {
    const endTime = h.endTime || addMinutesToTime(h.startTime, DEFAULT_DURATION_MINUTES);
    lines.push(`DTSTART:${toIcsUtcDateTime(h.date, h.startTime)}`);
    lines.push(`DTEND:${toIcsUtcDateTime(h.date, endTime)}`);
  } else {
    // sin horario cargado todavía: se muestra como evento de todo el día,
    // no se inventa un horario que nadie confirmó.
    lines.push(`DTSTART;VALUE=DATE:${toIcsDate(h.date)}`);
    lines.push(`DTEND;VALUE=DATE:${nextIcsDate(h.date)}`);
  }

  lines.push(`SUMMARY:${icsEscape(`Audiencia — ${h.mediationCode}`)}`);
  const descriptionParts = [
    h.mediationObject ? `Objeto: ${h.mediationObject}` : null,
    `Modalidad: ${HEARING_MODALITY_LABELS[h.modality] || h.modality}`,
  ].filter(Boolean);
  lines.push(`DESCRIPTION:${icsEscape(descriptionParts.join('\n'))}`);
  const location = h.modality === 'virtual' ? h.meetingUrl : h.location;
  if (location) lines.push(`LOCATION:${icsEscape(location)}`);
  lines.push('STATUS:CONFIRMED');
  lines.push('END:VEVENT');
  return lines;
}

// hearings: lista ya resuelta por routes/agenda.js — acá solo se filtran
// las que tiene sentido mostrar en un calendario: una "propuesta" todavía
// no es una audiencia real, una "cancelada"/"no_realizada" no debería
// seguir ocupando un horario en el calendario de nadie.
const CALENDAR_STATUSES = new Set(['programada', 'confirmada', 'realizada']);

function buildHearingsIcsFeed(hearings, { calendarName }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Puente Digital//Mediador//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calendarName)}`,
    'X-WR-TIMEZONE:America/Argentina/Buenos_Aires',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];
  hearings
    .filter((h) => CALENDAR_STATUSES.has(h.status))
    .forEach((h) => { lines.push(...buildHearingEvent(h)); });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

module.exports = { buildCalendarFeed, buildHearingsIcsFeed };
