// automationEngine.js
// Bloque 22 — motor central de atención: DETECTAR → PROPONER → CONFIRMAR
// → EJECUTAR → REGISTRAR. Este módulo SOLO detecta y arma la sugerencia
// de acción — nunca ejecuta nada por sí solo (nunca crea una tarea, nunca
// manda un mensaje, nunca cierra una mediación). La ejecución real sigue
// pasando por los endpoints ya existentes de routes/mediations.js cuando
// el mediador confirma una acción puntual.
//
// Funciones puras: reciben `db` y datos ya resueltos (mediación,
// mediaciones del usuario, etc.) — la autorización (qué mediaciones puede
// ver este usuario) es responsabilidad de quien llama, exactamente igual
// que mediationAccess.js. Esto es lo que las hace testeables sin pasar
// por Express ni por sesión.
//
// La mayoría de estos detectores YA existían, calculados en línea dentro
// de GET /api/mediations/dashboard desde distintos bloques (11, 15, 16,
// 17, 19). Acá se centralizan sin cambiar su criterio — routes/
// mediations.js pasa a llamarlos en vez de tener la lógica embebida.

const DEFAULT_INACTIVITY_THRESHOLD_DAYS = 21;
const DEFAULT_PARTY_NO_RESPONSE_THRESHOLD_DAYS = 5;
const UNACTIONED_MESSAGE_WINDOW_DAYS = 14; // más viejo que esto ya no es "algo para atender hoy"

function daysBetween(fromMs, toMs) {
  return (toMs - fromMs) / (1000 * 60 * 60 * 24);
}

function partyDisplayName(db, partyId) {
  const p = db.parties.find((x) => x.id === partyId);
  if (!p) return null;
  return p.legalName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || null;
}

// ================= detectores por mediación (ya existentes, centralizados) =================

function mediationMissingNextAction(mediation) {
  return !mediation.nextActionText || !mediation.nextActionText.trim();
}

function mediationNextActionOverdue(mediation, now = Date.now()) {
  return !!(mediation.nextActionDueDate && new Date(mediation.nextActionDueDate).getTime() < now);
}

function getOverdueTasks(db, mediationIds, now = Date.now()) {
  return db.tasks.filter((t) => mediationIds.has(t.mediationId) && ['pendiente', 'en_proceso'].includes(t.status) && t.dueDate && new Date(t.dueDate).getTime() < now);
}

function getOverdueCommitments(db, mediationIds, now = Date.now()) {
  return db.commitments.filter((c) => mediationIds.has(c.mediationId) && (c.status === 'vencido' || (c.status === 'pendiente' && c.dueDate && new Date(c.dueDate).getTime() < now)));
}

// audiencias programadas/confirmadas con al menos una confirmación pendiente
function getHearingsWithPendingConfirmations(db, mediationIds) {
  return db.hearings.filter((h) => mediationIds.has(h.mediationId) && ['programada', 'confirmada'].includes(h.status)
    && db.hearingConfirmations.some((c) => c.hearingId === h.id && c.response === 'pendiente'));
}

function getPendingConfirmations(db, hearingId) {
  return db.hearingConfirmations.filter((c) => c.hearingId === hearingId && c.response === 'pendiente');
}

function getPendingRescheduleRequests(db, mediationIds) {
  return db.hearingRescheduleRequests.filter((r) => mediationIds.has(r.mediationId) && r.status === 'pendiente');
}

function getDocumentsPendingReview(db, mediationIds) {
  return db.documents.filter((d) => mediationIds.has(d.mediationId) && d.status === 'recibido');
}

// pasó la fecha y la audiencia sigue "programada"/"confirmada" — nadie
// registró qué pasó (§12).
function getHearingsWithoutResult(db, mediationIds, now = Date.now()) {
  return db.hearings.filter((h) => mediationIds.has(h.mediationId) && ['programada', 'confirmada'].includes(h.status) && h.date < new Date(now).toISOString().slice(0, 10));
}

// realizada, pero la mediación sigue sin próxima acción cargada (§13).
function getHearingsDoneWithoutNextAction(db, mediationIds, mediationById) {
  return db.hearings.filter((h) => mediationIds.has(h.mediationId) && h.status === 'realizada' && mediationMissingNextAction(mediationById[h.mediationId] || {}));
}

