// legalDeadlines.js
// Bloque 43 — motor de cómputo de las 3 reglas de plazo de ámbito nacional
// (spec §4). Funciones puras: reciben `db` y la mediación ya resuelta, la
// autorización de quién puede verlas es responsabilidad de quien llama
// (mismo criterio que automationEngine.js). TODO cómputo en días hábiles
// pasa por businessCalendar.js — nunca se suma un día a mano acá.
//
// Reutiliza: parties.role==='requerido' (ya existía), documents (prueba de
// notificación, vía partyNotifications.documentId), mediation.closedAt
// (Bloque 34, acta de cierre automática) para la regla del acta. No crea
// ningún sistema paralelo de alertas — automationEngine.js consume estas
// funciones para sus propios detectores.

const { addBusinessDays, businessDaysBetween, addCalendarDays, calendarDaysBetween, dateToStr } = require('./businessCalendar');
const { getJurisdictionRules } = require('./jurisdictionRules');

function partyDisplayName(p) {
  if (!p) return null;
  return p.legalName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || null;
}

function todayStr() {
  return dateToStr(new Date());
}

// notificación "efectiva" de una parte: la más reciente con status
// 'recibida' y receivedDate cargado. Una notificación 'rechazada' o
// 'no_localizado' NO cuenta como efectiva a los fines del cómputo — spec
// §5: "mientras una parte no tenga notificación registrada [entendido acá
// como: registrada Y EFECTIVA], su plazo se muestra como 'no iniciado'".
// Esta es la lectura conservadora explícitamente preferida por el pedido
// del usuario ("prefiero un plazo menos y bien, que tres mal"): una carta
// rechazada/no localizada no arranca el plazo sola, requiere seguimiento
// (ver automationEngine.js, detector de notificación sin seguimiento).
function effectiveNotification(notifications) {
  const sorted = [...notifications].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].status === 'recibida' && sorted[i].receivedDate) return sorted[i];
  }
  return null;
}

function lastNotification(notifications) {
  if (!notifications.length) return null;
  return [...notifications].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(-1)[0];
}

// ---- 4.1 Plazo de la mediación (60 días CORRIDOS desde la última
// notificación a los requeridos — art. 20, Ley 26.589), con prórrogas y
// corrección manual ----
function computeMediationDeadline(db, mediation) {
  const rules = getJurisdictionRules(mediation.jurisdiction);
  if (!rules) {
    return { calculable: false, reason: 'No hay jurisdicción cargada para esta mediación — no se puede calcular el plazo.' };
  }
  const requeridos = db.parties.filter((p) => p.mediationId === mediation.id && p.role === 'requerido' && p.status !== 'inactiva');
  if (requeridos.length === 0) {
    return { calculable: false, reason: 'No hay partes con rol "requerido" cargadas en esta mediación.' };
  }

  const partyInfo = requeridos.map((p) => {
    const notifications = db.partyNotifications.filter((n) => n.partyId === p.id);
    return { party: p, notifications, effective: effectiveNotification(notifications), last: lastNotification(notifications) };
  });
  const pending = partyInfo.filter((pi) => !pi.effective);

  let startDate = null;
  let startExplanation = null;
  const manualOverride = !!mediation.deadlineStartOverride;
  if (manualOverride) {
    startDate = mediation.deadlineStartOverride;
    startExplanation = `Fecha corregida manualmente${mediation.deadlineStartOverrideReason ? ` — ${mediation.deadlineStartOverrideReason}` : ''} (el cómputo automático por notificación queda reemplazado por esta fecha hasta que se saque la corrección)`;
  } else if (pending.length === 0) {
    let latest = partyInfo[0];
    for (const pi of partyInfo) {
      if (pi.effective.receivedDate > latest.effective.receivedDate) latest = pi;
    }
    startDate = latest.effective.receivedDate;
    startExplanation = `${rules.mediationTermCalendarDays} días corridos desde la notificación a ${partyDisplayName(latest.party) || 'la parte requerida'}, recibida el ${latest.effective.receivedDate}${partyInfo.length > 1 ? ' (la más reciente entre todos los requeridos)' : ''}`;
  }

  let deadlineDate = null;
  const explanationLines = [];
  const extensions = db.mediationDeadlineExtensions
    .filter((e) => e.mediationId === mediation.id)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  if (startDate) {
    deadlineDate = addCalendarDays(startDate, rules.mediationTermCalendarDays);
    explanationLines.push(startExplanation);
    for (const ext of extensions) {
      if (ext.newDeadlineDate) {
        deadlineDate = ext.newDeadlineDate;
        explanationLines.push(`Prórroga acordada el ${ext.agreedDate}: nueva fecha límite ${ext.newDeadlineDate}${ext.reason ? ` (${ext.reason})` : ''}`);
      } else if (ext.days) {
        deadlineDate = addCalendarDays(deadlineDate, ext.days);
        explanationLines.push(`Prórroga acordada el ${ext.agreedDate}: +${ext.days} días corridos${ext.reason ? ` (${ext.reason})` : ''}`);
      }
    }
  }

  const today = todayStr();
  const elapsedCalendarDays = startDate ? calendarDaysBetween(startDate, today) : null;
  const remainingCalendarDays = deadlineDate ? calendarDaysBetween(today, deadlineDate) : null;

  return {
    calculable: true,
    jurisdiction: rules.code,
    jurisdictionLabel: rules.label,
    parties: partyInfo.map((pi) => ({
      partyId: pi.party.id,
      name: partyDisplayName(pi.party),
      notified: !!pi.effective,
      effectiveNotification: pi.effective || null,
      lastNotification: pi.last || null,
    })),
    pendingPartyIds: pending.map((pi) => pi.party.id),
    started: !!startDate,
    computationStart: startDate,
    computationStartExplanation: startExplanation,
    computationStartManuallyOverridden: manualOverride,
    termCalendarDays: rules.mediationTermCalendarDays,
    elapsedCalendarDays,
    remainingCalendarDays,
    deadlineDate,
    extensions,
    explanation: explanationLines,
  };
}

