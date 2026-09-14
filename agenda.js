// agenda.js
// Bloque 15 (Parte 1) — detección de conflictos de horario para
// audiencias. Función pura, sin acceso a Express — la llaman tanto
// routes/mediations.js (para bloquear crear/reprogramar) como
// routes/agenda.js (para armar la vista). Nada de esto crea una segunda
// tabla de audiencias: sigue leyendo directamente de hearings.

function toMinutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

// dos rangos [aStart,aEnd) y [bStart,bEnd) se solapan si aStart < bEnd Y
// bStart < aEnd — cubre superposición total, parcial, y "una empieza
// antes de que termine la otra" con la misma fórmula, sin casos especiales.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Chequea, para EL MEDIADOR RESPONSABLE de la mediación (no de quien está
// haciendo el pedido — un asistente puede estar agendando en nombre del
// mediador, el conflicto es siempre contra la agenda de quien queda
// como responsable de la audiencia):
//   1) otra audiencia suya que se superponga ese día
//   2) un bloqueo puntual suyo que se superponga
//   3) el horario pedido, si tiene disponibilidad configurada para ese
//      día de la semana, cae afuera de todos sus bloques disponibles
//      (si NO configuró nada para ese día, no se bloquea por esto —
//      "no asumir una jornada fija universal": sin configuración, no hay
//      restricción de disponibilidad, no un rechazo por defecto)
function checkHearingConflicts(db, { mediatorUserId, date, startTime, endTime, excludeHearingId }) {
  const conflicts = [];
  const reqStart = toMinutes(startTime);
  const reqEnd = toMinutes(endTime) ?? (reqStart != null ? reqStart + 60 : null); // sin endTime, asume 60' para el chequeo
  if (reqStart == null) return conflicts; // sin horario cargado, no hay nada que chequear todavía

  // 1) otras audiencias del mismo mediador, mismo día
  const sameDayHearings = db.hearings.filter((h) =>
    h.id !== excludeHearingId &&
    h.date === date &&
    ['programada', 'confirmada'].includes(h.status) &&
    db.mediations.find((m) => m.id === h.mediationId)?.mediatorUserId === mediatorUserId
  );
  for (const h of sameDayHearings) {
    const hStart = toMinutes(h.startTime);
    if (hStart == null) continue;
    const hEnd = toMinutes(h.endTime) ?? hStart + 60;
    if (rangesOverlap(reqStart, reqEnd, hStart, hEnd)) {
      conflicts.push({ type: 'hearing', hearingId: h.id, date: h.date, startTime: h.startTime, endTime: h.endTime });
    }
  }

  // 2) bloqueos puntuales
  const blocksThatDay = db.mediatorScheduleBlocks.filter((b) => b.userId === mediatorUserId && b.date === date);
  for (const b of blocksThatDay) {
    const bStart = toMinutes(b.startTime);
    const bEnd = toMinutes(b.endTime);
    if (bStart == null || bEnd == null) continue;
    if (rangesOverlap(reqStart, reqEnd, bStart, bEnd)) {
      conflicts.push({ type: 'block', blockId: b.id, startTime: b.startTime, endTime: b.endTime, reason: b.reason });
    }
  }

  // 3) disponibilidad configurada para ese día de la semana (si existe)
  const dow = new Date(date + 'T00:00:00').getDay();
  const availabilityThatDay = db.mediatorAvailability.filter((a) => a.userId === mediatorUserId && a.dayOfWeek === dow);
  if (availabilityThatDay.length > 0) {
    const fitsSomeBlock = availabilityThatDay.some((a) => {
      const aStart = toMinutes(a.startTime);
      const aEnd = toMinutes(a.endTime);
      return aStart != null && aEnd != null && reqStart >= aStart && reqEnd <= aEnd;
    });
    if (!fitsSomeBlock) {
      conflicts.push({ type: 'outside_availability', dayOfWeek: dow });
    }
  }

  return conflicts;
}

module.exports = { checkHearingConflicts, toMinutes, rangesOverlap };