// ================= detectores nuevos de Bloque 22 =================

// §10/14 — mediación activa sin ninguna señal de actividad reciente:
// último mediation_event O último mensaje en cualquiera de sus hilos, lo
// que sea más nuevo. Umbral configurable por mediación
// (mediation.inactivityThresholdDays), default 21 días. Nunca asume
// abandono — es una alerta para que el mediador la revise, nada más.
function getLastActivityAt(db, mediationId) {
  let last = 0;
  for (const e of db.mediationEvents) if (e.mediationId === mediationId && e.createdAt > last) last = e.createdAt;
  const channelIds = new Set(db.channels.filter((c) => c.mediationId === mediationId).map((c) => c.id));
  for (const m of db.messages) if (channelIds.has(m.channelId) && m.createdAt > last) last = m.createdAt;
  return last || null;
}

function getInactiveMediations(db, mediations, now = Date.now()) {
  const out = [];
  for (const m of mediations) {
    if (m.closedAt || m.status === 'borrador') continue;
    const thresholdDays = m.inactivityThresholdDays || DEFAULT_INACTIVITY_THRESHOLD_DAYS;
    const lastActivity = getLastActivityAt(db, m.id) || m.createdAt;
    if (daysBetween(lastActivity, now) < thresholdDays) continue;
    // descartada mientras no haya actividad NUEVA desde que se descartó
    // (si hay actividad nueva, lastActivity ya cambió y esto deja de
    // aplicar — ver comentario largo en dismiss endpoint).
    if (isAlertDismissed(db, m.id, 'mediacionInactiva', m.id, lastActivity)) continue;
    out.push({ mediation: m, lastActivityAt: lastActivity, thresholdDays });
  }
  return out;
}

// §13 (dashboard) — "comunicación recibida que todavía no generó una
// acción": un mensaje de una parte o abogado (nunca del propio equipo
// mediador) cuyo id no aparece como sourceMessageId de ninguna tarea,
// compromiso o solicitud de reprogramación, dentro de una ventana
// reciente (los mensajes viejos ya dejaron de ser "algo para hoy").
function getUnactionedIncomingMessages(db, mediation, now = Date.now()) {
  const threadTypes = new Map(); // channelId -> 'parte'|'abogado'
  for (const c of db.channels) {
    if (c.mediationId !== mediation.id) continue;
    if (c.partyId) threadTypes.set(c.id, { type: 'parte', participantId: c.partyId });
    else if (c.lawyerId) threadTypes.set(c.id, { type: 'abogado', participantId: c.lawyerId });
    // el canal interno (sin partyId ni lawyerId) nunca cuenta acá — nadie
    // "externo" escribe ahí.
  }
  if (threadTypes.size === 0) return [];

  const usedMessageIds = new Set([
    ...db.tasks.filter((t) => t.sourceMessageId).map((t) => t.sourceMessageId),
    ...db.commitments.filter((c) => c.sourceMessageId).map((c) => c.sourceMessageId),
    ...db.hearingRescheduleRequests.filter((r) => r.sourceMessageId).map((r) => r.sourceMessageId),
  ]);

  const windowStart = now - UNACTIONED_MESSAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const out = [];
  for (const m of db.messages) {
    const thread = threadTypes.get(m.channelId);
    if (!thread || !m.senderId) continue;
    // el remitente tiene que ser la parte/abogado dueño/a de ESE hilo, no
    // el mediador escribiéndose a sí mismo en su propio canal.
    const isFromCounterpart = thread.type === 'parte'
      ? db.parties.find((p) => p.id === thread.participantId)?.linkedUserId === m.senderId
      : db.lawyers.find((l) => l.id === thread.participantId)?.linkedUserId === m.senderId;
    if (!isFromCounterpart) continue;
    if (m.createdAt < windowStart) continue;
    if (usedMessageIds.has(m.id)) continue;
    out.push({ message: m, threadType: thread.type, participantId: thread.participantId });
  }
  return out;
}

