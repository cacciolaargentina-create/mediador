// ics.js
// Genera un feed .ics (RFC 5545) de solo lectura con los eventos confirmados
// de un canal, para suscribir desde Apple Calendar (iPhone/Mac) o Google
// Calendar — así los horarios/entregas acordados aparecen solos, sin que
// nadie tenga que cargarlos a mano dos veces.

function icsEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

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

module.exports = { buildCalendarFeed };