// ---- 4.2 Aviso de audiencia: mínimo 3 días hábiles de anticipación ----
// LIMITACIÓN reconocida (ver jurisdictionRules.js): el sistema no registra
// todavía una fecha de "notificación de ESTA audiencia puntual" por parte
// (solo existe ese registro para la notificación de inicio de mediación,
// via partyNotifications). Como proxy honesto — y solo como advertencia,
// NUNCA bloqueante (spec §4.2) — se compara el momento en que se programa/
// reprograma la audiencia contra su fecha: si entre ambos no hay al menos
// los días hábiles mínimos, es matemáticamente imposible que la notificación
// llegue a tiempo, así que se avisa. Cuando exista un registro específico
// de notificación de audiencia, este cálculo debería migrar a usarlo.
function checkHearingNotice(db, mediation, hearingDateStr, scheduledAtMs = Date.now()) {
  const rules = getJurisdictionRules(mediation.jurisdiction);
  if (!rules) return { calculable: false, reason: 'Sin jurisdicción cargada.' };
  const scheduledDateStr = dateToStr(new Date(scheduledAtMs));
  const availableBusinessDays = businessDaysBetween(db, scheduledDateStr, hearingDateStr);
  const meetsMinimum = availableBusinessDays >= rules.hearingNoticeBusinessDays;
  return {
    calculable: true,
    requiredBusinessDays: rules.hearingNoticeBusinessDays,
    availableBusinessDays,
    meetsMinimum,
    explanation: `Entre la programación (${scheduledDateStr}) y la audiencia (${hearingDateStr}) hay ${availableBusinessDays} día(s) hábil(es); la Ley 26.589 exige un mínimo de ${rules.hearingNoticeBusinessDays}.`,
  };
}

// ---- 4.3 Acta de cierre: la prescripción se reanuda a los 20 días
// corridos desde que el acta queda a disposición de las partes ----
function computeActaDisponibilidad(db, mediation) {
  const rules = getJurisdictionRules(mediation.jurisdiction);
  if (!rules) return null;
  if (!mediation.closedAt) return null;
  const availableDateStr = dateToStr(new Date(mediation.closedAt));
  const availableDate = new Date(mediation.closedAt);
  const resumeDate = new Date(availableDate.getTime() + rules.actaDisponibilidadCalendarDays * 86400000);
  const resumeDateStr = dateToStr(resumeDate);
  const nowMs = Date.now();
  const calendarDaysElapsed = Math.floor((nowMs - availableDate.getTime()) / 86400000);
  return {
    calculable: true,
    actaDisponibleDate: availableDateStr,
    calendarDays: rules.actaDisponibilidadCalendarDays,
    resumeDate: resumeDateStr,
    calendarDaysElapsed,
    reached: nowMs >= resumeDate.getTime(),
    explanation: `El acta quedó a disposición de las partes el ${availableDateStr} (fecha de cierre de la mediación); la prescripción se reanuda ${rules.actaDisponibilidadCalendarDays} días corridos después, el ${resumeDateStr}.`,
  };
}

module.exports = { computeMediationDeadline, checkHearingNotice, computeActaDisponibilidad, partyDisplayName };