// §10 — "sin respuesta durante N días": el último mensaje del hilo
// mediador↔parte lo mandó el equipo mediador (nunca la parte), y pasó el
// umbral configurable sin que la parte contestara. Nunca se interpreta
// como incumplimiento — es una alerta de contacto, no un juicio. Respeta
// "descartar alerta": si se descartó DESPUÉS del último mensaje relevante,
// no se vuelve a mostrar hasta que la situación cambie (llegue un mensaje
// nuevo de cualquiera de los dos lados).
function getPartiesWithNoResponse(db, mediation, now = Date.now()) {
  const thresholdDays = mediation.partyNoResponseThresholdDays || DEFAULT_PARTY_NO_RESPONSE_THRESHOLD_DAYS;
  const out = [];
  for (const party of db.parties.filter((p) => p.mediationId === mediation.id && p.status === 'activa')) {
    const thread = db.channels.find((c) => c.mediationId === mediation.id && c.partyId === party.id);
    if (!thread || !party.linkedUserId) continue; // nunca invitada al portal — no hay "falta de respuesta" que detectar
    const msgs = db.messages.filter((m) => m.channelId === thread.id).sort((a, b) => a.createdAt - b.createdAt);
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    if (last.senderId === party.linkedUserId) continue; // la última palabra la tuvo la parte — no aplica
    if (daysBetween(last.createdAt, now) < thresholdDays) continue;
    if (isAlertDismissed(db, mediation.id, 'partyNoResponse', party.id, last.createdAt)) continue;
    out.push({ party, lastMessageAt: last.createdAt, thresholdDays });
  }
  return out;
}

// §14 (motor) — la mediación llegó a un resultado de audiencia/cierre
// (acuerdo, acuerdo parcial, sin acuerdo, incomparecencia) pero nunca se
// pasó por el flujo explícito de cierre (POST /:id/close, que setea
// closedAt) — falta un paso administrativo, no una decisión de fondo.
const CLOSURE_WORTHY_STATUSES = ['acuerdo', 'acuerdo_parcial', 'sin_acuerdo', 'incomparecencia'];
function getMediationsRequiringClosure(mediations) {
  return mediations.filter((m) => !m.closedAt && CLOSURE_WORTHY_STATUSES.includes(m.status));
}

// ================= "descartar alerta" =================

function isAlertDismissed(db, mediationId, alertType, refId, sinceTimestamp) {
  return db.attentionDismissals.some((d) =>
    d.mediationId === mediationId && d.alertType === alertType && d.refId === refId && d.dismissedAt >= sinceTimestamp
  );
}

// ================= preparación de audiencia (Bloque 15, movido acá tal cual) =================

const PREPARATION_ITEM_LABELS_ES = {
  partesIdentificadas: 'Partes identificadas', datosDeContacto: 'Datos de contacto', abogadosVinculados: 'Abogados vinculados',
  confirmaciones: 'Confirmaciones', documentosPendientesRevision: 'Documentos sin revisar', tareasPendientes: 'Tareas pendientes',
  compromisosPendientes: 'Compromisos pendientes', modalidadDatos: 'Datos de modalidad', solicitudesDeCambio: 'Solicitudes de cambio',
};
function validateModalityData(modality, location, meetingUrl) {
  if (modality === 'virtual' && !meetingUrl) return 'Modalidad virtual requiere un link de reunión (meetingUrl)';
  return null;
}
function getHearingPreparationState(db, mediation, hearing) {
  const parties = db.parties.filter((p) => p.mediationId === mediation.id && p.status === 'activa');
  const lawyers = db.lawyers.filter((l) => l.mediationId === mediation.id);
  const confirmations = db.hearingConfirmations.filter((c) => c.hearingId === hearing.id);
  const allConfirmed = confirmations.length > 0 && confirmations.every((c) => c.response === 'confirma');
  const documentsPendingReview = db.documents.filter((d) => d.mediationId === mediation.id && d.status === 'recibido');
  const pendingTasks = db.tasks.filter((t) => t.mediationId === mediation.id && ['pendiente', 'en_proceso'].includes(t.status));
  const criticalPendingTasks = pendingTasks.filter((t) => ['alta', 'urgente'].includes(t.priority));
  const pendingCommitments = db.commitments.filter((c) => c.mediationId === mediation.id && ['pendiente', 'vencido'].includes(c.status));
  const pendingRequests = db.hearingRescheduleRequests.filter((r) => r.hearingId === hearing.id && r.status === 'pendiente');
  const modalityIssue = validateModalityData(hearing.modality, hearing.location, hearing.meetingUrl);

  const items = {
    partesIdentificadas: { status: parties.length > 0 ? 'realizado' : 'pendiente', detail: `${parties.length} parte(s)` },
    datosDeContacto: { status: parties.length > 0 && parties.every((p) => p.email || p.phone) ? 'realizado' : (parties.length ? 'pendiente' : 'no_corresponde') },
    abogadosVinculados: { status: lawyers.length > 0 ? 'realizado' : 'no_corresponde', detail: `${lawyers.length} abogado(s)` },
    confirmaciones: { status: confirmations.length === 0 ? 'no_corresponde' : (allConfirmed ? 'realizado' : 'pendiente'), detail: `${confirmations.filter((c) => c.response === 'confirma').length}/${confirmations.length} confirmaron` },
    documentosPendientesRevision: { status: documentsPendingReview.length === 0 ? 'realizado' : 'pendiente', detail: `${documentsPendingReview.length} sin revisar` },
    tareasPendientes: { status: pendingTasks.length === 0 ? 'realizado' : 'pendiente', detail: `${pendingTasks.length} pendiente(s)${criticalPendingTasks.length ? ` (${criticalPendingTasks.length} crítica(s))` : ''}` },
    compromisosPendientes: { status: pendingCommitments.length === 0 ? 'realizado' : 'pendiente', detail: `${pendingCommitments.length} pendiente(s)` },
    modalidadDatos: { status: modalityIssue ? 'pendiente' : 'realizado', detail: modalityIssue || 'Datos completos para la modalidad' },
    solicitudesDeCambio: { status: pendingRequests.length === 0 ? 'realizado' : 'pendiente', detail: `${pendingRequests.length} sin resolver` },
  };

  const pendingKeys = Object.keys(items).filter((k) => items[k].status === 'pendiente');
  // "tareasPendientes" se suma a la lista de críticos cuando lo pendiente
  // incluye al menos una tarea de prioridad alta/urgente (Bloque 22 §4 —
  // "audiencia próxima con tareas críticas pendientes").
  const criticalKeys = ['confirmaciones', 'modalidadDatos', 'solicitudesDeCambio', ...(criticalPendingTasks.length ? ['tareasPendientes'] : [])]
    .filter((k) => items[k].status === 'pendiente');
  const daysUntil = daysBetween(Date.now(), new Date(hearing.date).getTime());
  const itemLabel = (k) => PREPARATION_ITEM_LABELS_ES[k] || k;

  let estado, motivo;
  if (pendingKeys.length === 0) {
    estado = 'preparada'; motivo = 'No existen bloqueos operativos relevantes.';
  } else if (daysUntil <= 2 && criticalKeys.length > 0) {
    estado = 'critica'; motivo = `La audiencia es en ${Math.max(0, Math.round(daysUntil))} día(s) y hay pendientes importantes: ${criticalKeys.map(itemLabel).join(', ')}.`;
  } else {
    estado = 'pendiente'; motivo = `Hay elementos que todavía requieren revisión: ${pendingKeys.map(itemLabel).join(', ')}.`;
  }
  return { items, estado, motivo, criticalPendingTasksCount: criticalPendingTasks.length };
}

// ================= feed combinado (§1/§2 — centro de atención) =================
// Arma una lista PLANA y normalizada { type, mediationId, mediationCode,
// title, detail, priority, dueDate, refId, suggestedActions } combinando
// TODAS las situaciones detectadas — la misma forma para el dashboard
// (todas las mediaciones de un usuario) y para el expediente de una sola
// mediación. Prioridad fija (no ranking/puntaje, spec §15): vencido >
// crítico > próximo > pendiente.

const PRIORITY = { vencido: 1, critico: 2, proximo: 3, pendiente: 4 };

function buildAttentionItems(db, mediations, { includeInactive = true } = {}) {
  const now = Date.now();
  const mediationById = Object.fromEntries(mediations.map((m) => [m.id, m]));
  const mediationIds = new Set(mediations.map((m) => m.id));
  const items = [];

  for (const m of mediations) {
    if (m.closedAt || m.status === 'borrador') continue;
    if (mediationMissingNextAction(m)) {
      items.push({ type: 'sinProximaAccion', mediationId: m.id, mediationCode: m.code, title: 'Sin próxima acción definida', detail: 'La mediación está activa pero no tiene próxima acción cargada.', priority: 'pendiente', dueDate: null, refId: m.id, suggestedActions: ['definirProximaAccion', 'verMediacion'] });
    } else if (mediationNextActionOverdue(m, now)) {
      items.push({ type: 'proximaAccionVencida', mediationId: m.id, mediationCode: m.code, title: 'Próxima acción vencida', detail: m.nextActionText, priority: 'vencido', dueDate: m.nextActionDueDate, refId: m.id, suggestedActions: ['verMediacion', 'definirProximaAccion'] });
    }
  }

  for (const t of getOverdueTasks(db, mediationIds, now)) {
    items.push({ type: 'tareaVencida', mediationId: t.mediationId, mediationCode: mediationById[t.mediationId]?.code, title: t.title, detail: `Vencida el ${t.dueDate}`, priority: 'vencido', dueDate: t.dueDate, refId: t.id, suggestedActions: ['completarTarea', 'editarTarea', 'verMediacion'] });
  }

  for (const c of getOverdueCommitments(db, mediationIds, now)) {
    items.push({ type: 'compromisoVencido', mediationId: c.mediationId, mediationCode: mediationById[c.mediationId]?.code, title: `${partyDisplayName(db, c.partyId) || 'Parte'}: ${c.description}`, detail: `Vencido el ${c.dueDate}`, priority: 'vencido', dueDate: c.dueDate, refId: c.id, suggestedActions: ['contactarParte', 'marcarCompletado', 'ver'] });
  }

  for (const h of getHearingsWithPendingConfirmations(db, mediationIds)) {
    const pending = getPendingConfirmations(db, h.id).length;
    const daysUntil = daysBetween(now, new Date(h.date).getTime());
    items.push({ type: 'audienciaSinConfirmar', mediationId: h.mediationId, mediationCode: mediationById[h.mediationId]?.code, title: `Audiencia ${h.date}${h.startTime ? ' ' + h.startTime : ''}`, detail: `Faltan ${pending} confirmación(es).`, priority: daysUntil <= 2 ? 'critico' : 'proximo', dueDate: h.date, refId: h.id, suggestedActions: ['enviarAviso', 'verMediacion'] });
  }

  for (const r of getPendingRescheduleRequests(db, mediationIds)) {
    items.push({ type: 'solicitudCambioPendiente', mediationId: r.mediationId, mediationCode: mediationById[r.mediationId]?.code, title: 'Solicitud de cambio de audiencia sin resolver', detail: r.reason || null, priority: 'pendiente', dueDate: null, refId: r.id, suggestedActions: ['resolver', 'verMediacion'] });
  }

  for (const d of getDocumentsPendingReview(db, mediationIds)) {
    items.push({ type: 'documentoPendienteRevision', mediationId: d.mediationId, mediationCode: mediationById[d.mediationId]?.code, title: d.originalFilename, detail: 'Documento recibido, sin revisar.', priority: 'pendiente', dueDate: null, refId: d.id, suggestedActions: ['crearTarea', 'verDocumento'] });
  }

  for (const h of getHearingsWithoutResult(db, mediationIds, now)) {
    items.push({ type: 'audienciaSinResultado', mediationId: h.mediationId, mediationCode: mediationById[h.mediationId]?.code, title: `Audiencia del ${h.date} sin resultado registrado`, detail: 'La fecha ya pasó y nadie registró qué pasó.', priority: 'critico', dueDate: h.date, refId: h.id, suggestedActions: ['registrarResultado', 'verMediacion'] });
  }

  for (const h of getHearingsDoneWithoutNextAction(db, mediationIds, mediationById)) {
    items.push({ type: 'audienciaSinProximaAccion', mediationId: h.mediationId, mediationCode: mediationById[h.mediationId]?.code, title: 'Audiencia realizada sin próxima acción', detail: `La audiencia del ${h.date} terminó y la mediación sigue sin próxima acción.`, priority: 'critico', dueDate: null, refId: h.id, suggestedActions: ['definirProximaAccion'] });
  }

  if (includeInactive) {
    for (const { mediation, lastActivityAt, thresholdDays } of getInactiveMediations(db, mediations, now)) {
      const lastDate = new Date(lastActivityAt);
      items.push({ type: 'mediacionInactiva', mediationId: mediation.id, mediationCode: mediation.code, title: 'Sin actividad reciente', detail: `Esta mediación no registra actividad desde el ${lastDate.toLocaleDateString('es-AR')} (umbral: ${thresholdDays} días).`, priority: 'pendiente', dueDate: null, refId: mediation.id, suggestedActions: ['verMediacion', 'registrarActividad', 'crearTarea', 'descartar'] });
    }
  }

  for (const m of getMediationsRequiringClosure(mediations)) {
    items.push({ type: 'requiereCierre', mediationId: m.id, mediationCode: m.code, title: 'Esta mediación parece lista para cerrarse', detail: `Estado actual: ${m.status}, sin fecha de cierre registrada.`, priority: 'pendiente', dueDate: null, refId: m.id, suggestedActions: ['cerrarMediacion', 'verMediacion'] });
  }

  for (const m of mediations) {
    for (const { message, threadType, participantId } of getUnactionedIncomingMessages(db, m, now)) {
      items.push({ type: 'comunicacionSinAccion', mediationId: m.id, mediationCode: m.code, title: `Mensaje de ${threadType === 'parte' ? (partyDisplayName(db, participantId) || 'una parte') : 'un abogado'} sin acción`, detail: message.text ? (message.text.length > 80 ? message.text.slice(0, 80) + '…' : message.text) : '(mensaje con adjunto)', priority: 'pendiente', dueDate: null, refId: message.id, suggestedActions: ['verComunicacion', 'crearTarea', 'crearCompromiso'] });
    }
    for (const { party, lastMessageAt, thresholdDays } of getPartiesWithNoResponse(db, m, now)) {
      items.push({ type: 'parteSinRespuesta', mediationId: m.id, mediationCode: m.code, title: `${partyDisplayName(db, party.id) || 'Una parte'} sin responder`, detail: `Sin respuesta desde hace ${Math.floor(daysBetween(lastMessageAt, now))} día(s) (umbral: ${thresholdDays}).`, priority: 'pendiente', dueDate: null, refId: party.id, suggestedActions: ['verComunicacion', 'contactar', 'crearTarea', 'descartar'] });
    }
  }

  items.sort((a, b) => (PRIORITY[a.priority] || 9) - (PRIORITY[b.priority] || 9));
  return items;
}

// mediación puntual (para el expediente) — mismo feed, filtrado a una sola.
function getMediationAttentionItems(db, mediation) {
  return buildAttentionItems(db, [mediation]);
}

// todas las mediaciones de un usuario (para el dashboard) — `mediations`
// ya viene resuelto por el caller vía getMyMediations, nunca por
// mediationId suelto del frontend.
function getDashboardAttentionItems(db, mediations) {
  return buildAttentionItems(db, mediations);
}

module.exports = {
  DEFAULT_INACTIVITY_THRESHOLD_DAYS, DEFAULT_PARTY_NO_RESPONSE_THRESHOLD_DAYS,
  mediationMissingNextAction, mediationNextActionOverdue,
  getOverdueTasks, getOverdueCommitments,
  getHearingsWithPendingConfirmations, getPendingConfirmations,
  getPendingRescheduleRequests, getDocumentsPendingReview,
  getHearingsWithoutResult, getHearingsDoneWithoutNextAction,
  getInactiveMediations, getUnactionedIncomingMessages, getPartiesWithNoResponse,
  getMediationsRequiringClosure,
  isAlertDismissed,
  getHearingPreparationState, validateModalityData,
  getMediationAttentionItems, getDashboardAttentionItems,
};
