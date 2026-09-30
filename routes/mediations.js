// routes/mediations.js
// Bloque 2 de Mediador (B2B) — ver IMPLEMENTATION_PLAN.md §5/§6.
// Mismo estilo que routes/channels.js: un módulo que exporta una función
// que recibe (io, presence) y devuelve el router — así comparte el mismo
// patrón de autenticación y el mismo objeto io para lo que haga falta
// emitir más adelante (Bloque 6, timeline en vivo).

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { nanoid, customAlphabet } = require('nanoid');
const { getDB, commit } = require('../db');
const { isAdminUser } = require('../roles');
const { logAudit } = require('../audit');
const { logMediationEvent } = require('../mediationEvents');
const { signHash } = require('../signing');
const { integrityHash, buildMediationPlainContent, buildMediationCertifiedPDF, buildMediationConstanciaPDF, buildMediationActaCierrePDF, buildMediationActaCierrePlainContent } = require('../certificate');
const { checkHearingConflicts, toMinutes } = require('../agenda');
const { notifyPartyAboutHearing, notifyLawyerAboutHearing, notifyParty, notifyLawyer, postSystemMessage, baseUrl } = require('../messaging');
const { askMediationAssistant, askDashboardAssistant, askMediationAssistantAboutDocument, suggestTasksFromNote } = require('../assistant');
const { buildDraftMinutesPDF, buildConvocationLetterPDF, buildOpeningActPDF, buildNoShowActPDF, buildRescheduleActPDF } = require('../workingDocuments');
const automationEngine = require('../automationEngine');
const { getHearingPreparationState, getDashboardAttentionItems, getMediationAttentionItems, isAlertDismissed } = automationEngine;
const archiver = require('archiver');
const { postMessage } = require('../messaging');
const { serializeMessage } = require('../serializers');
const { createHearingMeeting, updateHearingMeeting, cancelHearingMeeting, serializeHearingVideo } = require('../videoConferencing');
// Bloque 32 — billingPaywallActive() se movió a entitlements.js para que
// routes/agenda.js y routes/studios.js también la puedan reusar (antes
// vivía solo acá, duplicarla en cada archivo hubiera sido el mismo error
// que esta auditoría vino a corregir en otro lado).
const { canCreateMediation, canUseVideoMeetings, canUseAdvancedAgenda, canAddStudyMember, canAddAssistant, billingPaywallActive } = require('../entitlements');

// Bloque 17 §14/15 — "YYYY-MM-DD" a "DD/MM/YYYY", mismo formato que ya
// usa fmtDate() en todo el frontend. Sin esto, texto pensado para una
// persona (timeline, WhatsApp a partes/abogados) mostraba la fecha en
// formato de base de datos.
function fmtDateEs(ymd) {
  return ymd.split('-').reverse().join('/');
}

// código de canal de 6 caracteres, mismo alfabeto que ya usa
// routes/channels.js (sin 0/O/1/I para no confundir al leerlo en voz alta)
const genCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

// código legible tipo "MED-2026-0042" — secuencial por año, global (no por
// mediador): más simple de generar sin coordinación entre mediadores, y
// sigue siendo único de sobra para el volumen esperado.
function nextMediationCode(db) {
  const year = new Date().getFullYear();
  const countThisYear = db.mediations.filter((m) => m.code.startsWith(`MED-${year}-`)).length;
  return `MED-${year}-${String(countThisYear + 1).padStart(4, '0')}`;
}

// ================= Bloque 5: documentos — configuración de seguridad =================
// Cada punto de acá corresponde uno a uno con el checklist de
// IMPLEMENTATION_PLAN.md §3.7 (provisto explícitamente por el usuario en
// la revisión del plan). Fuera de public/, así express.static() JAMÁS
// puede servir un archivo de acá directo — la única puerta de entrada es
// el endpoint de descarga autenticado, más abajo.
const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads', 'mediations');

// whitelist de MIME -> extensión esperada. Los dos se validan cruzados
// (ver fileFilter) porque el MIME que declara el navegador se puede mentir.
const ALLOWED_MIME_EXT = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};
const MAX_UPLOAD_BYTES = Number(process.env.MAX_DOCUMENT_SIZE_MB || 15) * 1024 * 1024;

const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    // req.mediation ya lo dejó seteado requireMediationAccess, que corre
    // ANTES en la cadena de la ruta — nunca se usa nada del request crudo acá.
    const dir = path.join(UPLOADS_ROOT, req.mediation.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // nombre físico 100% generado por el servidor — nunca se toca
    // originalname para construir esto (checklist: "nunca usar el nombre
    // enviado por el usuario como path físico" + "impedir path traversal").
    const ext = ALLOWED_MIME_EXT[file.mimetype] || '';
    cb(null, nanoid() + ext);
  },
});

function documentFileFilter(req, file, cb) {
  const expectedExt = ALLOWED_MIME_EXT[file.mimetype];
  if (!expectedExt) return cb(new Error('Tipo de archivo no permitido'));
  // el MIME declarado por el navegador no alcanza solo — se cruza también
  // contra la extensión real del nombre original (checklist: "validar MIME
  // Y extensión, las dos, no alcanza con una").
  const originalExt = path.extname(file.originalname).toLowerCase();
  if (!Object.values(ALLOWED_MIME_EXT).includes(originalExt)) {
    return cb(new Error('Extensión de archivo no permitida'));
  }
  cb(null, true);
}

const uploadDocument = multer({
  storage: documentStorage,
  fileFilter: documentFileFilter,
  limits: { fileSize: MAX_UPLOAD_BYTES }, // checklist: "límite de tamaño explícito desde el primer commit"
});

function serializeDocument(d) {
  // storagePath NUNCA sale de acá (checklist: "no exponer URLs públicas
  // directas") — ni siquiera al dueño del documento.
  const db = getDB();
  const rootId = d.parentDocumentId || d.id;
  const maxVersion = Math.max(...db.documents.filter((x) => x.id === rootId || x.parentDocumentId === rootId).map((x) => x.version || 1));
  return {
    id: d.id, mediationId: d.mediationId, uploadedBy: d.uploadedBy,
    uploadedByName: d.uploadedBy ? (db.users.find((u) => u.id === d.uploadedBy)?.name || null) : null,
    partyId: d.partyId || null,
    type: d.type, originalFilename: d.originalFilename, mimeType: d.mimeType, size: d.size,
    status: d.status, version: d.version || 1, rootDocumentId: rootId,
    isCurrentVersion: (d.version || 1) === maxVersion, createdAt: d.createdAt,
    reviewNotes: d.reviewNotes || null,
  };
}

// Bloque 19 — mismo serializeMessage de siempre (serializers.js), más el
// documento adjunto si el mensaje referencia uno — nunca storagePath,
// mismo criterio que serializeDocument. Un documentId que ya no exista o
// que (por algún motivo) no sea de esta mediación simplemente no se
// resuelve, en vez de filtrar datos de otra mediación.
function serializeMediatorMessage(db, m, mediationId) {
  const base = serializeMessage(m);
  if (!m.documentId) return { ...base, document: null };
  // defensa en profundidad: aunque documentId solo se guarda ya validado
  // contra la mediación en el momento de mandar el mensaje, acá se vuelve
  // a comprobar antes de mostrarlo — nunca alcanza con "ya se validó una
  // vez" (mismo principio que la descarga de documentos).
  const doc = db.documents.find((d) => d.id === m.documentId && d.mediationId === mediationId);
  return { ...base, document: doc ? serializeDocument(doc) : null };
}

const VALID_STATUSES = [
  'borrador', 'iniciada', 'contactando_partes', 'notificaciones',
  'audiencia_programada', 'en_mediacion', 'acuerdo', 'acuerdo_parcial',
  'sin_acuerdo', 'incomparecencia', 'cerrada',
];

function serializeMediation(m) {
  return {
    id: m.id, code: m.code, internalNumber: m.internalNumber || null,
    mediatorUserId: m.mediatorUserId, channelId: m.channelId,
    type: m.type, object: m.object, description: m.description,
    status: m.status,
    nextActionText: m.nextActionText || null,
    nextActionResponsibleType: m.nextActionResponsibleType || null,
    nextActionResponsibleId: m.nextActionResponsibleId || null,
    nextActionDueDate: m.nextActionDueDate || null,
    nextActionSetBy: m.nextActionSetBy || null, // 'manual' | 'auto' | null — para que ninguna automatización futura pise a mano una próxima acción cargada por el mediador
    closedAt: m.closedAt || null, closedResult: m.closedResult || null, closedNotes: m.closedNotes || null,
    closedByName: m.closedBy ? (getDB().users.find((u) => u.id === m.closedBy)?.name || null) : null,
    reminderHoursBefore: m.reminderHoursBefore ?? 48, reminderChannels: m.reminderChannels || 'push,whatsapp',
    upcomingDueWindowDays: m.upcomingDueWindowDays ?? 7,
    inactivityThresholdDays: m.inactivityThresholdDays ?? automationEngine.DEFAULT_INACTIVITY_THRESHOLD_DAYS,
    partyNoResponseThresholdDays: m.partyNoResponseThresholdDays ?? automationEngine.DEFAULT_PARTY_NO_RESPONSE_THRESHOLD_DAYS,
    onboardingDismissedAt: m.onboardingDismissedAt || null,
    createdAt: m.createdAt,
  };
}

// Herramientas Legales — Auditor de expediente. Controles de
// COMPLETITUD/CONSISTENCIA sobre datos que YA existen en el modelo —
// nunca una obligación jurídica inventada. A propósito NO incluye nada
// sobre monto, honorarios, jurisdicción ni tomo/folio: esos campos no
// existen en la base (ver comentario de dashboard más abajo sobre por
// qué se dejaron afuera a propósito), así que afirmar que "faltan"
// sería inventar un requisito que el sistema no puede verificar.
// Cada control es independiente y de solo lectura — no corrige nada,
// solo informa con un link a la sección del expediente correspondiente.
function auditMediation(db, mediation) {
  const checks = [];
  const push = (id, label, status, detail, sectionAnchor) => {
    checks.push({ id, label, status, detail: detail || null, sectionAnchor: sectionAnchor || null });
  };
  const parties = db.parties.filter((p) => p.mediationId === mediation.id);
  const activeParties = parties.filter((p) => p.status === 'activa');
  const lawyers = db.lawyers.filter((l) => l.mediationId === mediation.id);
  const hearings = db.hearings.filter((h) => h.mediationId === mediation.id);
  const documents = db.documents.filter((d) => d.mediationId === mediation.id);
  const tasks = db.tasks.filter((t) => t.mediationId === mediation.id);
  const commitments = db.commitments.filter((c) => c.mediationId === mediation.id);
  const now = Date.now();
  const closed = !!mediation.closedAt;
  const partyName = (p) => p.legalName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Parte sin nombre';

  // ---- objeto del expediente ----
  push('objeto', 'Objeto del expediente', mediation.object && mediation.object.trim() ? 'ok' : 'pendiente',
    mediation.object && mediation.object.trim() ? null : 'No tiene objeto cargado.', 'section-admin');

  // ---- partes ----
  push('partes_activas', 'Partes cargadas', activeParties.length > 0 ? 'ok' : 'pendiente',
    activeParties.length > 0 ? `${activeParties.length} parte(s) activa(s).` : 'No hay ninguna parte activa cargada.', 'section-partes');
  if (activeParties.length > 0) {
    const sinDocumento = activeParties.filter((p) => !p.documentNumber && !p.taxId);
    push('partes_documento', 'Documento de identidad de las partes', sinDocumento.length === 0 ? 'ok' : 'pendiente',
      sinDocumento.length === 0 ? null : `Sin documento cargado: ${sinDocumento.map(partyName).join(', ')}.`, 'section-partes');
    const sinDomicilio = activeParties.filter((p) => !p.address);
    push('partes_domicilio', 'Domicilio de las partes', sinDomicilio.length === 0 ? 'ok' : 'pendiente',
      sinDomicilio.length === 0 ? null : `Sin domicilio cargado: ${sinDomicilio.map(partyName).join(', ')}.`, 'section-partes');
  } else {
    push('partes_documento', 'Documento de identidad de las partes', 'no_aplica', null, 'section-partes');
    push('partes_domicilio', 'Domicilio de las partes', 'no_aplica', null, 'section-partes');
  }

  // ---- abogados ----
  if (lawyers.length > 0) {
    const sinMatricula = lawyers.filter((l) => !l.enrollmentNumber);
    push('abogados_matricula', 'Matrícula de los abogados', sinMatricula.length === 0 ? 'ok' : 'pendiente',
      sinMatricula.length === 0 ? `${lawyers.length} abogado(s) con matrícula cargada.` : `Sin matrícula cargada: ${sinMatricula.map((l) => l.name).join(', ')}.`, 'section-abogados');
  } else {
    push('abogados_matricula', 'Matrícula de los abogados', 'no_aplica', 'No hay abogados cargados en este expediente.', 'section-abogados');
  }

  // ---- audiencias ----
  const activeHearings = hearings.filter((h) => ['programada', 'propuesta'].includes(h.status));
  if (!closed) {
    push('audiencias_programadas', 'Audiencia programada', activeHearings.length > 0 ? 'ok' : 'pendiente',
      activeHearings.length > 0 ? `${activeHearings.length} audiencia(s) programada(s) o propuesta(s).` : 'No hay ninguna audiencia programada ni propuesta.', 'section-audiencias');
  } else {
    push('audiencias_programadas', 'Audiencia programada', 'no_aplica', null, 'section-audiencias');
  }
  const upcomingProgramadas = hearings.filter((h) => h.status === 'programada' && new Date(`${h.date}T00:00:00`).getTime() >= now);
  if (upcomingProgramadas.length > 0) {
    const sinConfirmar = upcomingProgramadas.filter((h) => db.hearingConfirmations.some((c) => c.hearingId === h.id && c.response === 'pendiente'));
    push('audiencias_confirmacion', 'Confirmación de audiencias próximas', sinConfirmar.length === 0 ? 'ok' : 'pendiente',
      sinConfirmar.length === 0 ? null : `${sinConfirmar.length} audiencia(s) próxima(s) con confirmaciones pendientes.`, 'section-audiencias');
  } else {
    push('audiencias_confirmacion', 'Confirmación de audiencias próximas', 'no_aplica', null, 'section-audiencias');
  }

  // ---- documentos ----
  const observados = documents.filter((d) => d.status === 'observado');
  if (observados.length > 0) {
    push('documentos_observados', 'Documentos observados', 'inconsistencia', `${observados.length} documento(s) marcado(s) como observado, pendientes de corrección.`, 'section-documentos');
  } else if (documents.length === 0) {
    push('documentos_observados', 'Documentos observados', 'pendiente', 'Todavía no se cargó ningún documento en este expediente.', 'section-documentos');
  } else {
    push('documentos_observados', 'Documentos observados', 'ok', `${documents.length} documento(s), ninguno observado.`, 'section-documentos');
  }

  // ---- tareas y compromisos vencidos ----
  const tareasVencidas = tasks.filter((t) => ['pendiente', 'en_proceso'].includes(t.status) && t.dueDate && new Date(t.dueDate).getTime() < now);
  push('tareas_vencidas', 'Tareas vencidas', tareasVencidas.length === 0 ? 'ok' : 'inconsistencia',
    tareasVencidas.length === 0 ? null : `${tareasVencidas.length} tarea(s) vencida(s) sin completar.`, 'section-tareas');
  const compromisosVencidos = commitments.filter((c) => c.status === 'vencido' || (c.status === 'pendiente' && c.dueDate && new Date(c.dueDate).getTime() < now));
  push('compromisos_vencidos', 'Compromisos vencidos', compromisosVencidos.length === 0 ? 'ok' : 'inconsistencia',
    compromisosVencidos.length === 0 ? null : `${compromisosVencidos.length} compromiso(s) vencido(s) sin cumplir.`, 'section-compromisos');

  // ---- próxima acción / cierre ----
  if (!closed) {
    push('proxima_accion', 'Próxima acción definida', mediation.nextActionText ? 'ok' : 'pendiente',
      mediation.nextActionText ? null : 'No tiene próxima acción cargada.', 'section-admin');
    push('resultado_cierre', 'Resultado del cierre', 'no_aplica', null, 'section-admin');
    push('documento_certificado', 'Documento certificado generado', 'no_aplica', null, 'section-documentos');
  } else {
    push('proxima_accion', 'Próxima acción definida', 'no_aplica', null, 'section-admin');
    push('resultado_cierre', 'Resultado del cierre', mediation.closedResult ? 'ok' : 'inconsistencia',
      mediation.closedResult ? null : 'La mediación está cerrada pero no tiene resultado de cierre cargado.', 'section-admin');
    const tieneExport = db.certifiedExports.some((e) => e.mediationCode === mediation.code);
    push('documento_certificado', 'Documento certificado generado', tieneExport ? 'ok' : 'pendiente',
      tieneExport ? 'Se generó al menos un documento certificado para este expediente.' : 'Todavía no se generó ningún documento certificado (acta, constancia) para este expediente.', 'section-documentos');
  }

  return checks;
}

// Herramientas Legales — Control de vencimientos. Cruza, sobre TODAS las
// mediaciones del usuario (no una por una como el dashboard), tres
// fuentes de vencimiento que YA existen en el modelo: tareas, compromisos
// y la próxima acción de cada expediente. Nada nuevo se inventa acá —
// es la misma noción de "vencido" que ya usa auditMediation/dashboard,
// solo que agrupada en baldes HOY/MAÑANA/PRÓXIMOS 3/PRÓXIMOS 7/VENCIDOS
// en vez del booleano simple que alcanza para esas otras pantallas.
const VENCIMIENTO_RESPONSABLE_LABELS = { mediador: 'Mediador/a', party: 'Una parte', lawyer: 'Un abogado' };
function classifyDueDate(dueDateStr) {
  if (!dueDateStr) return null;
  const due = new Date(dueDateStr);
  if (Number.isNaN(due.getTime())) return null;
  // Comparar por DÍA calendario (UTC, igual que el resto de los
  // "YYYY-MM-DD" del sistema — ver commitmentUrgencyLabel en
  // mediador.js), nunca por milisegundos crudos: dueDateStr no tiene
  // hora, así que parsea como medianoche UTC de ese día — comparado
  // contra Date.now() (un instante, no medianoche), "hoy" quedaba mal
  // clasificado como "vencido" apenas pasaba la medianoche UTC.
  const dueDay = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  const now = new Date();
  const todayDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diffDays = Math.round((dueDay - todayDay) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return 'vencidos';
  if (diffDays === 0) return 'hoy';
  if (diffDays === 1) return 'manana';
  if (diffDays <= 3) return 'proximos3';
  if (diffDays <= 7) return 'proximos7';
  return null;
}
function buildVencimientosPanel(db, mediations) {
  const mediationIds = new Set(mediations.map((m) => m.id));
  const mediationById = {};
  mediations.forEach((m) => { mediationById[m.id] = m; });
  const partyName = (id) => {
    const p = db.parties.find((x) => x.id === id);
    if (!p) return null;
    return p.legalName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || null;
  };
  const items = [];

  db.tasks
    .filter((t) => mediationIds.has(t.mediationId) && ['pendiente', 'en_proceso'].includes(t.status) && t.dueDate)
    .forEach((t) => {
      const bucket = classifyDueDate(t.dueDate);
      if (!bucket) return;
      items.push({
        id: 'task:' + t.id, mediationId: t.mediationId, mediationCode: mediationById[t.mediationId].code,
        tipo: 'Tarea', label: t.title, dueDate: t.dueDate,
        responsable: t.assignedToPartyId ? (partyName(t.assignedToPartyId) || 'Una parte') : 'Mediador/a',
        bucket,
      });
    });

  db.commitments
    .filter((c) => mediationIds.has(c.mediationId) && ['pendiente', 'vencido'].includes(c.status) && c.dueDate)
    .forEach((c) => {
      const bucket = classifyDueDate(c.dueDate);
      if (!bucket) return;
      items.push({
        id: 'commitment:' + c.id, mediationId: c.mediationId, mediationCode: mediationById[c.mediationId].code,
        tipo: 'Compromiso', label: c.description, dueDate: c.dueDate,
        responsable: partyName(c.partyId) || 'Una parte',
        bucket,
      });
    });

  mediations
    .filter((m) => !m.closedAt && m.nextActionDueDate)
    .forEach((m) => {
      const bucket = classifyDueDate(m.nextActionDueDate);
      if (!bucket) return;
      items.push({
        id: 'nextaction:' + m.id, mediationId: m.id, mediationCode: m.code,
        tipo: 'Próxima acción', label: m.nextActionText || 'Próxima acción sin descripción',
        dueDate: m.nextActionDueDate,
        responsable: VENCIMIENTO_RESPONSABLE_LABELS[m.nextActionResponsibleType] || '—',
        bucket,
      });
    });

  items.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
  const grouped = { vencidos: [], hoy: [], manana: [], proximos3: [], proximos7: [] };
  items.forEach((it) => grouped[it.bucket].push(it));
  return grouped;
}

module.exports = function (io, presence) {
  const router = express.Router();

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    next();
  }

  // mismo espíritu que requireMembership de channels.js, pero contra
  // mediation_access en vez de members — ver IMPLEMENTATION_PLAN.md §6.
  // "Una parte nunca debe poder consultar otra mediación cambiando
  // simplemente un ID": esto es lo que lo impide en el server, no algo
  // que se confía al frontend.
  // Bloque 14 — una sola función para "cuáles son mis mediaciones",
  // usada por GET /, /search, /dashboard y /stats — antes cada una tenía
  // su propia copia de este mismo cálculo (4 veces). Ahora suma también
  // las del estudio completo si sos admin de uno — antes de esto, admin
  // de estudio solo veía las que tenía asignadas una por una.
  // Bloque 15 — extraída a mediationAccess.js para que routes/agenda.js
  // pueda reusar exactamente esta misma lógica, sin duplicarla.
  const { getMyMediations, suggestAssigneeForStudio } = require('../mediationAccess');

  function requireMediationAccess(req, res, next) {
    const db = getDB();
    const mediation = db.mediations.find((m) => m.id === req.params.id);
    if (!mediation) return res.status(404).json({ error: 'Mediación no encontrada' });

    if (isAdminUser(req.user)) {
      req.mediation = mediation;
      req.mediationRole = 'admin';
      return next();
    }
    if (mediation.mediatorUserId === req.user.id) {
      req.mediation = mediation;
      req.mediationRole = 'mediador';
      return next();
    }
    // Bloque 14 — admin de ESTUDIO: acceso general a las mediaciones de su
    // equipo, sin necesitar una fila puntual en mediation_access por cada
    // una. Una mediación "es del estudio" a través de quién es su
    // mediatorUserId — nunca se guarda studioId en mediations, se deriva.
    // Mediador/asistente del estudio NO entran por acá — ellos siguen
    // necesitando la asignación explícita de abajo, igual que siempre.
    if (req.user.studioId && req.user.studioRole === 'admin') {
      const owner = db.users.find((u) => u.id === mediation.mediatorUserId);
      if (owner && owner.studioId === req.user.studioId) {
        req.mediation = mediation;
        req.mediationRole = 'admin';
        return next();
      }
    }
    const access = db.mediationAccess.find(
      (a) => a.mediationId === mediation.id && a.userId === req.user.id
    );
    if (!access) return res.status(403).json({ error: 'No tenés acceso a esta mediación' });
    req.mediation = mediation;
    req.mediationRole = access.role; // 'asistente' | 'abogado'
    req.mediationPartyId = access.partyId || null;
    next();
  }

  // asistente y mediador pueden editar; abogado es de solo lectura (ver
  // IMPLEMENTATION_PLAN.md §3.2b) — admin también puede, para soporte.
  function requireEditAccess(req, res, next) {
    if (!['mediador', 'admin', 'asistente'].includes(req.mediationRole)) {
      return res.status(403).json({ error: 'Tu acceso a esta mediación es de solo lectura' });
    }
    next();
  }

  // Bloque 29 (Admin Console 2.0) §6/§8/§32 — requireMediationAccess deja
  // pasar a un admin de PLATAFORMA a CUALQUIER mediación (spec original de
  // ese bloque, necesario para las pantallas de metadata del Admin
  // Console). Pero leer los MENSAJES de una mediación ajena es contenido
  // privado — eso necesita, además, un acceso de soporte explícito y
  // vigente (nunca "porque es admin, ya está"). Un admin de ESTUDIO viendo
  // una mediación de su propio equipo (también llega acá con
  // req.mediationRole==='admin') NO necesita esto — el discriminador real
  // es isAdminUser, no mediationRole.
  const { hasActiveSupportAccess, recordSupportAccessUsage } = require('../supportAccess');
  function requireSupportAccessForPrivateContent(req, res, next) {
    if (!isAdminUser(req.user)) return next();
    if (req.mediation.mediatorUserId === req.user.id) return next();
    const db = getDB();
    if (!hasActiveSupportAccess(db, req.user.id, req.mediation.id)) {
      return res.status(403).json({
        error: 'Para ver mensajes de una mediación ajena necesitás una autorización de acceso de soporte activa (Admin Console → Soporte → Solicitar acceso).',
        code: 'SUPPORT_ACCESS_REQUIRED',
      });
    }
    recordSupportAccessUsage(db, req.user.id, req.mediation.id, req.originalUrl);
    next();
  }

  // ---------- crear mediación ----------
  router.post('/', requireAuth, async (req, res) => {
    const { type, object, description, internalNumber } = req.body || {};
    if (!object || !object.trim()) {
      return res.status(400).json({ error: 'Falta el objeto de la mediación' });
    }

    const db = getDB();

    // Bloque 29 §17 — paywall contextual: nunca bloquea toda la app, solo
    // esta acción puntual cuando el plan no la permite. isAdminUser sigue
    // sin límites (mismo criterio que el resto de los chequeos comerciales).
    if (!isAdminUser(req.user) && billingPaywallActive() && !canCreateMediation(db, req.user)) {
      return res.status(402).json({
        error: 'Llegaste al límite de mediaciones activas de tu plan actual.',
        upgradeMessage: 'Esta función está disponible en el plan Profesional.',
        code: 'PLAN_LIMIT_REACHED',
      });
    }

    // el canal de comunicación se crea junto con la mediación, siempre
    // 1:1 — el mediador entra como observador profesional de su propio
    // canal (mismo rol de solo-acompañamiento que ya usa un mediador
    // invitado a un canal de coparentalidad), no como "parte" del conflicto.
    const channel = {
      id: nanoid(), code: genCode(), guestToken: nanoid(24), calendarToken: nanoid(24),
      status: 'abierto', createdAt: Date.now(),
    };
    db.channels.push(channel);
    db.members.push({ id: nanoid(), channelId: channel.id, userId: req.user.id, role: 'mediador', joinedAt: Date.now() });

    const mediation = {
      id: nanoid(), code: nextMediationCode(db), internalNumber: internalNumber || null,
      mediatorUserId: req.user.id, channelId: channel.id,
      type: type || null, object: object.trim(), description: description || null,
      status: 'borrador',
      nextActionText: null, nextActionResponsibleType: null, nextActionResponsibleId: null, nextActionDueDate: null,
      closedAt: null, closedResult: null, closedNotes: null,
      createdAt: Date.now(),
    };
    db.mediations.push(mediation);
    channel.mediationId = mediation.id;

    db.mediationStatusHistory.push({
      id: nanoid(), mediationId: mediation.id, fromStatus: null, toStatus: 'borrador',
      changedBy: req.user.id, note: 'Alta de la mediación', createdAt: Date.now(),
    });
    logMediationEvent(db, {
      mediationId: mediation.id, type: 'MEDIATION_CREATED', actorId: req.user.id,
      entityType: 'mediation', entityId: mediation.id,
      title: 'Mediación creada', description: mediation.object,
    });

    await commit();
    // Bloque 22 (Parte 2) — sugerencia, nunca asignación automática. Solo
    // tiene sentido para un admin de estudio (un mediador independiente,
    // o alguien sin rol de admin, no tiene a quién sugerirle nada).
    let suggestedAssignee = null;
    if (req.user.studioId && req.user.studioRole === 'admin') {
      suggestedAssignee = suggestAssigneeForStudio(db, req.user.studioId);
    }
    res.json({ ...serializeMediation(mediation), suggestedAssignee });
  });

  // ---------- listar mis mediaciones ----------
  // "mis" = soy el mediador titular, o tengo una fila en mediation_access
  // (asistente/abogado), o soy admin (ve todas). Mismo chequeo que
  // requireMediationAccess pero para una lista, no para un id puntual.
  //
  // Filtros opcionales por query string (nuevo, a pedido explícito):
  //   ?estado=iniciada            -> por status exacto
  //   ?responsable=mediador       -> por nextActionResponsibleType (quién debe la próxima acción)
  //   ?mediador=<userId>          -> por mediatorUserId (quién es el mediador dueño) — Bloque 15 Parte 4:
  //                                  mismo nombre y mismo criterio que ya usan /api/agenda y /api/mediations/studio,
  //                                  antes solo esas dos pantallas lo tenían.
  //   ?vencidas=1                 -> solo con nextActionDueDate ya pasado
  router.get('/', requireAuth, (req, res) => {
    const db = getDB();
    let mine = getMyMediations(db, req.user);
    if (req.query.estado) mine = mine.filter((m) => m.status === req.query.estado);
    if (req.query.responsable) mine = mine.filter((m) => m.nextActionResponsibleType === req.query.responsable);
    if (req.query.mediador) mine = mine.filter((m) => m.mediatorUserId === req.query.mediador);
    // filtro por responsable específico, por NOMBRE — filtrar por
    // nextActionResponsibleId no tendría sentido acá: ese id es propio de
    // las partes/abogados de CADA mediación, nunca se repite entre
    // mediaciones distintas, así que filtrar la lista completa por un id
    // puntual como mucho matchea una sola fila. Por nombre sí sirve para
    // ver, por ejemplo, todas las mediaciones donde el Dr. Rodríguez es
    // responsable ahora mismo, sin importar en cuál mediación es cuál id.
    if (req.query.responsableNombre) {
      const q = req.query.responsableNombre.toLowerCase();
      mine = mine.filter((m) => {
        if (!m.nextActionResponsibleId) return false;
        const name = m.nextActionResponsibleType === 'party'
          ? partyDisplayName(db, m.nextActionResponsibleId)
          : (db.lawyers.find((l) => l.id === m.nextActionResponsibleId)?.name || null);
        return name && name.toLowerCase().includes(q);
      });
    }
    if (req.query.vencidas === '1') {
      const now = Date.now();
      mine = mine.filter((m) => m.nextActionDueDate && new Date(m.nextActionDueDate).getTime() < now);
    }
    mine = [...mine].sort((a, b) => b.createdAt - a.createdAt);
    res.json(mine.map(serializeMediation));
  });

  // ---------- buscar (por número/nombre/DNI/etc — hoy solo por code/
  // object/internalNumber; se amplía a partes en el Bloque 4 cuando
  // exista la tabla parties) ----------
  // Bloque 38 — además de código/objeto/legajo (internalNumber), ahora
  // también por apellido/nombre de las partes y nombre/matrícula del
  // abogado — mismos campos que ya existían en parties/lawyers, sin
  // agregar ninguno nuevo (jurisdicción y honorarios no existen en el
  // modelo, quedan afuera a propósito).
  router.get('/search', requireAuth, (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json([]);
    const db = getDB();
    const scope = getMyMediations(db, req.user);
    const scopeIds = new Set(scope.map((m) => m.id));
    const partyMatchIds = new Set(
      db.parties.filter((p) => scopeIds.has(p.mediationId) && (
        (p.firstName || '').toLowerCase().includes(q) ||
        (p.lastName || '').toLowerCase().includes(q) ||
        (p.legalName || '').toLowerCase().includes(q) ||
        (p.documentNumber || '').toLowerCase().includes(q)
      )).map((p) => p.mediationId)
    );
    const lawyerMatchIds = new Set(
      db.lawyers.filter((l) => scopeIds.has(l.mediationId) && (
        (l.name || '').toLowerCase().includes(q) ||
        (l.enrollmentNumber || '').toLowerCase().includes(q)
      )).map((l) => l.mediationId)
    );
    const results = scope.filter((m) =>
      m.code.toLowerCase().includes(q) ||
      (m.object || '').toLowerCase().includes(q) ||
      (m.internalNumber || '').toLowerCase().includes(q) ||
      partyMatchIds.has(m.id) ||
      lawyerMatchIds.has(m.id)
    );
    res.json(results.map(serializeMediation));
  });

  // ---------- dashboard ----------
  // Armado explícitamente alrededor de las 6 preguntas de
  // IMPLEMENTATION_PLAN.md §5 — no una lista de contadores genéricos.
  // Tiene que ir ANTES de GET /:id — si no, Express interpreta "dashboard"
  // como si fuera el :id (mismo motivo por el que /search también va acá).
  //
  // Honesto sobre lo que puede responder HOY: tasks/commitments/audiencias
  // recién existen en los Bloques 4-6, así que esas secciones devuelven
  // arrays vacíos por ahora — la FORMA de la respuesta ya es la final
  // (para que el frontend no tenga que cambiar cuando lleguen), pero el
  // contenido de esas partes específicas todavía no tiene de dónde salir.
  // Lo que SÍ es real desde este bloque: estado, próxima acción
  // (estructurada, no un texto suelto) y el historial de cambios de estado.
  router.get('/dashboard', requireAuth, (req, res) => {
    const db = getDB();
    const mine = getMyMediations(db, req.user);

    const activas = mine.filter((m) => !m.closedAt && m.status !== 'borrador');
    const now = Date.now();

    // ¿qué tengo que hacer yo ahora? — mediaciones activas sin próxima
    // acción cargada (esto SÍ es una consulta real, no un placeholder:
    // nextActionText ya existe desde el Bloque 2 y esto es exactamente lo
    // que la especificación pidió que el dashboard supiera detectar).
    const sinProximaAccion = activas
      .filter((m) => !m.nextActionText || !m.nextActionText.trim())
      .map(serializeMediation);

    // próximas acciones con vencimiento vencido — alerta viva, calculada
    // en el momento (no depende de que ningún job haya corrido antes, ver
    // IMPLEMENTATION_PLAN.md §3.11 sobre por qué las alertas nunca confían
    // solo en un evento logueado).
    const accionesVencidas = activas
      .filter((m) => m.nextActionDueDate && new Date(m.nextActionDueDate).getTime() < now)
      .map(serializeMediation);

    // ¿qué pasó? — mientras no exista mediation_events (Bloque 6), la mejor
    // fuente real de "qué pasó" es el propio historial de cambios de
    // estado, cruzando todas las mediaciones del usuario.
    const mineIds = new Set(mine.map((m) => m.id));
    const mediationById = Object.fromEntries(mine.map((m) => [m.id, m]));

    // ¿qué pasó? — ahora sale del timeline real (mediation_events), no
    // solo del historial de estado como en el Bloque 3. Se filtran los
    // eventos mediator_only para que este resumen nunca filtre algo
    // privado si en algún momento el dashboard se reusa para otro rol.
    const recentActivity = db.mediationEvents
      .filter((e) => mineIds.has(e.mediationId) && e.visibility === 'public')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 15)
      .map((e) => ({
        mediationId: e.mediationId, mediationCode: mediationById[e.mediationId]?.code || null,
        type: e.type, title: e.title, description: e.description, createdAt: e.createdAt,
      }));

    // tareas y compromisos vencidos — chequeo en vivo contra la fecha,
    // igual que las acciones vencidas de arriba (§3.11: el dashboard nunca
    // depende de que el job diario haya corrido a tiempo).
    const myMediationTasks = db.tasks.filter((t) => mineIds.has(t.mediationId));
    const tareasVencidas = myMediationTasks
      .filter((t) => ['pendiente', 'en_proceso'].includes(t.status) && t.dueDate && new Date(t.dueDate).getTime() < now)
      .map((t) => ({ ...serializeTask(t), mediationCode: mediationById[t.mediationId]?.code || null }));

    const myMediationCommitments = db.commitments.filter((c) => mineIds.has(c.mediationId));
    const compromisosVencidos = myMediationCommitments
      .filter((c) => c.status === 'vencido' || (c.status === 'pendiente' && c.dueDate && new Date(c.dueDate).getTime() < now))
      .map((c) => ({ ...serializeCommitment(c), mediationCode: mediationById[c.mediationId]?.code || null, partyName: partyDisplayName(db, c.partyId) }));

    // audiencias con alguna confirmación pendiente, sin importar la fecha
    // (la ventana de 48hs es solo para la ALERTA del job; acá se listan
    // todas para que el mediador tenga panorama, no solo lo urgente)
    const audienciasSinConfirmar = db.hearings
      .filter((h) => mineIds.has(h.mediationId) && ['programada', 'confirmada'].includes(h.status))
      .filter((h) => db.hearingConfirmations.some((c) => c.hearingId === h.id && c.response === 'pendiente'))
      .map((h) => ({ id: h.id, mediationId: h.mediationId, mediationCode: mediationById[h.mediationId]?.code || null, date: h.date, startTime: h.startTime }));

    // Bloque 38 — resumen de confirmación por audiencia (para el badge
    // "Confirmada" / "N sin confirmar" / "Propuesta enviada" del
    // dashboard nuevo) y nombres de las partes convocadas — mismos datos
    // que ya se calculaban por separado (hearingConfirmations, parties),
    // juntados acá para no hacer un segundo viaje desde el frontend.
    function hearingConfirmationSummary(h) {
      if (h.status === 'propuesta') return { label: 'propuesta_enviada', pendientes: 0 };
      const rows = db.hearingConfirmations.filter((c) => c.hearingId === h.id);
      const pendientes = rows.filter((c) => c.response === 'pendiente').length;
      return pendientes > 0 ? { label: 'sin_confirmar', pendientes } : { label: 'confirmada', pendientes: 0 };
    }
    function activePartyNames(mediationId) {
      return db.parties
        .filter((p) => p.mediationId === mediationId && p.status === 'activa')
        .map((p) => partyDisplayName(db, p.id))
        .filter(Boolean);
    }

    const proximasAudiencias = db.hearings
      .filter((h) => mineIds.has(h.mediationId) && ['programada', 'confirmada'].includes(h.status))
      .filter((h) => new Date(h.date).getTime() >= now - 24 * 60 * 60 * 1000) // no mostrar audiencias muy viejas que quedaron sin cerrar
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 10)
      .map((h) => ({
        id: h.id, mediationId: h.mediationId, mediationCode: mediationById[h.mediationId]?.code || null,
        date: h.date, startTime: h.startTime, modality: h.modality, status: h.status,
        partyNames: activePartyNames(h.mediationId),
        confirmation: hearingConfirmationSummary(h),
      }));

    const tareasPendientes = myMediationTasks
      .filter((t) => ['pendiente', 'en_proceso'].includes(t.status))
      .map((t) => ({ ...serializeTask(t), mediationCode: mediationById[t.mediationId]?.code || null }));
    const compromisosPendientes = myMediationCommitments
      .filter((c) => c.status === 'pendiente')
      .map((c) => ({ ...serializeCommitment(c), mediationCode: mediationById[c.mediationId]?.code || null, partyName: partyDisplayName(db, c.partyId) }));

    // "próximo a vencer" — distinto de vencido: todavía no pasó la fecha,
    // pero vence dentro de la ventana configurada. Ahora por mediación
    // (mediation.upcomingDueWindowDays, default 7 días) — antes era un
    // valor fijo global, igual para todos.
    const windowMsFor = (mediationId) => (mediationById[mediationId]?.upcomingDueWindowDays ?? 7) * 24 * 60 * 60 * 1000;
    const tareasProximasAVencer = myMediationTasks
      .filter((t) => ['pendiente', 'en_proceso'].includes(t.status) && t.dueDate)
      .filter((t) => { const due = new Date(t.dueDate).getTime(); return due >= now && due - now <= windowMsFor(t.mediationId); })
      .map((t) => ({ ...serializeTask(t), mediationCode: mediationById[t.mediationId]?.code || null }));
    const compromisosProximosAVencer = myMediationCommitments
      .filter((c) => c.status === 'pendiente' && c.dueDate)
      .filter((c) => { const due = new Date(c.dueDate).getTime(); return due >= now && due - now <= windowMsFor(c.mediationId); })
      .map((c) => ({ ...serializeCommitment(c), mediationCode: mediationById[c.mediationId]?.code || null, partyName: partyDisplayName(db, c.partyId) }));

    // documentos pendientes de revisión — status:'recibido' es el estado
    // inicial (ver Bloque 5): significa que nadie lo reclasificó todavía
    // como revisado/observado/final.
    const documentosPendientesRevision = db.documents
      .filter((d) => mineIds.has(d.mediationId) && d.status === 'recibido')
      .map((d) => ({ id: d.id, mediationId: d.mediationId, mediationCode: mediationById[d.mediationId]?.code || null, originalFilename: d.originalFilename, createdAt: d.createdAt }));

    // Bloque 15 (Parte 2) §17 — alertas de agenda. El dashboard sigue
    // respondiendo "¿qué tengo que hacer ahora?", no se vuelve un
    // calendario — estas son señales puntuales, no una lista completa de audiencias.
    const myHearings = db.hearings.filter((h) => mineIds.has(h.mediationId));
    const solicitudesCambioPendientes = db.hearingRescheduleRequests
      .filter((r) => mineIds.has(r.mediationId) && r.status === 'pendiente')
      .map((r) => ({ id: r.id, mediationId: r.mediationId, mediationCode: mediationById[r.mediationId]?.code || null, hearingId: r.hearingId }));
    const audienciasReprogramadasRecientemente = myHearings
      .filter((h) => db.mediationEvents.some((e) => e.type === 'HEARING_RESCHEDULED' && e.entityId === h.id && (now - e.createdAt) <= 7 * 24 * 60 * 60 * 1000))
      .map((h) => ({ id: h.id, mediationId: h.mediationId, mediationCode: mediationById[h.mediationId]?.code || null, date: h.date }));
    // pasó la fecha y sigue "programada"/"confirmada" — nadie registró qué pasó
    const audienciasSinResultado = myHearings
      .filter((h) => ['programada', 'confirmada'].includes(h.status) && h.date < new Date(now).toISOString().slice(0, 10))
      .map((h) => ({ id: h.id, mediationId: h.mediationId, mediationCode: mediationById[h.mediationId]?.code || null, date: h.date }));
    // realizada, pero la mediación se quedó sin próxima acción cargada
    const audienciasRealizadasSinProximaAccion = myHearings
      .filter((h) => h.status === 'realizada' && !(mediationById[h.mediationId]?.nextActionText))
      .map((h) => ({ id: h.id, mediationId: h.mediationId, mediationCode: mediationById[h.mediationId]?.code || null, date: h.date }));

    // Bloque 16 §9 — visibilidad de agenda, derivada de datos reales,
    // sin ningún estado duplicado nuevo.
    const propuestasPendientes = myHearings
      .filter((h) => h.status === 'propuesta')
      .map((h) => ({ id: h.id, mediationId: h.mediationId, mediationCode: mediationById[h.mediationId]?.code || null, date: h.date, proposalGroupId: h.proposalGroupId }));
    const audienciasConfirmadasRecientemente = myHearings
      .filter((h) => db.mediationEvents.some((e) => (e.type === 'HEARING_SCHEDULED' || e.type === 'HEARING_CONFIRMED') && e.entityId === h.id && (now - e.createdAt) <= 3 * 24 * 60 * 60 * 1000))
      .map((h) => ({ id: h.id, mediationId: h.mediationId, mediationCode: mediationById[h.mediationId]?.code || null, date: h.date }));
    const audienciasCanceladasRecientemente = myHearings
      .filter((h) => h.status === 'cancelada' && db.mediationEvents.some((e) => e.type === 'HEARING_CANCELLED' && e.entityId === h.id && (now - e.createdAt) <= 7 * 24 * 60 * 60 * 1000))
      .map((h) => ({ id: h.id, mediationId: h.mediationId, mediationCode: mediationById[h.mediationId]?.code || null, date: h.date }));
    // fallos/no disponibilidad — reusa whatsappLog tal cual (se le agregó
    // mediationId), no una tabla nueva de notificaciones.
    const fallosNotificacion = db.whatsappLog
      .filter((w) => w.mediationId && mineIds.has(w.mediationId) && ['notification_unavailable', 'notification_error'].includes(w.kind) && (now - w.createdAt) <= 3 * 24 * 60 * 60 * 1000)
      .map((w) => ({ mediationId: w.mediationId, mediationCode: mediationById[w.mediationId]?.code || null, kind: w.kind, userName: w.userName, createdAt: w.createdAt }));

    // "N mediaciones requieren atención" — cuenta MEDIACIONES distintas
    // con al menos un ítem de atención, no la suma de ítems (una mediación
    // con 3 tareas vencidas cuenta una vez, no tres).
    const mediacionesConAtencion = new Set([
      ...sinProximaAccion.map((m) => m.id), ...accionesVencidas.map((m) => m.id),
      ...tareasVencidas.map((t) => t.mediationId), ...compromisosVencidos.map((c) => c.mediationId),
      ...audienciasSinConfirmar.map((h) => h.mediationId), ...documentosPendientesRevision.map((d) => d.mediationId),
    ]);

    const porEstado = {};
    for (const m of mine) porEstado[m.status] = (porEstado[m.status] || 0) + 1;

    // Bloque 38 — datos nuevos del dashboard rediseñado. Todo calculado a
    // partir de tablas que ya existían (mediations/mediation_events/
    // documents/feature_flags), sin tocar el modelo ni los permisos —
    // mismo criterio que el resto de este endpoint.

    // "Últimas mediaciones": ordenadas por actividad real (el último
    // mediation_event de cada una), no por fecha de creación — así una
    // mediación vieja con movimiento hoy aparece antes que una nueva sin
    // tocar. Sin evento propio todavía, cae a createdAt.
    const lastEventAtByMediation = {};
    for (const e of db.mediationEvents) {
      if (!mineIds.has(e.mediationId)) continue;
      if (!lastEventAtByMediation[e.mediationId] || e.createdAt > lastEventAtByMediation[e.mediationId].createdAt) {
        lastEventAtByMediation[e.mediationId] = { createdAt: e.createdAt, type: e.type, title: e.title };
      }
    }
    const ultimasMediaciones = mine
      .slice()
      .sort((a, b) => (lastEventAtByMediation[b.id]?.createdAt || b.createdAt) - (lastEventAtByMediation[a.id]?.createdAt || a.createdAt))
      .slice(0, 5)
      .map((m) => ({
        id: m.id, code: m.code, object: m.object, status: m.status,
        partyNames: activePartyNames(m.id),
        nextActionText: m.nextActionText || null,
        lastActivity: lastEventAtByMediation[m.id]
          ? { title: lastEventAtByMediation[m.id].title, createdAt: lastEventAtByMediation[m.id].createdAt }
          : { title: 'Mediación creada', createdAt: m.createdAt },
      }));

    // "Documentos recientes": últimos 3 de TODAS las mediaciones del
    // usuario, mismo serializer que ya usa el expediente (nunca expone
    // storagePath).
    const documentosRecientes = db.documents
      .filter((d) => mineIds.has(d.mediationId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 3)
      .map((d) => ({ ...serializeDocument(d), mediationCode: mediationById[d.mediationId]?.code || null }));

    // "Continuar [código]": la última mediación donde ESTE usuario dejó
    // actividad (actorId, no cualquier evento del sistema) — el atajo del
    // encabezado para retomar justo donde se quedó.
    const myLastEvent = db.mediationEvents
      .filter((e) => mineIds.has(e.mediationId) && e.actorId === req.user.id)
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    const continuarMediacion = myLastEvent
      ? { id: myLastEvent.mediationId, code: mediationById[myLastEvent.mediationId]?.code || null }
      : null;

    // Tendencia de 6 meses y resultados de cierre — mismo cálculo exacto
    // que ya usa GET /stats (no se duplica la lógica, se copia la misma
    // agregación porque el dashboard la necesita en la misma respuesta).
    const nowDate = new Date();
    const creadasPorMes = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1);
      const key = d.toISOString().slice(0, 7);
      const count = mine.filter((m) => new Date(m.createdAt).toISOString().slice(0, 7) === key).length;
      creadasPorMes.push({ month: key, count });
    }
    const cerradasList = mine.filter((m) => m.closedAt);
    const porResultado = {};
    cerradasList.forEach((m) => { porResultado[m.closedResult] = (porResultado[m.closedResult] || 0) + 1; });
    const acuerdosLogrados = cerradasList.filter((m) => ['acuerdo_total', 'acuerdo_parcial'].includes(m.closedResult)).length;

    // Puente Connect: gateado por feature flag (Admin Console, Bloque 29)
    // — sin fila sembrada todavía, el default es visible (mismo criterio
    // que el resto de los flags, ver routes/admin-mediador.js).
    const puenteConnectFlag = db.featureFlags.find((f) => f.key === 'puenteConnect');
    const puenteConnectEnabled = puenteConnectFlag ? !!puenteConnectFlag.enabled : true;

    // Bloque 19 — "comunicaciones pendientes": un número, no una alerta
    // por mensaje (spec: "evitar ruido"). Mismo cálculo de no-leído que
    // ya usa routes/channels.js (readAt recíproco) sobre TODOS los hilos
    // (parte/abogado/interno) de las mediaciones del usuario.
    const myChannelIds = new Set(db.channels.filter((c) => c.mediationId && mineIds.has(c.mediationId)).map((c) => c.id));
    const comunicacionesPendientes = db.messages.filter(
      (m) => myChannelIds.has(m.channelId) && m.senderId && m.senderId !== req.user.id && !m.readAt
    ).length;

    res.json({
      counts: {
        activas: activas.length,
        cerradas: mine.filter((m) => !!m.closedAt).length,
        total: mine.length,
        porEstado,
      },
      // "4 mediaciones requieren atención" — el resumen agrupado
      requierenAtencion: {
        totalMediaciones: mediacionesConAtencion.size,
        desglose: {
          audienciasSinConfirmar: audienciasSinConfirmar.length,
          documentosPendientesRevision: documentosPendientesRevision.length,
          compromisosVencidos: compromisosVencidos.length,
          tareasVencidas: tareasVencidas.length,
          sinProximaAccion: sinProximaAccion.length,
        },
      },
      // ¿qué tengo que hacer yo ahora? — la sección priorizada, arriba de todo
      necesitanAtencion: {
        sinProximaAccion,
        accionesVencidas,
        tareasVencidas,
        compromisosVencidos,
        audienciasSinConfirmar,
        documentosPendientesRevision,
      },
      // Bloque 15 (Parte 2) — alertas de agenda, separadas del bloque de
      // arriba para no mezclar conceptos, pero con el mismo espíritu
      alertasAgenda: {
        solicitudesCambioPendientes,
        audienciasReprogramadasRecientemente,
        audienciasSinResultado,
        audienciasRealizadasSinProximaAccion,
        propuestasPendientes,
        audienciasConfirmadasRecientemente,
        audienciasCanceladasRecientemente,
        fallosNotificacion,
      },
      // "vencen próximamente" — todavía no es urgente, pero se viene
      vencenProximamente: {
        tareas: tareasProximasAVencer,
        compromisos: compromisosProximosAVencer,
      },
      // ¿qué pasó?
      actividadReciente: recentActivity,
      // ¿qué está pendiente? / ¿quién? / ¿qué debe hacer? / ¿cuándo?
      pendientes: { tareas: tareasPendientes, compromisos: compromisosPendientes },
      // ¿cuándo nos reunimos?
      proximasAudiencias,
      // Bloque 19 — un número, no una lista: el dashboard no se vuelve
      // un buzón de mensajes, solo dice cuántas conversaciones tienen
      // algo sin leer.
      comunicacionesPendientes,
      // Bloque 30 — las últimas conversaciones con actividad, para la
      // sección "Comunicaciones recientes" del dashboard (spec §10). Las
      // 3 más recientes alcanzan para eso; "Ver todas" lleva a la bandeja
      // completa (GET /inbox), que es la que soporta paginación/búsqueda.
      comunicacionesRecientes: buildCommunicationsInbox(db, req.user, { limit: 3 }),
      // Bloque 22 — "¿Qué requiere tu atención?": el mismo criterio que
      // los bloques de arriba, pero unificado en una sola lista plana y
      // priorizada (vencido > crítico > próximo > pendiente, sin ranking
      // ni puntaje), con la acción sugerida para cada situación. Incluye
      // además las detecciones nuevas de este bloque (mediación inactiva,
      // comunicación sin acción, parte sin respuesta, mediación que
      // parece lista para cerrarse) que los campos de arriba no cubrían.
      // se suman acá (en vez de adentro de automationEngine) porque ya
      // estaban calculadas arriba para alertasAgenda — no tiene sentido
      // recorrer hearings/whatsappLog una segunda vez para lo mismo.
      centroAtencion: [
        ...getDashboardAttentionItems(db, mine),
        ...propuestasPendientes.map((h) => ({ type: 'propuestaPendiente', mediationId: h.mediationId, mediationCode: h.mediationCode, title: `Propuesta de audiencia del ${h.date} sin respuesta`, detail: null, priority: 'pendiente', dueDate: h.date, refId: h.id, responsible: 'Las partes', suggestedActions: ['verMediacion'] })),
        ...audienciasCanceladasRecientemente.map((h) => ({ type: 'audienciaCancelada', mediationId: h.mediationId, mediationCode: h.mediationCode, title: `Audiencia cancelada · ${h.date}`, detail: 'Revisar si corresponde reagendar.', priority: 'pendiente', dueDate: null, refId: h.id, responsible: 'Vos', suggestedActions: ['verMediacion'] })),
        ...fallosNotificacion.map((f) => ({ type: 'falloNotificacion', mediationId: f.mediationId, mediationCode: f.mediationCode, title: `Notificación a ${f.userName || 'alguien'} no llegó`, detail: null, priority: 'pendiente', dueDate: null, refId: f.mediationId, responsible: 'Vos', suggestedActions: ['verMediacion'] })),
      ].sort((a, b) => ({ vencido: 1, critico: 2, proximo: 3, pendiente: 4 }[a.priority] - { vencido: 1, critico: 2, proximo: 3, pendiente: 4 }[b.priority])),
      // Bloque 38 — dashboard rediseñado
      ultimasMediaciones,
      documentosRecientes,
      continuarMediacion,
      creadasPorMes,
      porResultado,
      acuerdosLogrados,
      puenteConnectEnabled,
    });
  });

  // ---------- compromisos, cross-mediación (Bloque 31) ----------
  // Antes de esto, los compromisos solo se veían adentro de cada
  // expediente uno por uno (GET /:id/commitments más abajo, que sigue
  // existiendo tal cual). Esta es la vista agregada que pide la
  // especificación de "Compromisos + Vencimientos" — mismo patrón que
  // /dashboard: reusa getMyMediations, nunca un cálculo de permisos nuevo.
  // Los filtros son sobre ESTADO CALCULADO en vivo (igual que el resto del
  // dashboard), no sobre un campo guardado — así nunca depende de que un
  // job haya corrido para que "vencido"/"hoy" estén al día.
  router.get('/commitments', requireAuth, (req, res) => {
    const db = getDB();
    const mine = getMyMediations(db, req.user);
    const mineIds = new Set(mine.map((m) => m.id));
    const mediationById = Object.fromEntries(mine.map((m) => [m.id, m]));
    const now = Date.now();
    const todayStr = new Date(now).toISOString().slice(0, 10);

    let list = db.commitments.filter((c) => mineIds.has(c.mediationId));
    if (req.query.partyId) list = list.filter((c) => c.partyId === req.query.partyId);

    const { status } = req.query;
    if (status && status !== 'todos') {
      list = list.filter((c) => {
        const dueMs = c.dueDate ? new Date(c.dueDate).getTime() : null;
        const isOverdue = c.status === 'vencido' || (c.status === 'pendiente' && dueMs != null && dueMs < now && c.dueDate !== todayStr);
        if (status === 'vencidos') return isOverdue;
        if (status === 'hoy') return ['pendiente', 'vencido'].includes(c.status) && c.dueDate === todayStr;
        if (status === 'proximos') return c.status === 'pendiente' && !isOverdue && c.dueDate && c.dueDate !== todayStr;
        if (status === 'cumplidos') return c.status === 'cumplido';
        if (status === 'cancelados') return c.status === 'cancelado';
        return true;
      });
    }

    list = list.sort((a, b) => {
      // sin fecha al final, después ordenado por vencimiento más próximo primero
      if (!a.dueDate && !b.dueDate) return b.createdAt - a.createdAt;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });

    res.json(list.map((c) => ({
      ...serializeCommitment(c),
      mediationCode: mediationById[c.mediationId]?.code || null,
      partyName: partyDisplayName(db, c.partyId),
    })));
  });

  // Bloque 12 — asistente cross-mediación: arma un resumen en texto plano
  // de TODAS las mediaciones activas del usuario (no solo una), para
  // preguntas del estilo "¿qué mediaciones tienen algo pendiente esta
  // semana?". Reusa el mismo criterio de "mis mediaciones" que ya usan
  // GET / y GET /dashboard — no un cálculo nuevo.
  function buildDashboardPlainContext(db, user) {
    const mine = getMyMediations(db, user);
    const now = Date.now();
    const lines = [];
    for (const m of mine) {
      if (m.closedAt) continue; // el resumen operativo es sobre lo activo, no lo ya cerrado
      const tasks = db.tasks.filter((t) => t.mediationId === m.id && ['pendiente', 'en_proceso'].includes(t.status));
      const commitments = db.commitments.filter((c) => c.mediationId === m.id && ['pendiente', 'vencido'].includes(c.status));
      lines.push(`${m.code} — ${m.object} — estado: ${m.status}`);
      lines.push(`  próxima acción: ${m.nextActionText || '(sin cargar)'}${m.nextActionDueDate ? ' — vence ' + m.nextActionDueDate : ''}`);
      tasks.forEach((t) => lines.push(`  tarea: "${t.title}"${t.dueDate ? ' — vence ' + t.dueDate : ''} (${t.status})${new Date(t.dueDate).getTime() < now ? ' [VENCIDA]' : ''}`));
      commitments.forEach((c) => lines.push(`  compromiso de ${partyDisplayName(db, c.partyId)}: "${c.description}"${c.dueDate ? ' — vence ' + c.dueDate : ''} (${c.status})`));
    }
    return lines.length ? lines.join('\n') : '(el mediador no tiene mediaciones activas)';
  }

  router.post('/assistant', requireAuth, async (req, res) => {
    const { question } = req.body || {};
    if (!question || !question.trim()) return res.status(400).json({ error: 'Falta la pregunta' });
    const db = getDB();
    try {
      const context = buildDashboardPlainContext(db, req.user);
      const answer = await askDashboardAssistant(question.trim(), context);
      res.json({ answer });
    } catch (err) {
      console.error('Error en el asistente de dashboard:', err);
      res.status(500).json({ error: 'No se pudo consultar al asistente' });
    }
  });

  // ================= Bloque 13: gestión profesional =================
  // A diferencia de moderationStats.js (que acumula contadores porque el
  // dato en sí — cada llamada a la IA — no queda guardado en ningún
  // lado), acá todo lo necesario YA está en mediations/tasks/commitments
  // desde los Bloques 1-8 — esto es una consulta calculada en el momento,
  // no una tabla nueva que acumula nada.
  router.get('/stats', requireAuth, (req, res) => {
    const db = getDB();
    const mine = getMyMediations(db, req.user);

    const closed = mine.filter((m) => m.closedAt);
    const active = mine.filter((m) => !m.closedAt && m.status !== 'borrador');

    const porResultado = {};
    closed.forEach((m) => { porResultado[m.closedResult] = (porResultado[m.closedResult] || 0) + 1; });
    const agreementCount = closed.filter((m) => ['acuerdo_total', 'acuerdo_parcial'].includes(m.closedResult)).length;

    const durations = closed.map((m) => (m.closedAt - m.createdAt) / (1000 * 60 * 60 * 24));
    const duracionPromedioDias = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    // productividad: mediaciones creadas por mes, últimos 6 meses
    const now = new Date();
    const productividadMensual = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toISOString().slice(0, 7);
      const count = mine.filter((m) => new Date(m.createdAt).toISOString().slice(0, 7) === key).length;
      productividadMensual.push({ month: key, count });
    }

    const mineIds = new Set(mine.map((m) => m.id));
    const allTasks = db.tasks.filter((t) => mineIds.has(t.mediationId));
    const allCommitments = db.commitments.filter((c) => mineIds.has(c.mediationId));

    res.json({
      counts: { total: mine.length, activas: active.length, cerradas: closed.length },
      porResultado,
      tasaDeAcuerdo: closed.length ? agreementCount / closed.length : null,
      duracionPromedioDias,
      productividadMensual,
      tareas: { total: allTasks.length, completadas: allTasks.filter((t) => t.status === 'completada').length },
      compromisos: {
        total: allCommitments.length,
        cumplidos: allCommitments.filter((c) => c.status === 'cumplido').length,
        vencidos: allCommitments.filter((c) => c.status === 'vencido').length,
      },
    });
  });

  // Bloque 14 (Parte 2) — vista "Mediaciones del estudio" para el admin.
  // Reusa getMyMediations tal cual (misma derivación de siempre: por
  // mediatorUserId + studioId del dueño, nunca guardado en mediations) —
  // lo único nuevo acá es el enriquecimiento por fila (responsables,
  // próxima audiencia, alertas) y los filtros.
  router.get('/studio', requireAuth, (req, res) => {
    if (!req.user.studioId || req.user.studioRole !== 'admin') {
      return res.status(403).json({ error: 'Necesitás ser administrador de un estudio para ver esta vista' });
    }
    const db = getDB();
    let list = getMyMediations(db, req.user);
    const now = Date.now();

    let enriched = list.map((m) => {
      const owner = db.users.find((u) => u.id === m.mediatorUserId);
      const accessRows = db.mediationAccess.filter((a) => a.mediationId === m.id && ['mediador', 'asistente'].includes(a.role));
      const assigned = accessRows.map((a) => {
        const u = db.users.find((x) => x.id === a.userId);
        return { accessId: a.id, userId: a.userId, userName: u ? u.name : null, role: a.role };
      });
      const upcomingHearing = db.hearings
        .filter((h) => h.mediationId === m.id && ['programada', 'confirmada'].includes(h.status))
        .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
      const hearingUnconfirmed = upcomingHearing
        ? db.hearingConfirmations.some((c) => c.hearingId === upcomingHearing.id && c.response === 'pendiente')
        : false;
      const nextActionVencida = !!(m.nextActionDueDate && new Date(m.nextActionDueDate).getTime() < now);

      return {
        id: m.id, code: m.code, object: m.object, status: m.status, createdAt: m.createdAt,
        mediatorUserId: m.mediatorUserId, mediatorName: owner ? owner.name : null,
        nextActionText: m.nextActionText || null, nextActionDueDate: m.nextActionDueDate || null,
        assigned,
        upcomingHearingDate: upcomingHearing ? upcomingHearing.date : null,
        alerts: { nextActionVencida, hearingUnconfirmed },
      };
    });

    // filtros — todos opcionales, se aplican sobre lo ya enriquecido
    if (req.query.mediador) enriched = enriched.filter((m) => m.mediatorUserId === req.query.mediador);
    if (req.query.asistente) enriched = enriched.filter((m) => m.assigned.some((a) => a.userId === req.query.asistente && a.role === 'asistente'));
    if (req.query.estado) enriched = enriched.filter((m) => m.status === req.query.estado);
    if (req.query.nextActionVencida === '1') enriched = enriched.filter((m) => m.alerts.nextActionVencida);
    if (req.query.audienciaProxima === '1') enriched = enriched.filter((m) => !!m.upcomingHearingDate);
    if (req.query.sinAsignar === '1') enriched = enriched.filter((m) => m.assigned.length === 0);

    res.json(enriched.sort((a, b) => b.createdAt - a.createdAt));
  });

  // Bloque 30 — bandeja global de comunicaciones: junta las conversaciones
  // (parte/abogado/interno) de TODAS las mediaciones del usuario en una
  // sola lista, para poder entrar al chat correcto en 1 clic desde
  // Dashboard/Comunicaciones sin pasar por cada expediente. Reusa
  // getMyMediations (mismo control de acceso que el resto de la app,
  // nunca un filtro nuevo) y lastMessagePreview/unreadCountFor tal cual
  // los usa GET /:id/communications — ningún cálculo de "no leído"
  // paralelo. Solo aparecen hilos que YA tienen al menos un mensaje: una
  // bandeja llena de canales internos vacíos de cada mediación sería puro
  // ruido (spec §7/§9).
  function buildCommunicationsInbox(db, user, { limit = 20, q = '' } = {}) {
    const mine = getMyMediations(db, user);
    const items = [];
    for (const m of mine) {
      for (const ch of db.channels.filter((c) => c.mediationId === m.id)) {
        const last = lastMessagePreview(db, ch.id);
        if (!last) continue;
        let type = 'interno';
        let participantName = 'Equipo interno';
        if (ch.partyId) { type = 'parte'; participantName = partyDisplayName(db, ch.partyId) || 'Parte'; }
        else if (ch.lawyerId) {
          type = 'abogado';
          const lawyer = db.lawyers.find((l) => l.id === ch.lawyerId);
          participantName = lawyer ? lawyer.name : 'Abogado';
        }
        items.push({
          mediationId: m.id, mediationCode: m.code, mediationObject: m.object,
          channelCode: ch.code, type, participantName,
          lastMessage: last, unreadCount: unreadCountFor(db, ch.id, user.id),
        });
      }
    }
    items.sort((a, b) => (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0));
    let filtered = items;
    const needle = (q || '').trim().toLowerCase();
    if (needle) {
      filtered = items.filter((it) =>
        it.mediationCode.toLowerCase().includes(needle) ||
        it.mediationObject.toLowerCase().includes(needle) ||
        it.participantName.toLowerCase().includes(needle) ||
        (it.lastMessage.text || '').toLowerCase().includes(needle)
      );
    }
    return filtered.slice(0, limit);
  }

  // límite duro (no solo el default) — evitar que alguien pida ?limit=99999
  // y fuerce recorrer/serializar de más (spec §20, performance).
  router.get('/inbox', requireAuth, (req, res) => {
    const db = getDB();
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    res.json(buildCommunicationsInbox(db, req.user, { limit, q: req.query.q }));
  });

  // Herramientas Legales — Control de vencimientos, cruzando TODAS las
  // mediaciones del usuario (no una por una). Tiene que registrarse antes
  // de '/:id' — si no, Express la confundiría con el id de una mediación.
  router.get('/legal-tools/vencimientos', requireAuth, (req, res) => {
    const db = getDB();
    const mine = getMyMediations(db, req.user).filter((m) => !m.closedAt);
    res.json(buildVencimientosPanel(db, mine));
  });

  // ---------- expediente (registro básico — el resumen agregado con
  // partes/audiencias/etc es el Bloque 3, acá todavía no existen esas
  // tablas) ----------
  router.get('/:id', requireAuth, requireMediationAccess, (req, res) => {
    res.json(serializeMediation(req.mediation));
  });

  // Herramientas Legales — Auditor de expediente (solo lectura, cualquiera
  // con acceso a la mediación puede consultarlo, igual que el resto de las
  // pantallas de detalle — no requiere permiso de edición).
  router.get('/:id/audit', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const checks = auditMediation(db, req.mediation);
    const counts = { ok: 0, pendiente: 0, inconsistencia: 0, no_aplica: 0 };
    checks.forEach((c) => { counts[c.status] = (counts[c.status] || 0) + 1; });
    res.json({ checks, counts });
  });

  // Herramientas Legales — Generador de actas: "validación previa" (spec
  // §4) de qué tipos de acta se pueden generar para ESTE expediente en
  // este momento, y con qué audiencia puntual en los tres tipos que
  // dependen de una. Solo lectura — no genera nada acá, el frontend
  // decide qué mostrar habilitado/deshabilitado con esto.
  router.get('/:id/legal-tools/actas', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const mediation = req.mediation;
    const hearings = db.hearings.filter((h) => h.mediationId === mediation.id).sort((a, b) => a.date.localeCompare(b.date));
    const parties = db.parties.filter((p) => p.mediationId === mediation.id && p.status === 'activa');

    const apertura = {
      eligible: parties.length > 0,
      reason: parties.length > 0 ? null : 'Todavía no hay partes cargadas en el expediente.',
    };

    const closed = !!mediation.closedAt;
    const conAcuerdo = ['acuerdo_total', 'acuerdo_parcial'].includes(mediation.closedResult);
    const cierre = {
      eligible: closed,
      reason: closed ? null : 'La mediación todavía no está cerrada.',
      resultLabel: closed ? (conAcuerdo ? 'con acuerdo' : 'sin acuerdo') : null,
    };

    const audienciaHearings = hearings.map((h) => ({ id: h.id, date: h.date, startTime: h.startTime, status: h.status }));
    const audiencia = { eligible: audienciaHearings.length > 0, hearings: audienciaHearings };

    const noShowHearings = hearings.filter((h) => h.status === 'no_realizada').map((h) => ({ id: h.id, date: h.date, startTime: h.startTime }));
    const incomparecencia = { eligible: noShowHearings.length > 0, hearings: noShowHearings };

    const rescheduleHearings = hearings
      .map((h) => {
        const events = db.mediationEvents
          .filter((e) => e.type === 'HEARING_RESCHEDULED' && e.entityId === h.id)
          .sort((a, b) => b.createdAt - a.createdAt);
        if (!events.length) return null;
        const meta = events[0].metadata || {};
        return { id: h.id, date: h.date, startTime: h.startTime, fromDate: meta.fromDate, fromStartTime: meta.fromStartTime, toDate: meta.toDate, toStartTime: meta.toStartTime };
      })
      .filter(Boolean);
    const reprogramacion = { eligible: rescheduleHearings.length > 0, hearings: rescheduleHearings };

    res.json({ apertura, cierre, audiencia, incomparecencia, reprogramacion });
  });

  // ---------- editar datos generales ----------
  router.patch('/:id', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const mediation = db.mediations.find((m) => m.id === req.mediation.id);
    const { type, object, description, internalNumber, nextActionText, nextActionResponsibleType, nextActionResponsibleId, nextActionDueDate, reminderHoursBefore, reminderChannels } = req.body || {};

    if (object !== undefined) {
      if (!object.trim()) return res.status(400).json({ error: 'El objeto no puede quedar vacío' });
      mediation.object = object.trim();
    }
    if (type !== undefined) mediation.type = type;
    if (description !== undefined) mediation.description = description;
    if (internalNumber !== undefined) mediation.internalNumber = internalNumber;

    // regla explícita: una automatización NUNCA pisa en silencio una
    // próxima acción que el mediador cargó a mano. El único llamador hoy
    // es la pantalla del mediador (source implícito 'manual') — esto es
    // infraestructura defensiva para cuando una automatización futura
    // quiera escribir acá (Bloque 11+): tiene que mandar source:'auto' Y
    // fields.force:true si quiere pisar algo que ya es 'manual'.
    const touchesNextAction = nextActionText !== undefined || nextActionResponsibleType !== undefined || nextActionResponsibleId !== undefined || nextActionDueDate !== undefined;
    const source = req.body?.source === 'auto' ? 'auto' : 'manual';
    const blockedByManual = touchesNextAction && source === 'auto' && mediation.nextActionSetBy === 'manual' && !req.body?.force;
    if (blockedByManual) {
      return res.status(409).json({ error: 'La próxima acción ya fue cargada a mano — no se sobrescribe automáticamente sin confirmación explícita (force:true)' });
    }
    if (touchesNextAction) {
      if (nextActionText !== undefined) mediation.nextActionText = nextActionText;
      if (nextActionResponsibleType !== undefined) mediation.nextActionResponsibleType = nextActionResponsibleType;
      if (nextActionResponsibleId !== undefined) mediation.nextActionResponsibleId = nextActionResponsibleId;
      if (nextActionDueDate !== undefined) mediation.nextActionDueDate = nextActionDueDate;
      mediation.nextActionSetBy = source;
    }
    // Bloque 11 — avisos configurables
    if (reminderHoursBefore !== undefined) {
      const hours = Number(reminderHoursBefore);
      if (!Number.isFinite(hours) || hours < 1 || hours > 336) {
        return res.status(400).json({ error: 'La anticipación tiene que ser entre 1 y 336 horas (2 semanas)' });
      }
      mediation.reminderHoursBefore = hours;
    }
    if (reminderChannels !== undefined) {
      const valid = reminderChannels.split(',').map((c) => c.trim()).filter(Boolean);
      if (!valid.length || !valid.every((c) => ['push', 'whatsapp'].includes(c))) {
        return res.status(400).json({ error: "Canales inválidos — usar 'push', 'whatsapp', o los dos separados por coma" });
      }
      mediation.reminderChannels = valid.join(',');
    }
    if (req.body?.upcomingDueWindowDays !== undefined) {
      const days = Number(req.body.upcomingDueWindowDays);
      if (!Number.isFinite(days) || days < 1 || days > 60) {
        return res.status(400).json({ error: 'La ventana de "próximo a vencer" tiene que ser entre 1 y 60 días' });
      }
      mediation.upcomingDueWindowDays = days;
    }
    // Bloque 22 — ventanas configurables del centro de atención (§10/§14
    // de la spec: "el período debe ser configurable"). Mismo patrón de
    // validación que upcomingDueWindowDays de arriba.
    if (req.body?.inactivityThresholdDays !== undefined) {
      const days = Number(req.body.inactivityThresholdDays);
      if (!Number.isFinite(days) || days < 1 || days > 180) {
        return res.status(400).json({ error: 'El umbral de inactividad tiene que ser entre 1 y 180 días' });
      }
      mediation.inactivityThresholdDays = days;
    }
    if (req.body?.partyNoResponseThresholdDays !== undefined) {
      const days = Number(req.body.partyNoResponseThresholdDays);
      if (!Number.isFinite(days) || days < 1 || days > 60) {
        return res.status(400).json({ error: 'El umbral de "sin respuesta" tiene que ser entre 1 y 60 días' });
      }
      mediation.partyNoResponseThresholdDays = days;
    }
    // Bloque 24 — descartar el asistente de carga guiada. Se completa acá,
    // en un solo lugar, y no se lee en ningún otro flujo del sistema (ver
    // §2 de la spec). No se contempla "des-descartar": si el mediador
    // quiere volver a ver los pasos, usa las pestañas directamente.
    if (req.body?.dismissOnboarding === true) {
      mediation.onboardingDismissedAt = Date.now();
    }

    await commit();
    res.json(serializeMediation(mediation));
  });

  // ---------- cambiar estado ----------
  router.post('/:id/status', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { status, note } = req.body || {};
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    const db = getDB();
    const mediation = db.mediations.find((m) => m.id === req.mediation.id);
    // Bloque 10: una vez cerrada, el status no se toca más por acá — antes
    // nada lo impedía, y eso podía dejar status y closedResult
    // contradiciéndose (ej. closedResult:'acuerdo_total' pero
    // status:'sin_acuerdo' si alguien lo cambiaba después). Reabrir una
    // mediación cerrada no está contemplado todavía — ver pendientes.
    if (mediation.closedAt) {
      return res.status(400).json({ error: 'Esta mediación ya está cerrada — el estado no se puede modificar por acá' });
    }
    const fromStatus = mediation.status;
    if (fromStatus === status) return res.json(serializeMediation(mediation)); // no-op silencioso, no es un error de uso

    mediation.status = status;
    db.mediationStatusHistory.push({
      id: nanoid(), mediationId: mediation.id, fromStatus, toStatus: status,
      changedBy: req.user.id, note: note || null, createdAt: Date.now(),
    });
    logMediationEvent(db, {
      mediationId: mediation.id, type: 'MEDIATION_STATUS_CHANGED', actorId: req.user.id,
      entityType: 'mediation', entityId: mediation.id,
      title: `Estado: ${fromStatus} → ${status}`, description: note || null,
      metadata: { fromStatus, toStatus: status },
    });
    await commit();
    res.json(serializeMediation(mediation));
  });

  // ---------- historial de estados (para mostrar en el expediente) ----------
  // Bloque 14 — asignación de mediaciones a mediadores/asistentes del
  // estudio. Reusa mediation_access tal cual — no se agrega ninguna
  // tabla ni columna nueva para esto. Solo admin (de estudio o de
  // plataforma) puede tocarlo — req.mediationRole ya es 'admin' para los
  // dos casos, gracias a requireMediationAccess.
  // admin de estudio (o de plataforma) puede asignar — incluye el caso de
  // que sea, ADEMÁS, el propio mediador dueño de esta mediación puntual:
  // ese caso llega acá con mediationRole:'mediador' (por el chequeo de
  // propietario en requireMediationAccess, que corre antes que la rama de
  // estudio), así que no alcanza con mirar solo mediationRole.
  function requireMediationAdmin(req, res, next) {
    const isStudioAdminOwner = req.mediation.mediatorUserId === req.user.id && req.user.studioRole === 'admin';
    if (req.mediationRole !== 'admin' && !isStudioAdminOwner) {
      return res.status(403).json({ error: 'Solo un administrador puede asignar esta mediación' });
    }
    next();
  }

  function serializeAccess(db, a) {
    const user = db.users.find((u) => u.id === a.userId);
    return { id: a.id, mediationId: a.mediationId, userId: a.userId, userName: user ? user.name : null, role: a.role, grantedBy: a.grantedBy, grantedAt: a.grantedAt };
  }

  router.get('/:id/access', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const list = db.mediationAccess.filter((a) => a.mediationId === req.mediation.id);
    res.json(list.map((a) => serializeAccess(db, a)));
  });

  router.post('/:id/access', requireAuth, requireMediationAccess, requireMediationAdmin, async (req, res) => {
    const { userId, role } = req.body || {};
    if (!['mediador', 'asistente'].includes(role)) {
      return res.status(400).json({ error: "Rol inválido para asignación — usar 'mediador' o 'asistente' (abogado se agrega desde la sección de abogados, no acá)" });
    }
    const db = getDB();
    // Bloque 14 (Parte 3): un estudio dado de baja no admite asignaciones
    // nuevas. Solo aplica si quien pide esto lo hace como admin de SU
    // estudio (no al admin de plataforma, que puede no tener estudio).
    if (req.user.studioId) {
      const requesterStudio = db.studios.find((s) => s.id === req.user.studioId);
      if (requesterStudio && requesterStudio.status !== 'activo') {
        return res.status(400).json({ error: 'El estudio está dado de baja — no se pueden hacer asignaciones nuevas' });
      }
    }
    const target = db.users.find((u) => u.id === userId);
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    // no se puede asignar a cualquiera — tiene que ser del MISMO estudio
    // que el dueño de la mediación (nunca cruzando estudios, aunque el
    // admin conozca el ID de alguien de otro equipo).
    const owner = db.users.find((u) => u.id === req.mediation.mediatorUserId);
    const studioId = owner ? owner.studioId : null;
    if (!studioId || target.studioId !== studioId) {
      return res.status(400).json({ error: 'Esa persona no pertenece al mismo estudio que esta mediación' });
    }
    if (target.id === req.mediation.mediatorUserId) {
      return res.status(400).json({ error: 'Esa persona ya es la responsable principal de esta mediación' });
    }
    // Bloque 14 (Parte 2) — nadie se asigna a sí mismo por acá, ni
    // siquiera el admin (que de todas formas ya tiene acceso general vía
    // el estudio — esto evita una fila de mediation_access redundante y
    // confusa).
    if (target.id === req.user.id) {
      return res.status(400).json({ error: 'No podés asignarte a vos mismo' });
    }
    const already = db.mediationAccess.find((a) => a.mediationId === req.mediation.id && a.userId === userId);
    if (already) return res.status(400).json({ error: 'Esa persona ya tiene acceso a esta mediación' });
    // Bloque 32 §4 — maxAssistants (entitlements.js) estaba definido desde
    // el Bloque 29 sin ningún endpoint que lo aplicara. Se cuenta sobre el
    // plan del DUEÑO de la mediación (owner), no de quien hace el pedido
    // (puede ser un admin de estudio asignando en nombre de otro mediador).
    if (role === 'asistente' && !isAdminUser(req.user) && billingPaywallActive() && !canAddAssistant(db, owner)) {
      return res.status(402).json({ error: 'Llegaste al límite de asistentes de tu plan — necesitás el plan Profesional (1) o Estudio (ilimitado).', upgradeMessage: 'Sumar un asistente requiere el plan Profesional (1) o Estudio (ilimitado).', code: 'PLAN_LIMIT_REACHED' });
    }

    const access = { id: nanoid(), mediationId: req.mediation.id, userId, role, partyId: null, grantedBy: req.user.id, grantedAt: Date.now() };
    db.mediationAccess.push(access);
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'MEDIATION_ACCESS_GRANTED', actorId: req.user.id,
      visibility: 'mediator_only', entityType: 'mediation_access', entityId: access.id,
      title: `${target.name} asignado/a como ${role}`,
    });
    await commit();
    res.json(serializeAccess(db, access));
  });

  router.delete('/:id/access/:accessId', requireAuth, requireMediationAccess, requireMediationAdmin, async (req, res) => {
    const db = getDB();
    const access = db.mediationAccess.find((a) => a.id === req.params.accessId && a.mediationId === req.mediation.id);
    if (!access) return res.status(404).json({ error: 'Asignación no encontrada en esta mediación' });
    const target = db.users.find((u) => u.id === access.userId);
    db.mediationAccess = db.mediationAccess.filter((a) => a.id !== access.id);
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'MEDIATION_ACCESS_REVOKED', actorId: req.user.id,
      visibility: 'mediator_only', entityType: 'mediation_access', entityId: access.id,
      title: `Se quitó el acceso de ${target ? target.name : 'un usuario'}`,
    });
    await commit();
    res.json({ ok: true });
  });

  router.get('/:id/status-history', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const history = db.mediationStatusHistory
      .filter((h) => h.mediationId === req.mediation.id)
      .sort((a, b) => a.createdAt - b.createdAt);
    res.json(history);
  });

  // Bloque 22 §1/§2 — mismo feed del centro de atención del dashboard,
  // acotado a ESTA mediación puntual (para mostrarlo en el expediente).
  router.get('/:id/attention', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    res.json(getMediationAttentionItems(db, req.mediation));
  });

  // "descartar alerta" — solo tiene sentido para las situaciones que no
  // tienen un registro propio para resolver (a diferencia de una tarea o
  // un compromiso, que se marcan completados). Nunca borra el dato de
  // origen — solo oculta la alerta hasta que la situación cambie de
  // verdad (ver isAlertDismissed en automationEngine.js).
  const DISMISSABLE_ALERT_TYPES = ['mediacionInactiva', 'parteSinRespuesta'];
  router.post('/:id/attention/:alertType/:refId/dismiss', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    if (!DISMISSABLE_ALERT_TYPES.includes(req.params.alertType)) {
      return res.status(400).json({ error: 'Este tipo de alerta no se puede descartar — resolvela desde su propia acción (tarea, compromiso, etc.)' });
    }
    const db = getDB();
    db.attentionDismissals.push({
      id: nanoid(), mediationId: req.mediation.id, alertType: req.params.alertType, refId: req.params.refId,
      dismissedBy: req.user.id, dismissedAt: Date.now(),
    });
    await commit();
    res.json({ ok: true });
  });

  // Bloque 12 — asistente de ESTA mediación puntual ("¿qué pasó en esta
  // mediación?", "preparame un resumen"). Reusa buildMediationPlainContent
  // de certificate.js — el mismo texto que arma el informe certificado, no
  // una segunda versión de la misma lógica.
  router.post('/:id/assistant', requireAuth, requireMediationAccess, async (req, res) => {
    const { question } = req.body || {};
    if (!question || !question.trim()) return res.status(400).json({ error: 'Falta la pregunta' });
    const db = getDB();
    const mediation = req.mediation;
    try {
      const parties = db.parties.filter((p) => p.mediationId === mediation.id);
      const lawyers = db.lawyers.filter((l) => l.mediationId === mediation.id);
      const hearings = db.hearings.filter((h) => h.mediationId === mediation.id);
      const documents = db.documents.filter((d) => d.mediationId === mediation.id);
      const commitments = db.commitments.filter((c) => c.mediationId === mediation.id);
      // el asistente NUNCA ve eventos mediator_only si quien pregunta no
      // tiene ese nivel de acceso — mismo chequeo que ya usa GET /:id/timeline.
      const canSeePrivate = ['mediador', 'admin', 'asistente'].includes(req.mediationRole);
      let timeline = db.mediationEvents.filter((e) => e.mediationId === mediation.id);
      if (!canSeePrivate) timeline = timeline.filter((e) => e.visibility === 'public');
      timeline = timeline.sort((a, b) => a.createdAt - b.createdAt);

      const context = buildMediationPlainContent({ mediation, parties, lawyers, hearings, documents, commitments, timeline });
      const answer = await askMediationAssistant(question.trim(), context);
      res.json({ answer });
    } catch (err) {
      console.error('Error en el asistente de mediación:', err);
      res.status(500).json({ error: 'No se pudo consultar al asistente' });
    }
  });

  // Bloque 22 (Parte 4.1) — resumen de un documento, a pedido del
  // mediador (nunca automático al subir). Mismo nivel de permiso que
  // /assistant — cualquiera con acceso a la mediación puede pedirlo,
  // no hace falta ser edición.
  router.post('/:id/documents/:docId/summarize', requireAuth, requireMediationAccess, async (req, res) => {
    const db = getDB();
    const mediation = req.mediation;
    const doc = db.documents.find((d) => d.id === req.params.docId && d.mediationId === mediation.id);
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado en esta mediación' });
    const filePath = path.join(UPLOADS_ROOT, mediation.id, doc.storagePath);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'El archivo ya no está disponible' });
    try {
      const parties = db.parties.filter((p) => p.mediationId === mediation.id);
      const lawyers = db.lawyers.filter((l) => l.mediationId === mediation.id);
      const hearings = db.hearings.filter((h) => h.mediationId === mediation.id);
      const documents = db.documents.filter((d) => d.mediationId === mediation.id);
      const commitments = db.commitments.filter((c) => c.mediationId === mediation.id);
      const context = buildMediationPlainContent({ mediation, parties, lawyers, hearings, documents, commitments, timeline: [] });
      const fileBuffer = fs.readFileSync(filePath);
      const ext = path.extname(doc.originalFilename || '');
      const result = await askMediationAssistantAboutDocument({ fileBuffer, fileExt: ext, filename: doc.originalFilename, mediationContext: context });
      res.json(result);
    } catch (err) {
      console.error('Error resumiendo documento:', err);
      res.status(500).json({ error: 'No se pudo generar el resumen' });
    }
  });

  // Bloque 22 (Parte 4.2) — sugerencias de tareas/compromisos desde una
  // nota libre. Devuelve sugerencias, NUNCA crea nada — la creación real
  // sigue pasando por POST /:id/tasks y POST /:id/commitments, ya
  // existentes, sin ningún cambio.
  router.post('/:id/suggest-tasks', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { note } = req.body || {};
    if (!note || !note.trim()) return res.status(400).json({ error: 'Falta la nota' });
    const db = getDB();
    const mediation = req.mediation;
    try {
      const parties = db.parties.filter((p) => p.mediationId === mediation.id);
      const lawyers = db.lawyers.filter((l) => l.mediationId === mediation.id);
      const hearings = db.hearings.filter((h) => h.mediationId === mediation.id);
      const documents = db.documents.filter((d) => d.mediationId === mediation.id);
      const commitments = db.commitments.filter((c) => c.mediationId === mediation.id);
      const context = buildMediationPlainContent({ mediation, parties, lawyers, hearings, documents, commitments, timeline: [] });
      const suggestions = await suggestTasksFromNote(note.trim(), context);
      res.json({ suggestions });
    } catch (err) {
      console.error('Error sugiriendo tareas desde nota:', err);
      res.status(500).json({ error: 'No se pudieron generar sugerencias' });
    }
  });

  // ================= Bloque 4: partes, abogados, audiencias =================

  function partyDisplayName(db, partyId) {
    const p = db.parties.find((x) => x.id === partyId);
    if (!p) return null;
    return p.legalName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || null;
  }

  function serializeParty(p) {
    return {
      id: p.id, mediationId: p.mediationId, type: p.type, role: p.role,
      firstName: p.firstName, lastName: p.lastName, legalName: p.legalName,
      documentType: p.documentType, documentNumber: p.documentNumber, taxId: p.taxId,
      email: p.email, phone: p.phone, address: p.address, status: p.status,
      linkedUserId: p.linkedUserId || null, notes: p.notes,
      allowDocumentUpload: p.allowDocumentUpload !== false, // default true — no romper partes creadas antes de este campo
      portalToken: p.portalToken || null, createdAt: p.createdAt,
    };
  }
  function serializeLawyer(l) {
    return {
      id: l.id, mediationId: l.mediationId, partyId: l.partyId, name: l.name,
      enrollmentNumber: l.enrollmentNumber, barAssociation: l.barAssociation,
      email: l.email, phone: l.phone, portalToken: l.portalToken || null, createdAt: l.createdAt,
    };
  }
  function serializeHearing(h, confirmations) {
    const db = getDB();
    return {
      id: h.id, mediationId: h.mediationId, date: h.date, startTime: h.startTime, endTime: h.endTime,
      type: h.type, modality: h.modality, location: h.location, meetingUrl: h.meetingUrl,
      status: h.status, notes: h.notes, proposalGroupId: h.proposalGroupId || null, targetPartyId: h.targetPartyId || null,
      lastModifiedByName: h.lastModifiedBy ? (db.users.find((u) => u.id === h.lastModifiedBy)?.name || null) : null,
      lastModifiedAt: h.lastModifiedAt || null, createdAt: h.createdAt,
      // Bloque 28 — hostUrl/meetingMetadata NUNCA salen de acá hacia
      // portal de parte/abogado (esos serializers, en sus propios
      // archivos, whitelistean sus campos aparte y no llaman a esta
      // función) — esto es para el mediador/equipo únicamente.
      video: serializeHearingVideo(h),
      confirmations: (confirmations || []).map((c) => ({
        id: c.id, partyId: c.partyId, response: c.response, respondedAt: c.respondedAt,
      })),
    };
  }

  // ---------- partes ----------
  router.get('/:id/parties', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const list = db.parties.filter((p) => p.mediationId === req.mediation.id).sort((a, b) => a.createdAt - b.createdAt);
    res.json(list.map(serializeParty));
  });

  router.post('/:id/parties', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { type, role, firstName, lastName, legalName, documentType, documentNumber, taxId, email, phone, address, notes } = req.body || {};
    if (!role || !['requirente', 'requerido', 'otro'].includes(role)) {
      return res.status(400).json({ error: 'Falta el rol de la parte (requirente/requerido/otro)' });
    }
    if (!firstName && !legalName) {
      return res.status(400).json({ error: 'Falta el nombre de la parte (persona o razón social)' });
    }
    const db = getDB();
    const party = {
      id: nanoid(), mediationId: req.mediation.id, type: type || 'persona', role,
      firstName: firstName || null, lastName: lastName || null, legalName: legalName || null,
      documentType: documentType || null, documentNumber: documentNumber || null, taxId: taxId || null,
      email: email || null, phone: phone || null, address: address || null,
      status: 'activa', linkedUserId: null, allowDocumentUpload: true, notes: notes || null, createdAt: Date.now(),
    };
    db.parties.push(party);
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'PARTY_ADDED', actorId: req.user.id,
      entityType: 'party', entityId: party.id,
      title: `Parte agregada: ${party.legalName || `${party.firstName || ''} ${party.lastName || ''}`.trim()}`,
    });
    await commit();
    res.json(serializeParty(party));
  });

  router.patch('/:id/parties/:partyId', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const party = db.parties.find((p) => p.id === req.params.partyId && p.mediationId === req.mediation.id);
    if (!party) return res.status(404).json({ error: 'Parte no encontrada en esta mediación' });
    const fields = ['type', 'role', 'firstName', 'lastName', 'legalName', 'documentType', 'documentNumber', 'taxId', 'email', 'phone', 'address', 'status', 'notes'];
    for (const f of fields) if (req.body?.[f] !== undefined) party[f] = req.body[f];
    if (req.body?.allowDocumentUpload !== undefined) party.allowDocumentUpload = !!req.body.allowDocumentUpload;
    // si la parte ya tiene un usuario invitado (se unió al portal) y se le
    // cambia el teléfono acá, se sincroniza — si no, el WhatsApp de
    // notificaciones le seguiría llegando al número viejo o a ninguno.
    if (req.body?.phone !== undefined && party.linkedUserId) {
      const linkedUser = db.users.find((u) => u.id === party.linkedUserId);
      if (linkedUser) linkedUser.phone = req.body.phone;
    }
    await commit();
    res.json(serializeParty(party));
  });

  // Bloque 7 — genera (o regenera) el token del portal para esta parte.
  // Regenerar invalida el link anterior a propósito — si se filtró o se
  // mandó a la persona equivocada, tiene que poder cortarse el acceso
  // viejo sin depender de que nadie más lo haya guardado.
  router.post('/:id/parties/:partyId/invite', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const party = db.parties.find((p) => p.id === req.params.partyId && p.mediationId === req.mediation.id);
    if (!party) return res.status(404).json({ error: 'Parte no encontrada en esta mediación' });

    // Bloque 9 — arquitectura hub-and-spoke diseñada en §7b del plan: esta
    // parte necesita (a) alguien que "sea" del lado de los mensajes
    // (senderId), igual que ya hace guest.js para coparentalidad, y (b) su
    // propio hilo — un canal con partyId seteado, distinto del canal
    // general de la mediación — donde solo ella y el mediador escriben.
    if (!party.linkedUserId) {
      const partyUser = {
        id: nanoid(), googleId: null, email: party.email || '', phone: party.phone || '',
        name: partyDisplayName(db, party.id) || 'Parte', avatar: '', createdAt: Date.now(), guest: true,
      };
      db.users.push(partyUser);
      party.linkedUserId = partyUser.id;
    }

    let thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.partyId === party.id);
    if (!thread) {
      thread = {
        id: nanoid(), code: genCode(), guestToken: null, calendarToken: nanoid(24),
        status: 'abierto', mediationId: req.mediation.id, partyId: party.id, createdAt: Date.now(),
      };
      db.channels.push(thread);
      db.members.push({ id: nanoid(), channelId: thread.id, userId: req.mediation.mediatorUserId, role: 'mediador', joinedAt: Date.now() });
      db.members.push({ id: nanoid(), channelId: thread.id, userId: party.linkedUserId, role: 'parte', joinedAt: Date.now() });
    }

    party.portalToken = nanoid(24);
    const portalUrl = `/portal.html?token=${party.portalToken}`;
    const inviteEvent = logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'PARTY_INVITED', actorId: req.user.id,
      entityType: 'party', entityId: party.id, title: `Invitación al portal generada para ${partyDisplayName(db, party.id)}`,
    });

    // Bloque 32 §1 — antes esto terminaba acá y el mediador copiaba el
    // link a mano, por fuera de la plataforma (la trazabilidad se rompía
    // en el primer paso de cada expediente). Reusa notifyParty tal cual
    // (mismo sendText/logWhatsappEvent que ya usan los recordatorios de
    // audiencia) — nunca un canal nuevo. Si no hay teléfono cargado,
    // notifyParty ya registra 'notification_unavailable' en whatsappLog,
    // que es EXACTAMENTE lo que el dashboard ya lee para "fallosNotificacion"
    // — no hace falta un tipo de alerta nuevo en automationEngine.js.
    const notifyResult = await notifyParty(db, party, `${partyDisplayName(db, party.id) || 'Hola'}: te invitaron a seguir la mediación "${req.mediation.object}" (${req.mediation.code}) en Mediador. Entrá acá: ${baseUrl()}${portalUrl}`);
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'PARTY_INVITE_NOTIFIED', actorId: null,
      entityType: 'party', entityId: party.id, causedByEventId: inviteEvent.id,
      title: notifyResult.status === 'enviado' ? `Invitación enviada por WhatsApp a ${partyDisplayName(db, party.id)}` : `No se pudo avisar automáticamente a ${partyDisplayName(db, party.id)}`,
      description: notifyResult.status === 'enviado' ? null : (notifyResult.status === 'no_disponible' ? 'Sin teléfono cargado o nunca se unió al portal — compartí el link manualmente.' : 'Falló el envío por WhatsApp — compartí el link manualmente.'),
    });
    // deja constancia en el propio hilo de la parte (Comunicaciones), no
    // solo en el timeline — así queda visible ahí mismo sin tener que
    // buscar en dos pantallas distintas.
    await postSystemMessage(io, thread, notifyResult.status === 'enviado'
      ? 'Se envió la invitación al portal por WhatsApp.'
      : 'No se pudo enviar la invitación automáticamente — compartí el link manualmente.',
      notifyResult.status === 'enviado' ? 'whatsapp' : 'sistema');
    await commit();
    res.json({ portalToken: party.portalToken, portalUrl, notified: notifyResult.status === 'enviado' });
  });

  // ---------- comunicaciones con una parte (lado del mediador) ----------
  // el hilo de esta parte, si ya se le generó uno al invitarla — nunca
  // antes, no tiene sentido un chat sin nadie del otro lado todavía.
  router.get('/:id/parties/:partyId/messages', requireAuth, requireMediationAccess, requireSupportAccessForPrivateContent, (req, res) => {
    const db = getDB();
    const thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.partyId === req.params.partyId);
    if (!thread) return res.json([]);
    const messages = db.messages.filter((m) => m.channelId === thread.id).sort((a, b) => a.createdAt - b.createdAt);
    res.json(messages.map((m) => serializeMediatorMessage(db, m, req.mediation.id)));
  });

  router.post('/:id/parties/:partyId/messages', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { text, documentId } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'Falta el texto del mensaje' });
    const db = getDB();
    const thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.partyId === req.params.partyId);
    if (!thread) return res.status(400).json({ error: 'Esta parte todavía no fue invitada al portal' });
    const doc = documentId ? db.documents.find((d) => d.id === documentId && d.mediationId === req.mediation.id) : null;
    if (documentId && !doc) return res.status(400).json({ error: 'Ese documento no pertenece a esta mediación' });
    // Bloque 19 — el Timeline no registra cada mensaje individual (eso es
    // lo que muestra Comunicaciones); solo las acciones significativas que
    // resulten de un mensaje (tarea, compromiso, reprogramación, documento).
    const msg = await postMessage(io, thread, { senderId: req.user.id, text: text.trim(), flagged: false });
    if (doc) { msg.documentId = doc.id; await commit(); }
    await commit();
    res.json(serializeMediatorMessage(db, msg, req.mediation.id));
  });

  // ---------- abogados ----------
  router.get('/:id/lawyers', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const list = db.lawyers.filter((l) => l.mediationId === req.mediation.id).sort((a, b) => a.createdAt - b.createdAt);
    res.json(list.map(serializeLawyer));
  });

  router.post('/:id/lawyers', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { partyId, name, enrollmentNumber, barAssociation, email, phone } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Falta el nombre del abogado' });
    const db = getDB();
    if (partyId) {
      const party = db.parties.find((p) => p.id === partyId && p.mediationId === req.mediation.id);
      if (!party) return res.status(400).json({ error: 'La parte indicada no existe en esta mediación' });
    }
    const lawyer = {
      id: nanoid(), mediationId: req.mediation.id, partyId: partyId || null, name: name.trim(),
      enrollmentNumber: enrollmentNumber || null, barAssociation: barAssociation || null,
      email: email || null, phone: phone || null, createdAt: Date.now(),
    };
    db.lawyers.push(lawyer);
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'LAWYER_ADDED', actorId: req.user.id,
      entityType: 'lawyer', entityId: lawyer.id,
      title: `Abogado agregado: ${lawyer.name}`,
    });
    await commit();
    res.json(serializeLawyer(lawyer));
  });

  // Portal de Abogados — genera (o reusa) el token del portal para este
  // abogado. "Evitar cuentas duplicadas para el mismo abogado": si ya
  // existe OTRO registro de abogado (en cualquier mediación) con el mismo
  // email y que ya tiene portalToken, se reusa ESE mismo token en vez de
  // generar uno nuevo — así un abogado que representa partes en varias
  // mediaciones entra una sola vez y ve todas, no un link por mediación.
  router.post('/:id/lawyers/:lawyerId/invite', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const lawyer = db.lawyers.find((l) => l.id === req.params.lawyerId && l.mediationId === req.mediation.id);
    if (!lawyer) return res.status(404).json({ error: 'Abogado no encontrado en esta mediación' });

    let token = lawyer.email
      ? db.lawyers.find((l) => l.email && l.email.toLowerCase() === lawyer.email.toLowerCase() && l.portalToken)?.portalToken
      : null;
    if (!token) token = nanoid(24);
    lawyer.portalToken = token;

    // Bloque 19 — mismo patrón que ya usa el invite de parties: una
    // identidad propia (linkedUserId, la columna ya existía pero nunca se
    // seteaba) para poder ser senderId de un mensaje, y un hilo propio
    // mediador↔abogado (channels.lawyerId, distinto del hilo de la parte
    // que representa — un abogado NO debe heredar la conversación de su
    // representado ni al revés).
    if (!lawyer.linkedUserId) {
      const lawyerUser = {
        id: nanoid(), googleId: null, email: lawyer.email || '', phone: lawyer.phone || '',
        name: lawyer.name || 'Abogado/a', avatar: '', createdAt: Date.now(), guest: true,
      };
      db.users.push(lawyerUser);
      lawyer.linkedUserId = lawyerUser.id;
    }
    let lawyerThread = db.channels.find((c) => c.mediationId === req.mediation.id && c.lawyerId === lawyer.id);
    if (!lawyerThread) {
      lawyerThread = {
        id: nanoid(), code: genCode(), guestToken: null, calendarToken: nanoid(24),
        status: 'abierto', mediationId: req.mediation.id, partyId: null, lawyerId: lawyer.id, createdAt: Date.now(),
      };
      db.channels.push(lawyerThread);
      db.members.push({ id: nanoid(), channelId: lawyerThread.id, userId: req.mediation.mediatorUserId, role: 'mediador', joinedAt: Date.now() });
      db.members.push({ id: nanoid(), channelId: lawyerThread.id, userId: lawyer.linkedUserId, role: 'abogado', joinedAt: Date.now() });
    }

    const inviteEvent = logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'LAWYER_INVITED', actorId: req.user.id,
      entityType: 'lawyer', entityId: lawyer.id, title: `Invitación al portal generada para ${lawyer.name}`,
    });

    // Bloque 32 §1 — mismo criterio que la invitación de partes, ver el
    // comentario largo en POST /:id/parties/:partyId/invite.
    const portalUrl = `/lawyer-portal.html?token=${lawyer.portalToken}`;
    const notifyResult = await notifyLawyer(db, lawyer, `${lawyer.name}: te invitaron al portal de la mediación "${req.mediation.object}" (${req.mediation.code}) en Mediador. Entrá acá: ${baseUrl()}${portalUrl}`);
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'LAWYER_INVITE_NOTIFIED', actorId: null,
      entityType: 'lawyer', entityId: lawyer.id, causedByEventId: inviteEvent.id,
      title: notifyResult.status === 'enviado' ? `Invitación enviada por WhatsApp a ${lawyer.name}` : `No se pudo avisar automáticamente a ${lawyer.name}`,
      description: notifyResult.status === 'enviado' ? null : 'Sin teléfono cargado o falló el envío — compartí el link manualmente.',
    });
    await postSystemMessage(io, lawyerThread, notifyResult.status === 'enviado'
      ? 'Se envió la invitación al portal por WhatsApp.'
      : 'No se pudo enviar la invitación automáticamente — compartí el link manualmente.',
      notifyResult.status === 'enviado' ? 'whatsapp' : 'sistema');
    await commit();
    res.json({ portalToken: lawyer.portalToken, portalUrl, notified: notifyResult.status === 'enviado' });
  });

  // ---------- comunicaciones con un abogado (lado del mediador) ----------
  // Distinto del hilo de la parte que representa a propósito (Bloque 19:
  // "una comunicación dirigida específicamente a un abogado NO debe
  // aparecer automáticamente a la parte").
  router.get('/:id/lawyers/:lawyerId/messages', requireAuth, requireMediationAccess, requireSupportAccessForPrivateContent, (req, res) => {
    const db = getDB();
    const thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.lawyerId === req.params.lawyerId);
    if (!thread) return res.json([]);
    const now = Date.now();
    const messages = db.messages
      .filter((m) => m.channelId === thread.id)
      .filter((m) => !m.senderId || m.senderId === req.user.id || (m.deliverAt || 0) <= now)
      .sort((a, b) => a.createdAt - b.createdAt);
    res.json(messages.map((m) => serializeMediatorMessage(db, m, req.mediation.id)));
  });

  router.post('/:id/lawyers/:lawyerId/messages', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { text, documentId } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'Falta el texto del mensaje' });
    const db = getDB();
    const thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.lawyerId === req.params.lawyerId);
    if (!thread) return res.status(400).json({ error: 'Este abogado todavía no fue invitado al portal' });
    const doc = documentId ? db.documents.find((d) => d.id === documentId && d.mediationId === req.mediation.id) : null;
    if (documentId && !doc) return res.status(400).json({ error: 'Ese documento no pertenece a esta mediación' });
    // Bloque 19 — mismo criterio que el hilo de partes: el Timeline no
    // registra cada mensaje, solo lo que resulte en tarea/compromiso/etc.
    const msg = await postMessage(io, thread, { senderId: req.user.id, text: text.trim(), flagged: false });
    if (doc) { msg.documentId = doc.id; await commit(); }
    await commit();
    res.json(serializeMediatorMessage(db, msg, req.mediation.id));
  });

  // ---------- comunicación interna del equipo ----------
  // Un solo canal por mediación (mediationId seteado, partyId Y lawyerId
  // ambos null) — nunca visible para partes ni abogados, ninguna ruta de
  // portal lo expone. Se crea recién al primer mensaje, no al abrir el
  // expediente (Bloque 19: "no crear duplicados").
  function getOrCreateInternalThread(db, mediation) {
    let thread = db.channels.find((c) => c.mediationId === mediation.id && !c.partyId && !c.lawyerId);
    if (!thread) {
      thread = {
        id: nanoid(), code: genCode(), guestToken: null, calendarToken: null,
        status: 'abierto', mediationId: mediation.id, partyId: null, lawyerId: null, createdAt: Date.now(),
      };
      db.channels.push(thread);
      db.members.push({ id: nanoid(), channelId: thread.id, userId: mediation.mediatorUserId, role: 'mediador', joinedAt: Date.now() });
    }
    return thread;
  }

  router.get('/:id/internal/messages', requireAuth, requireMediationAccess, requireSupportAccessForPrivateContent, (req, res) => {
    const db = getDB();
    const thread = db.channels.find((c) => c.mediationId === req.mediation.id && !c.partyId && !c.lawyerId);
    if (!thread) return res.json([]);
    const messages = db.messages.filter((m) => m.channelId === thread.id).sort((a, b) => a.createdAt - b.createdAt);
    res.json(messages.map((m) => serializeMediatorMessage(db, m, req.mediation.id)));
  });

  router.post('/:id/internal/messages', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { text, documentId } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'Falta el texto del mensaje' });
    const db = getDB();
    const thread = getOrCreateInternalThread(db, req.mediation);
    // quien escribe queda como miembro del canal interno — así el resto
    // del equipo asignado (aunque no haya sido agregado al crearse) puede
    // seguir el hilo si en algún momento se conecta por socket.
    if (!db.members.some((m) => m.channelId === thread.id && m.userId === req.user.id)) {
      db.members.push({ id: nanoid(), channelId: thread.id, userId: req.user.id, role: req.mediationRole === 'admin' ? 'mediador' : req.mediationRole, joinedAt: Date.now() });
    }
    const doc = documentId ? db.documents.find((d) => d.id === documentId && d.mediationId === req.mediation.id) : null;
    if (documentId && !doc) return res.status(400).json({ error: 'Ese documento no pertenece a esta mediación' });
    // Bloque 19 — mismo criterio: sin entrada de Timeline por mensaje.
    const msg = await postMessage(io, thread, { senderId: req.user.id, text: text.trim(), flagged: false });
    if (doc) { msg.documentId = doc.id; }
    await commit();
    res.json(serializeMediatorMessage(db, msg, req.mediation.id));
  });

  // ---------- lista de conversaciones (pantalla "Comunicaciones") ----------
  // Junta los tres tipos de hilo (parte/abogado/interno) en una sola
  // lista, cada uno con su último mensaje y no-leídos — mismo cálculo de
  // "no leído" que ya usa routes/channels.js (readAt recíproco), no una
  // tabla de estado nueva. El canal interno aparece siempre, aunque
  // todavía no tenga ni un mensaje, para que se pueda arrancar uno.
  function unreadCountFor(db, channelId, userId) {
    return db.messages.filter((m) => m.channelId === channelId && m.senderId && m.senderId !== userId && !m.readAt).length;
  }
  function lastMessagePreview(db, channelId) {
    const msgs = db.messages.filter((m) => m.channelId === channelId).sort((a, b) => b.createdAt - a.createdAt);
    if (!msgs.length) return null;
    const last = msgs[0];
    const text = last.text || (last.documentId ? '📎 Documento adjunto' : '');
    return { text: text.length > 60 ? text.slice(0, 60) + '…' : text, createdAt: last.createdAt };
  }
  router.get('/:id/communications', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const conversations = [];

    for (const party of db.parties.filter((p) => p.mediationId === req.mediation.id)) {
      const thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.partyId === party.id);
      if (!thread) continue; // todavía no fue invitada — no hay conversación que mostrar
      conversations.push({
        type: 'parte', code: thread.code, participantId: party.id, participantName: partyDisplayName(db, party.id),
        lastMessage: lastMessagePreview(db, thread.id), unreadCount: unreadCountFor(db, thread.id, req.user.id),
      });
    }
    for (const lawyer of db.lawyers.filter((l) => l.mediationId === req.mediation.id)) {
      const thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.lawyerId === lawyer.id);
      if (!thread) continue;
      conversations.push({
        type: 'abogado', code: thread.code, participantId: lawyer.id, participantName: lawyer.name,
        lastMessage: lastMessagePreview(db, thread.id), unreadCount: unreadCountFor(db, thread.id, req.user.id),
      });
    }
    const internalThread = db.channels.find((c) => c.mediationId === req.mediation.id && !c.partyId && !c.lawyerId);
    conversations.push({
      type: 'interno', code: internalThread ? internalThread.code : null, participantId: null, participantName: 'Equipo interno',
      lastMessage: internalThread ? lastMessagePreview(db, internalThread.id) : null,
      unreadCount: internalThread ? unreadCountFor(db, internalThread.id, req.user.id) : 0,
    });

    conversations.sort((a, b) => (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0));
    res.json(conversations);
  });

  // marca como leídos todos los mensajes pendientes de UN hilo de esta
  // mediación — mismo criterio recíproco que POST /:code/messages/read-all
  // de routes/channels.js, pero resuelto por mediationId (nunca confiar en
  // que el :code de la URL sea realmente de esta mediación).
  router.post('/:id/communications/:code/read-all', requireAuth, requireMediationAccess, async (req, res) => {
    const db = getDB();
    const thread = db.channels.find((c) => c.code === req.params.code.toUpperCase() && c.mediationId === req.mediation.id);
    if (!thread) return res.status(404).json({ error: 'Conversación no encontrada en esta mediación' });
    if (req.user.readReceiptsEnabled === false) return res.json({ updated: 0 });
    const toMark = db.messages.filter((m) => m.channelId === thread.id && m.senderId && m.senderId !== req.user.id && !m.readAt);
    if (!toMark.length) return res.json({ updated: 0 });
    const now = Date.now();
    toMark.forEach((m) => { m.readAt = now; });
    await commit();
    toMark.forEach((m) => io.to(thread.code).emit('message:read', { id: m.id, readAt: now }));
    res.json({ updated: toMark.length });
  });

  // ---------- audiencias ----------
  // Bloque 15 (Parte 3) §1-3 — checklist de preparación, calculado en
  // vivo desde datos existentes. Bloque 22 — la función se movió a
  // automationEngine.js (getHearingPreparationState) para poder
  // reutilizarla desde el centro de atención del dashboard sin duplicar
  // el criterio acá; esta ruta ahora solo la llama.
  router.get('/:id/hearings/:hearingId/preparation', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === req.mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    const confirmations = db.hearingConfirmations.filter((c) => c.hearingId === hearing.id);
    res.json({
      ...getHearingPreparationState(db, req.mediation, hearing),
      // Bloque 32 §3 — la pantalla de preparación necesita los datos
      // básicos de la audiencia (fecha/modalidad/video) en la misma
      // llamada; reusa serializeHearing tal cual, nunca un segundo cálculo.
      hearing: serializeHearing(hearing, confirmations),
    });
  });

  // Bloque 15 (Parte 3) §15 — resumen accionable, no todo el expediente.
  router.get('/:id/hearings/:hearingId/summary', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === req.mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    const mediation = req.mediation;
    const confirmations = db.hearingConfirmations.filter((c) => c.hearingId === hearing.id);
    const lawyers = db.lawyers.filter((l) => l.mediationId === mediation.id);
    // preparación por parte (§9) — nunca cruza información de otra parte, esto es SOLO para el mediador
    const perParty = db.parties.filter((p) => p.mediationId === mediation.id).map((p) => {
      const confirmation = confirmations.find((c) => c.partyId === p.id);
      const lawyer = lawyers.find((l) => l.partyId === p.id);
      const requests = db.hearingRescheduleRequests.filter((r) => r.hearingId === hearing.id && r.requestedByPartyId === p.id);
      const commitments = db.commitments.filter((c) => c.mediationId === mediation.id && c.partyId === p.id && ['pendiente', 'vencido'].includes(c.status));
      return {
        partyId: p.id, partyName: partyDisplayName(db, p.id),
        confirmation: confirmation ? confirmation.response : null,
        lawyerName: lawyer ? lawyer.name : null,
        pendingRequests: requests.filter((r) => r.status === 'pendiente').length,
        pendingCommitments: commitments.length,
      };
    });
    const relevantDocuments = db.documents.filter((d) => d.mediationId === mediation.id).map(serializeDocument).filter((d) => d.isCurrentVersion);
    const pendingTasks = db.tasks.filter((t) => t.mediationId === mediation.id && ['pendiente', 'en_proceso'].includes(t.status)).map(serializeTask);
    const pendingRequests = db.hearingRescheduleRequests.filter((r) => r.hearingId === hearing.id && r.status === 'pendiente').map(serializeRescheduleRequest);

    res.json({
      hearing: serializeHearing(hearing, confirmations),
      preparation: getHearingPreparationState(db, mediation, hearing),
      perParty,
      documentosRelevantes: relevantDocuments,
      tareasPendientes: pendingTasks,
      solicitudesPendientes: pendingRequests,
      proximaAccion: { text: mediation.nextActionText || null, dueDate: mediation.nextActionDueDate || null },
    });
  });

  router.get('/:id/hearings', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const list = db.hearings.filter((h) => h.mediationId === req.mediation.id).sort((a, b) => a.date.localeCompare(b.date));
    res.json(list.map((h) => serializeHearing(h, db.hearingConfirmations.filter((c) => c.hearingId === h.id))));
  });

  // regla del motor operativo (IMPLEMENTATION_PLAN.md §3.11):
  // HEARING_SCHEDULED -> genera una fila de confirmación pendiente por
  // cada parte activa de la mediación, automático, en el mismo request.
  // Bloque 15 (Parte 3) §6 — coherencia modalidad↔datos. Se define UNA
  // vez, se usa en creación y en propuesta — nunca duplicada.
  //
  // Decisión importante, documentada acá: solo se exige meetingUrl para
  // 'virtual' — es la única combinación donde la audiencia literalmente
  // no se puede llevar a cabo sin el dato (nadie tiene dónde entrar).
  // 'presencial'/'hibrida' NO exigen location de forma dura: la
  // ubicación siempre fue un campo opcional desde el Bloque 4, y
  // convertirlo en obligatorio ahora rompería cualquier audiencia
  // presencial creada sin dirección todavía definida (un caso común:
  // agendar el día y cargar el lugar después). "Si el modelo lo define
  // así" (spec) — este modelo, tal como ya existía, no lo define así.
  // Bloque 28 — "virtual" sigue exigiendo ALGUNA forma de videoconferencia
  // (spec §5: nadie tiene dónde entrar sin esto), pero ahora eso puede
  // venir de un `meetingUrl` cargado a mano (como siempre) O de un
  // `provider` que Mediador usa para crear la reunión — nunca de los dos
  // a la vez de forma contradictoria.
  function validateModalityData(modality, location, meetingUrl, provider) {
    if (modality === 'virtual' && !meetingUrl && !provider) {
      return 'Modalidad virtual requiere un link de reunión (meetingUrl) o un proveedor de videoconferencia';
    }
    return null;
  }

  router.post('/:id/hearings', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { date, startTime, endTime, durationMinutes, type, modality, location, meetingUrl, provider, notes } = req.body || {};
    if (!date) return res.status(400).json({ error: 'Falta la fecha de la audiencia' });
    const modalityError = validateModalityData(modality || 'presencial', location, meetingUrl, provider);
    if (modalityError) return res.status(400).json({ error: modalityError });
    const db = getDB();

    // Bloque 29 §17 — paywall contextual: un proveedor REAL de
    // videoconferencia (Google Meet/Zoom/Teams) es una función paga; el
    // enlace manual de siempre (provider ausente o 'manual') sigue gratis
    // para todos los planes, nunca se bloquea acá.
    if (provider && provider !== 'manual' && !isAdminUser(req.user) && billingPaywallActive() && !canUseVideoMeetings(db, req.user)) {
      return res.status(402).json({
        error: 'Las videoconferencias integradas están disponibles en el plan Profesional.',
        upgradeMessage: 'Esta función está disponible en el plan Profesional.',
        code: 'PLAN_LIMIT_REACHED',
      });
    }

    // Bloque 15 — duración: reusa endTime (ya existía en el esquema desde
    // el Bloque 4, nunca se poblaba). Si mandan duración en vez de
    // endTime directo, se calcula acá — no se agrega ningún campo nuevo.
    let computedEndTime = endTime || null;
    if (!computedEndTime && startTime && durationMinutes) {
      const startMin = toMinutes(startTime);
      if (startMin != null) {
        const endMin = startMin + Number(durationMinutes);
        computedEndTime = `${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
      }
    }

    // Bloque 15 — el backend rechaza el conflicto, no solo lo advierte
    // (spec §4: "no confiar solamente en la interfaz"). El chequeo es
    // contra la agenda del MEDIADOR RESPONSABLE de esta mediación, no de
    // quien hace el pedido (puede ser un asistente agendando por él).
    if (startTime) {
      const conflicts = checkHearingConflicts(db, {
        mediatorUserId: req.mediation.mediatorUserId, date, startTime, endTime: computedEndTime,
      });
      if (conflicts.length > 0) {
        return res.status(409).json({ error: 'Hay un conflicto de horario para el mediador responsable de esta mediación', conflicts });
      }
    }

    const hearing = {
      id: nanoid(), mediationId: req.mediation.id, date, startTime: startTime || null, endTime: computedEndTime,
      type: type || 'primera', modality: modality || 'presencial', location: location || null, meetingUrl: meetingUrl || null,
      status: 'programada', notes: notes || null, proposalGroupId: null, targetPartyId: null,
      lastModifiedBy: req.user.id, lastModifiedAt: Date.now(), createdAt: Date.now(),
      videoProvider: null, meetingId: null, hostUrl: null, meetingCreatedAt: null, meetingUpdatedAt: null,
      meetingStatus: null, meetingMetadata: null,
    };

    // Bloque 28 — se crea la reunión ANTES de persistir la audiencia
    // (spec §5): si falla y la modalidad es 'virtual' (la única donde el
    // dato es obligatorio), no se guarda una audiencia aparentemente
    // virtual sin enlace. 'hibrida' con link manual/proveedor opcional
    // puede seguir adelante aunque falle — el mediador ve el error en la
    // tarjeta y reintenta.
    if (provider || meetingUrl) {
      const videoResult = await createHearingMeeting(db, { hearing, mediation: req.mediation, provider, meetingUrl, actorId: req.user.id });
      if (!videoResult.ok && (modality || 'presencial') === 'virtual') {
        db.mediationEvents = db.mediationEvents.filter((e) => e.entityId !== hearing.id);
        return res.status(502).json({ error: videoResult.error.message, code: videoResult.error.code });
      }
    }

    db.hearings.push(hearing);

    const parties = db.parties.filter((p) => p.mediationId === req.mediation.id && p.status === 'activa');
    const confirmations = parties.map((p) => ({
      id: nanoid(), hearingId: hearing.id, partyId: p.id, response: 'pendiente',
      respondedAt: null, createdAt: Date.now(),
    }));
    db.hearingConfirmations.push(...confirmations);

    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'HEARING_SCHEDULED', actorId: req.user.id,
      entityType: 'hearing', entityId: hearing.id,
      title: `Audiencia agendada: ${fmtDateEs(hearing.date)}${hearing.startTime ? ' ' + hearing.startTime : ''}`,
      description: `Se generaron ${confirmations.length} confirmación(es) pendiente(s)`,
    });

    // Bloque 15 §6 — "actualizar la próxima acción si corresponde", pero
    // SIN pisar una que el mediador ya cargó a mano. Mismo mecanismo del
    // hardening (nextActionSetBy) — hasta ahora sin ningún llamador real;
    // esta es la primera automatización que efectivamente lo usa.
    if (req.mediation.nextActionSetBy !== 'manual') {
      // Bloque 17 §14 — texto de negocio, no ISO crudo: mismo formato
      // DD/MM/YYYY que ya usa fmtDate() en todo el frontend.
      req.mediation.nextActionText = `Preparar audiencia del ${hearing.date.split('-').reverse().join('/')}`;
      req.mediation.nextActionDueDate = hearing.date;
      req.mediation.nextActionResponsibleType = 'mediador';
      req.mediation.nextActionSetBy = 'auto';
    }

    await commit();
    res.json(serializeHearing(hearing, confirmations));
  });

  // ---------- proponer audiencia (Bloque 15 Parte 2 §1) ----------
  // Uno o varios horarios candidatos, ninguno confirmado todavía — cada
  // slot es una fila de hearings con status:'propuesta' (no una tabla
  // paralela), agrupados por proposalGroupId para poder elegir uno y
  // descartar el resto de una sola vez.
  router.post('/:id/hearings/propose', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { slots, targetPartyId, type, modality, location, meetingUrl, provider, notes } = req.body || {};
    if (!Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ error: 'Hay que mandar al menos un horario candidato' });
    }
    const db = getDB();
    const modalityError = validateModalityData(modality || 'presencial', location, meetingUrl, provider);
    if (modalityError) return res.status(400).json({ error: modalityError });
    if (targetPartyId) {
      const targetParty = db.parties.find((p) => p.id === targetPartyId && p.mediationId === req.mediation.id);
      if (!targetParty) return res.status(404).json({ error: 'Esa parte no pertenece a esta mediación' });
    }

    // Bloque 16 §7 — idempotencia real, no solo declarada: si el mismo
    // pedido (mismos horarios, mismo destinatario) llegó hace menos de 10
    // segundos para esta mediación, se asume un reintento (doble click,
    // timeout de red) y se devuelve el grupo YA creado en vez de
    // duplicar audiencias y volver a notificar. No hace falta una clave
    // de idempotencia nueva — alcanza con mirar lo que ya está en hearings.
    const slotsSignature = JSON.stringify(slots.map((s) => `${s.date}|${s.startTime || ''}`).sort());
    const recentDuplicate = db.hearings.find((h) =>
      h.mediationId === req.mediation.id && h.status === 'propuesta' &&
      (h.targetPartyId || null) === (targetPartyId || null) &&
      (Date.now() - h.createdAt) < 10000
    );
    if (recentDuplicate && recentDuplicate.proposalGroupId) {
      const siblingGroup = db.hearings.filter((h) => h.proposalGroupId === recentDuplicate.proposalGroupId);
      const siblingSignature = JSON.stringify(siblingGroup.map((h) => `${h.date}|${h.startTime || ''}`).sort());
      if (siblingSignature === slotsSignature) {
        const existingConfirmations = db.hearingConfirmations.filter((c) => siblingGroup.some((h) => h.id === c.hearingId));
        return res.json({ proposalGroupId: recentDuplicate.proposalGroupId, hearings: siblingGroup.map((h) => serializeHearing(h, existingConfirmations.filter((c) => c.hearingId === h.id))), deduplicated: true });
      }
    }

    const proposalGroupId = nanoid();
    const created = [];
    for (const slot of slots) {
      if (!slot.date) continue;
      let computedEndTime = slot.endTime || null;
      if (!computedEndTime && slot.startTime && slot.durationMinutes) {
        const startMin = toMinutes(slot.startTime);
        if (startMin != null) {
          const endMin = startMin + Number(slot.durationMinutes);
          computedEndTime = `${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
        }
      }
      const hearing = {
        id: nanoid(), mediationId: req.mediation.id, date: slot.date, startTime: slot.startTime || null, endTime: computedEndTime,
        type: type || 'primera', modality: modality || 'presencial', location: location || null, meetingUrl: meetingUrl || null,
        status: 'propuesta', notes: notes || null, proposalGroupId, targetPartyId: targetPartyId || null,
        lastModifiedBy: req.user.id, lastModifiedAt: Date.now(), createdAt: Date.now(),
        // Bloque 28 — con un proveedor real (no link manual), la reunión
        // recién se crea cuando se elige ESTE horario (confirm-proposal
        // más abajo) — spec §9 "no crear una reunión nueva innecesariamente"
        // aplica también acá: no tiene sentido crear una reunión por cada
        // candidato que después se descarta. `videoProvider` guarda la
        // intención, `meetingStatus` queda null hasta que se cree de verdad.
        // Un link manual, en cambio, no cuesta nada crear "de una" — es
        // el mismo texto para todos los candidatos.
        videoProvider: meetingUrl ? 'manual' : (provider || null), meetingId: null, hostUrl: null,
        meetingCreatedAt: meetingUrl ? Date.now() : null, meetingUpdatedAt: null,
        meetingStatus: meetingUrl ? 'creada' : null, meetingMetadata: null,
      };
      db.hearings.push(hearing);
      created.push(hearing);
    }
    if (created.length === 0) return res.status(400).json({ error: 'Ningún horario candidato tenía fecha' });

    // confirmaciones POR PROPUESTA — sirven para que cada parte marque
    // cuál opción prefiere, no como una confirmación real todavía.
    const targetParties = targetPartyId
      ? db.parties.filter((p) => p.id === targetPartyId && p.status === 'activa')
      : db.parties.filter((p) => p.mediationId === req.mediation.id && p.status === 'activa');
    const allConfirmations = [];
    for (const hearing of created) {
      const confirmations = targetParties.map((p) => ({
        id: nanoid(), hearingId: hearing.id, partyId: p.id, response: 'pendiente', respondedAt: null, createdAt: Date.now(),
      }));
      db.hearingConfirmations.push(...confirmations);
      allConfirmations.push(...confirmations);
    }

    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'HEARING_PROPOSED', actorId: req.user.id,
      entityType: 'hearing', entityId: created[0].id,
      title: `Se propusieron ${created.length} horario(s) de audiencia${targetPartyId ? ' a una parte' : ' a todas las partes'}`,
      metadata: { proposalGroupId, slotCount: created.length },
    });

    // Bloque 16 §1 — notificación real, UNA por destinatario aunque haya
    // varios horarios candidatos (no generar ruido innecesario). El
    // contenido lista las opciones, no una por mensaje.
    const optionsText = created.map((h) => `${fmtDateEs(h.date)}${h.startTime ? ' ' + h.startTime : ''}`).join(', ');
    const notifyText = `${req.mediation.code}: te proponemos audiencia (${req.mediation.type || 'mediación'}, ${modality || 'presencial'}). Opciones: ${optionsText}. Ingresá al portal para confirmar cuál te sirve.`;
    const notificationResults = [];
    for (const party of targetParties) {
      const n = await notifyPartyAboutHearing(db, party, notifyText);
      notificationResults.push({ recipient: 'party', partyId: party.id, status: n.status });
      const partyLawyers = db.lawyers.filter((l) => l.mediationId === req.mediation.id && l.partyId === party.id);
      for (const lawyer of partyLawyers) {
        const nl = await notifyLawyerAboutHearing(db, lawyer, `${req.mediation.code}: se propuso audiencia para tu representado/a. Opciones: ${optionsText}. Podés ver el detalle en el portal.`);
        notificationResults.push({ recipient: 'lawyer', lawyerId: lawyer.id, status: nl.status });
      }
    }

    await commit();
    res.json({ proposalGroupId, hearings: created.map((h) => serializeHearing(h, allConfirmations.filter((c) => c.hearingId === h.id))), notifications: notificationResults });
  });

  // el mediador elige UNA de las propuestas del grupo: esa pasa a
  // 'programada' de verdad (con confirmaciones reales, reiniciadas), las
  // demás del mismo grupo se cancelan — nunca quedan sueltas como si
  // fueran audiencias vigentes.
  router.post('/:id/hearings/:hearingId/confirm-proposal', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === req.mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    if (hearing.status !== 'propuesta') return res.status(400).json({ error: 'Esta audiencia no es una propuesta pendiente de confirmar' });

    hearing.status = 'programada';
    hearing.lastModifiedBy = req.user.id;
    hearing.lastModifiedAt = Date.now();
    const confirmations = db.hearingConfirmations.filter((c) => c.hearingId === hearing.id);
    confirmations.forEach((c) => { c.response = 'pendiente'; c.respondedAt = null; });

    let cancelledSiblings = [];
    if (hearing.proposalGroupId) {
      cancelledSiblings = db.hearings.filter((h) => h.proposalGroupId === hearing.proposalGroupId && h.id !== hearing.id && h.status === 'propuesta');
      cancelledSiblings.forEach((h) => { h.status = 'cancelada'; h.lastModifiedBy = req.user.id; h.lastModifiedAt = Date.now(); });
    }

    // Bloque 28 — recién ahora se crea la reunión con el proveedor real
    // que se guardó como intención al proponer (§9: nunca antes, para no
    // crear reuniones de candidatos descartados). Un fallo acá NO impide
    // confirmar la audiencia — el mediador lo ve en la tarjeta de
    // videoconferencia y puede reintentar desde ahí.
    let videoError = null;
    if (hearing.videoProvider && !hearing.meetingId && hearing.meetingStatus !== 'creada') {
      const videoResult = await createHearingMeeting(db, { hearing, mediation: req.mediation, provider: hearing.videoProvider, actorId: req.user.id });
      if (!videoResult.ok) videoError = videoResult.error;
    }

    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'HEARING_SCHEDULED', actorId: req.user.id,
      entityType: 'hearing', entityId: hearing.id,
      title: `Propuesta confirmada como audiencia: ${fmtDateEs(hearing.date)}${hearing.startTime ? ' ' + hearing.startTime : ''}`,
      description: cancelledSiblings.length ? `Se descartaron ${cancelledSiblings.length} otra(s) propuesta(s) del mismo grupo` : null,
    });

    // Bloque 16 §2 — "indicar claramente que la audiencia quedó
    // confirmada", a todas las partes involucradas y sus abogados.
    const involvedParties = db.parties.filter((p) => confirmations.some((c) => c.partyId === p.id));
    const confirmNotifyText = `${req.mediation.code}: tu audiencia quedó confirmada para el ${fmtDateEs(hearing.date)}${hearing.startTime ? ' ' + hearing.startTime : ''} (${hearing.modality}). Ingresá al portal para volver a confirmar tu asistencia.`;
    const confirmNotifications = [];
    for (const party of involvedParties) {
      const n = await notifyPartyAboutHearing(db, party, confirmNotifyText);
      confirmNotifications.push({ recipient: 'party', partyId: party.id, status: n.status });
      const partyLawyers = db.lawyers.filter((l) => l.mediationId === req.mediation.id && l.partyId === party.id);
      for (const lawyer of partyLawyers) {
        const nl = await notifyLawyerAboutHearing(db, lawyer, `${req.mediation.code}: quedó confirmada la audiencia para el ${fmtDateEs(hearing.date)}${hearing.startTime ? ' ' + hearing.startTime : ''}.`);
        confirmNotifications.push({ recipient: 'lawyer', lawyerId: lawyer.id, status: nl.status });
      }
    }

    await commit();
    const response = { ...serializeHearing(hearing, confirmations), notifications: confirmNotifications };
    if (videoError) response.videoError = videoError;
    res.json(response);
  });

  const HEARING_STATUS_EVENT_TYPE = {
    confirmada: 'HEARING_CONFIRMED', realizada: 'HEARING_HELD',
    cancelada: 'HEARING_CANCELLED', no_realizada: 'HEARING_NOT_HELD',
  };

  router.post('/:id/hearings/:hearingId/status', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { status, note } = req.body || {};
    if (!['programada', 'confirmada', 'realizada', 'cancelada', 'no_realizada'].includes(status)) {
      return res.status(400).json({ error: 'Estado de audiencia inválido' });
    }
    const db = getDB();
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === req.mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    // Bloque 16 §7 — mismo guard que ya usa el cambio de estado de
    // mediación: sin esto, un doble click en "cancelar" generaba dos
    // eventos y, ahora, dos notificaciones. Antes no existía acá.
    if (hearing.status === status) {
      return res.json(serializeHearing(hearing, db.hearingConfirmations.filter((c) => c.hearingId === hearing.id)));
    }
    const fromStatus = hearing.status;
    hearing.status = status;
    hearing.lastModifiedBy = req.user.id;
    hearing.lastModifiedAt = Date.now();

    let hearingEvent = null;
    if (HEARING_STATUS_EVENT_TYPE[status]) {
      hearingEvent = logMediationEvent(db, {
        mediationId: req.mediation.id, type: HEARING_STATUS_EVENT_TYPE[status], actorId: req.user.id,
        entityType: 'hearing', entityId: hearing.id,
        title: `Audiencia ${status}: ${fmtDateEs(hearing.date)}`,
        // Bloque 15 — motivo, cuando corresponde (típicamente al cancelar)
        description: note || null,
      });
    }

    // Bloque 16 §4 — notificación real de cancelación, a todas las
    // partes involucradas y sus abogados, con la fecha ANTERIOR (nunca
    // se inventa una nueva) y el motivo si se dio.
    let cancelNotifications = [];
    let videoError = null;
    if (status === 'cancelada') {
      // Bloque 28 §10 — cancelar la reunión externa cuando corresponde,
      // nunca en silencio: si falla, la audiencia SIGUE quedando
      // cancelada (spec: "la audiencia de Mediador debe mantener su
      // estado real"), pero el error queda registrado y visible.
      const videoResult = await cancelHearingMeeting(db, { hearing, mediation: req.mediation, actorId: req.user.id });
      if (!videoResult.ok) videoError = videoResult.error;
      const confirmations = db.hearingConfirmations.filter((c) => c.hearingId === hearing.id);
      const involvedParties = db.parties.filter((p) => confirmations.some((c) => c.partyId === p.id));
      const cancelText = `${req.mediation.code}: se canceló la audiencia del ${fmtDateEs(hearing.date)}${hearing.startTime ? ' ' + hearing.startTime : ''}${note ? '. Motivo: ' + note : ''}.`;
      for (const party of involvedParties) {
        const n = await notifyPartyAboutHearing(db, party, cancelText);
        cancelNotifications.push({ recipient: 'party', partyId: party.id, status: n.status });
        const partyLawyers = db.lawyers.filter((l) => l.mediationId === req.mediation.id && l.partyId === party.id);
        for (const lawyer of partyLawyers) {
          const nl = await notifyLawyerAboutHearing(db, lawyer, cancelText);
          cancelNotifications.push({ recipient: 'lawyer', lawyerId: lawyer.id, status: nl.status });
        }
      }
    }

    await commit();
    const response = serializeHearing(hearing, db.hearingConfirmations.filter((c) => c.hearingId === hearing.id));
    if (cancelNotifications.length) response.notifications = cancelNotifications;
    if (videoError) response.videoError = videoError;
    // regla del motor operativo (§3.11): HEARING_HELD SUGIERE compromisos y
    // tareas de seguimiento, nunca los crea sola — no hay forma segura de
    // adivinar cuántos generó una audiencia real. El frontend decide si le
    // muestra este aviso al mediador.
    if (status === 'realizada') {
      response.suggestion = {
        type: 'CREATE_COMMITMENTS',
        message: '¿Se acordó algún compromiso en esta audiencia? Podés cargarlo ahora.',
        causedByEventId: hearingEvent ? hearingEvent.id : null,
      };
    }
    res.json(response);
  });

  // ---------- videoconferencia de la audiencia (Bloque 28) ----------
  // Crear/reintentar la reunión de una audiencia ya existente — para una
  // audiencia que se creó sin video, para cambiar de "link manual" a un
  // proveedor real, o para reintentar después de un VIDEO_MEETING_ERROR.
  router.post('/:id/hearings/:hearingId/meeting', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { provider, meetingUrl } = req.body || {};
    if (!provider && !meetingUrl) return res.status(400).json({ error: 'Falta el proveedor o el enlace de la reunión' });
    const db = getDB();
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === req.mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    if (hearing.modality === 'presencial') return res.status(400).json({ error: 'Esta audiencia es presencial — cambiá la modalidad antes de agregar videoconferencia' });

    const videoResult = await createHearingMeeting(db, { hearing, mediation: req.mediation, provider, meetingUrl, actorId: req.user.id });
    if (!videoResult.ok) {
      await commit();
      return res.status(502).json({ error: videoResult.error.message, code: videoResult.error.code, hearing: serializeHearing(hearing, db.hearingConfirmations.filter((c) => c.hearingId === hearing.id)) });
    }
    await commit();
    res.json(serializeHearing(hearing, db.hearingConfirmations.filter((c) => c.hearingId === hearing.id)));
  });

  // Desvincula la videoconferencia SIN tocar el resto de la audiencia —
  // cancela la reunión en el proveedor cuando corresponde y deja la
  // audiencia como "sin videoconferencia configurada" (spec §11: el
  // mediador puede volver a un link manual o elegir otro proveedor).
  router.delete('/:id/hearings/:hearingId/meeting', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === req.mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    let videoError = null;
    if (hearing.videoProvider) {
      const videoResult = await cancelHearingMeeting(db, { hearing, mediation: req.mediation, actorId: req.user.id });
      if (!videoResult.ok) videoError = videoResult.error;
    }
    hearing.videoProvider = null; hearing.meetingId = null; hearing.meetingUrl = null; hearing.hostUrl = null;
    hearing.meetingStatus = null; hearing.meetingMetadata = null; hearing.meetingUpdatedAt = Date.now();
    hearing.lastModifiedBy = req.user.id; hearing.lastModifiedAt = Date.now();
    await commit();
    const response = serializeHearing(hearing, db.hearingConfirmations.filter((c) => c.hearingId === hearing.id));
    if (videoError) response.videoError = videoError;
    res.json(response);
  });

  // el mediador registra la respuesta de una parte "a mano" (llamada,
  // WhatsApp, lo que sea) — el endpoint donde la PARTE confirma ella misma
  // desde el portal, sin cuenta, es el Bloque 7, todavía no existe.
  function serializeRescheduleRequest(r) {
    const db = getDB();
    const party = db.parties.find((p) => p.id === r.requestedByPartyId);
    const mediation = db.mediations.find((m) => m.id === r.mediationId);
    return {
      id: r.id, hearingId: r.hearingId, mediationId: r.mediationId, mediationCode: mediation ? mediation.code : null,
      requestedByPartyId: r.requestedByPartyId, requestedByPartyName: party ? (party.legalName || `${party.firstName || ''} ${party.lastName || ''}`.trim()) : null,
      requestedByType: r.requestedByType, requestedByLawyerId: r.requestedByLawyerId,
      reason: r.reason, comment: r.comment || null, preferredDayText: r.preferredDayText || null, preferredTimeText: r.preferredTimeText || null,
      proposedDate: r.proposedDate, proposedStartTime: r.proposedStartTime,
      status: r.status, mediatorNote: r.mediatorNote, resolvedBy: r.resolvedBy, resolvedAt: r.resolvedAt, createdAt: r.createdAt,
      sourceMessageId: r.sourceMessageId || null,
    };
  }

  // ---------- solicitudes de reprogramación (hardening) ----------
  router.get('/:id/hearings/:hearingId/reschedule-requests', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const list = db.hearingRescheduleRequests
      .filter((r) => r.hearingId === req.params.hearingId && r.mediationId === req.mediation.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json(list.map(serializeRescheduleRequest));
  });

  // Bloque 19 — "Gestionar cambio de audiencia" desde un mensaje: el
  // mediador lee "no puedo el jueves" en el chat y transcribe el pedido
  // al flujo YA existente (misma tabla, mismos estados, mismo endpoint de
  // resolución de arriba) en vez de resolverlo "de palabra" sin dejar
  // registro. Nunca se reprograma sola — esto solo crea la SOLICITUD,
  // exactamente como cuando la manda la propia parte o abogado desde su
  // portal.
  router.post('/:id/hearings/:hearingId/reschedule-requests', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { partyId, lawyerId, reason, comment, preferredDayText, preferredTimeText, sourceMessageId } = req.body || {};
    const db = getDB();
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === req.mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    let requestedByPartyId = null;
    let requestedByType = null;
    let requestedByLawyerId = null;
    if (lawyerId) {
      const lawyer = db.lawyers.find((l) => l.id === lawyerId && l.mediationId === req.mediation.id);
      if (!lawyer) return res.status(400).json({ error: 'Ese abogado no pertenece a esta mediación' });
      requestedByType = 'lawyer'; requestedByLawyerId = lawyer.id; requestedByPartyId = lawyer.partyId || null;
    } else if (partyId) {
      const party = db.parties.find((p) => p.id === partyId && p.mediationId === req.mediation.id);
      if (!party) return res.status(400).json({ error: 'Esa parte no pertenece a esta mediación' });
      requestedByType = 'party'; requestedByPartyId = party.id;
    } else {
      return res.status(400).json({ error: 'Falta indicar de qué parte o abogado es el pedido' });
    }
    const request = {
      id: nanoid(), hearingId: hearing.id, mediationId: req.mediation.id,
      requestedByPartyId, requestedByType, requestedByLawyerId,
      reason: reason || null, comment: comment || null, preferredDayText: preferredDayText || null, preferredTimeText: preferredTimeText || null,
      proposedDate: null, proposedStartTime: null, status: 'pendiente', mediatorNote: null,
      resolvedBy: null, resolvedAt: null, createdAt: Date.now(),
      sourceMessageId: resolveSourceMessage(db, req.mediation.id, sourceMessageId),
    };
    db.hearingRescheduleRequests.push(request);
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'HEARING_RESCHEDULE_REQUESTED', actorId: req.user.id,
      entityType: 'hearing_reschedule_request', entityId: request.id,
      title: 'Pedido de cambio registrado desde un mensaje',
      description: reason || null, metadata: request.sourceMessageId ? { sourceMessageId: request.sourceMessageId } : null,
    });
    await commit();
    res.json(serializeRescheduleRequest(request));
  });

  // "Solo el mediador puede confirmar/rechazar/proponer la reprogramación
  // definitiva" — requireEditAccess, ninguna excepción. Ni la parte ni el
  // abogado tienen ningún endpoint que toque hearings.date directamente
  // (confirmar el pedido de cambio en el portal solo crea la SOLICITUD).
  router.post('/:id/hearings/:hearingId/reschedule-requests/:requestId/resolve', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { action, newDate, newStartTime, note } = req.body || {};
    if (!['aceptar', 'rechazar', 'proponer', 'resolver_sin_cambio'].includes(action)) {
      return res.status(400).json({ error: 'Acción inválida — usar aceptar, rechazar, proponer o resolver_sin_cambio' });
    }
    const db = getDB();
    const request = db.hearingRescheduleRequests.find(
      (r) => r.id === req.params.requestId && r.hearingId === req.params.hearingId && r.mediationId === req.mediation.id
    );
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada en esta mediación' });
    if (request.status !== 'pendiente') return res.status(400).json({ error: 'Esta solicitud ya fue resuelta' });
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === req.mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada' });
    const requestingParty = db.parties.find((p) => p.id === request.requestedByPartyId);

    if (action === 'rechazar' || action === 'resolver_sin_cambio') {
      // Bloque 15 (Parte 2) §7: "resolver sin cambiar la audiencia" es un
      // cierre distinto de rechazar — no es una negativa, es "ya se
      // solucionó de otra forma, no hace falta reprogramar". Misma
      // audiencia intacta en los dos casos, pero el estado final difiere
      // (spec §4: los cuatro estados mínimos son pendiente/aceptada/
      // rechazada/resuelta).
      request.status = action === 'rechazar' ? 'rechazada' : 'resuelta';
      request.mediatorNote = note || null;
      request.resolvedBy = req.user.id;
      request.resolvedAt = Date.now();
      const eventTitle = action === 'rechazar'
        ? 'El mediador rechazó el pedido de cambio de audiencia'
        : 'El mediador cerró el pedido de cambio sin reprogramar';
      logMediationEvent(db, {
        mediationId: req.mediation.id, type: 'HEARING_RESCHEDULE_REJECTED', actorId: req.user.id,
        entityType: 'hearing_reschedule_request', entityId: request.id,
        title: eventTitle, description: note || null,
      });
      const notif = requestingParty ? await notifyPartyAboutHearing(db, requestingParty, `Tu pedido de cambio de audiencia fue ${action === 'rechazar' ? 'rechazado' : 'resuelto sin reprogramar'}${note ? ': ' + note : ''}`) : { status: 'no_disponible' };
      await commit();
      return res.json({ ...serializeRescheduleRequest(request), notification: notif.status });
    }

    // aceptar: usa la fecha que la parte/abogado propuso. proponer: el
    // mediador pone la suya propia, sin importar lo que se haya pedido.
    // En los dos casos NO se crea una audiencia nueva — se actualiza esta
    // misma, de manera controlada, conservando la fecha anterior en el
    // propio evento del timeline.
    const targetDate = action === 'aceptar' ? request.proposedDate : newDate;
    const targetStartTime = action === 'aceptar' ? request.proposedStartTime : (newStartTime !== undefined ? newStartTime : null);
    if (!targetDate) {
      return res.status(400).json({ error: action === 'aceptar' ? 'Esta solicitud no tiene una fecha propuesta para aceptar' : 'Falta la nueva fecha' });
    }

    // Bloque 15 — misma validación de conflictos que al crear, ahora
    // también al reprogramar (spec §7: "validar disponibilidad, validar
    // conflictos"). Se excluye la propia audiencia de su propio chequeo.
    if (targetStartTime) {
      const conflicts = checkHearingConflicts(db, {
        mediatorUserId: req.mediation.mediatorUserId, date: targetDate, startTime: targetStartTime,
        endTime: hearing.endTime, excludeHearingId: hearing.id,
      });
      if (conflicts.length > 0) {
        return res.status(409).json({ error: 'La nueva fecha/hora tiene un conflicto de horario para el mediador responsable', conflicts });
      }
    }

    const fromDate = hearing.date;
    const fromStartTime = hearing.startTime;
    hearing.date = targetDate;
    hearing.startTime = targetStartTime;
    hearing.status = 'programada'; // vuelve a programada — hay que reconfirmar contra la fecha nueva
    hearing.lastModifiedBy = req.user.id;
    hearing.lastModifiedAt = Date.now();

    // se reinician TODAS las confirmaciones de esta audiencia — una
    // confirmación contra la fecha vieja no dice nada sobre la fecha
    // nueva, así que no tiene sentido dejarla como estaba (spec §11: "las
    // confirmaciones anteriores NO deben quedar como si confirmaran
    // automáticamente el nuevo horario").
    const resetConfirmations = db.hearingConfirmations.filter((c) => c.hearingId === hearing.id);
    resetConfirmations.forEach((c) => { c.response = 'pendiente'; c.respondedAt = null; });

    request.status = 'aceptada';
    request.mediatorNote = note || null;
    request.resolvedBy = req.user.id;
    request.resolvedAt = Date.now();

    // Bloque 28 §9 — la reunión existente se ACTUALIZA (nunca se crea una
    // nueva) si esta audiencia tiene un proveedor real detrás. Un fallo
    // acá no revierte la reprogramación — queda visible en la tarjeta de
    // videoconferencia para que el mediador lo resuelva.
    let videoError = null;
    if (hearing.videoProvider) {
      const videoResult = await updateHearingMeeting(db, { hearing, mediation: req.mediation, actorId: req.user.id });
      if (!videoResult.ok) videoError = videoResult.error;
    }

    const rescheduleEvent = logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'HEARING_RESCHEDULED', actorId: req.user.id,
      entityType: 'hearing', entityId: hearing.id,
      title: `Audiencia reprogramada: ${fmtDateEs(fromDate)} → ${fmtDateEs(targetDate)}`,
      description: note || null,
      metadata: { fromDate, fromStartTime, toDate: targetDate, toStartTime: targetStartTime, resolvedRequestId: request.id },
      causedByEventId: null,
    });
    // Bloque 16 §3 — a TODAS las partes afectadas y sus abogados, no solo
    // a quien pidió el cambio (antes solo se avisaba al solicitante).
    const involvedPartiesForReschedule = db.parties.filter((p) => resetConfirmations.some((c) => c.partyId === p.id));
    const rescheduleNotifyText = `${req.mediation.code}: tu audiencia fue reprogramada. Nueva fecha: ${fmtDateEs(targetDate)}${targetStartTime ? ' ' + targetStartTime : ''}. Hace falta que vuelvas a confirmar en el portal.`;
    const rescheduleNotifications = [];
    for (const party of involvedPartiesForReschedule) {
      const n = await notifyPartyAboutHearing(db, party, rescheduleNotifyText);
      rescheduleNotifications.push({ recipient: 'party', partyId: party.id, status: n.status });
      const partyLawyers = db.lawyers.filter((l) => l.mediationId === req.mediation.id && l.partyId === party.id);
      for (const lawyer of partyLawyers) {
        const nl = await notifyLawyerAboutHearing(db, lawyer, `${req.mediation.code}: se reprogramó la audiencia de tu representado/a. Nueva fecha: ${fmtDateEs(targetDate)}${targetStartTime ? ' ' + targetStartTime : ''}.`);
        rescheduleNotifications.push({ recipient: 'lawyer', lawyerId: lawyer.id, status: nl.status });
      }
    }
    await commit();
    const rescheduleResponse = { request: serializeRescheduleRequest(request), hearing: serializeHearing(hearing, resetConfirmations), notifications: rescheduleNotifications };
    if (videoError) rescheduleResponse.videoError = videoError;
    res.json(rescheduleResponse);
  });


  router.post('/:id/hearings/:hearingId/confirmations/:partyId', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { response } = req.body || {};
    if (!['confirma', 'no_puede', 'pide_cambio', 'pendiente'].includes(response)) {
      return res.status(400).json({ error: 'Respuesta inválida' });
    }
    const db = getDB();
    // Bloque 18 §7 — antes esto buscaba la confirmación SOLO por
    // hearingId+partyId, sin confirmar que esa audiencia sea de ESTA
    // mediación (la del :id de la URL, ya validada arriba por
    // requireMediationAccess) — alguien con acceso a una mediación podía
    // pisar la confirmación de una audiencia de OTRA mediación si conseguía
    // su hearingId+partyId. Mismo guard que ya usan todos los demás
    // sub-recursos de este archivo (parties/lawyers/hearings/documents/
    // tasks/commitments, ver requireMediationAccess).
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === req.mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    const confirmation = db.hearingConfirmations.find(
      (c) => c.hearingId === req.params.hearingId && c.partyId === req.params.partyId
    );
    if (!confirmation) return res.status(404).json({ error: 'Confirmación no encontrada' });
    confirmation.response = response;
    confirmation.respondedAt = Date.now();
    await commit();
    res.json(confirmation);
  });

  // ================= Bloque 5: documentos =================

  router.get('/:id/documents', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const list = db.documents
      .filter((d) => d.mediationId === req.mediation.id)
      .map(serializeDocument)
      .filter((d) => d.isCurrentVersion) // versiones viejas no ensucian el listado principal — se ven en .../versions
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json(list);
  });

  // completa el ciclo operativo del documento (recibido -> revisado/
  // observado/final) — existía el campo status desde el Bloque 5 pero
  // nunca había forma de cambiarlo después de subirlo.
  router.patch('/:id/documents/:docId', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { status, notes } = req.body || {};
    if (!['pendiente_escaneo', 'recibido', 'pendiente_revision', 'revisado', 'observado', 'final'].includes(status)) {
      return res.status(400).json({ error: 'Estado de documento inválido' });
    }
    // Bloque 32 §2 — "observado" sin decir por qué es exactamente el
    // problema que esto viene a resolver (la parte cambiaba de estado y
    // nadie sabía qué faltaba corregir). Se exige acá, en el único lugar
    // donde se decide el estado — nunca confiar en que el frontend lo pida.
    if (status === 'observado' && (!notes || !notes.trim())) {
      return res.status(400).json({ error: 'Para marcar un documento como observado hace falta explicar qué falta corregir' });
    }
    const db = getDB();
    const doc = db.documents.find((d) => d.id === req.params.docId && d.mediationId === req.mediation.id);
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado en esta mediación' });
    doc.status = status;
    if (notes !== undefined) doc.reviewNotes = (notes && notes.trim()) || null;
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'DOCUMENT_REVIEWED', actorId: req.user.id,
      entityType: 'document', entityId: doc.id, title: `Documento ${status}: ${doc.originalFilename}`,
      description: doc.reviewNotes || null,
    });

    // Avisar a LA parte dueña del documento — si es un documento general
    // (partyId null, de toda la mediación) no hay una única destinataria,
    // así que no se manda nada automático (el mediador sigue pudiendo
    // avisar a mano, como siempre). Mismo mecanismo ya reusado en las
    // invitaciones (Bloque 32 §1) — nunca un canal nuevo.
    let notifyResult = null;
    if (status === 'observado' && doc.partyId) {
      const party = db.parties.find((p) => p.id === doc.partyId && p.mediationId === req.mediation.id);
      if (party) {
        notifyResult = await notifyParty(db, party, `${partyDisplayName(db, party.id) || 'Hola'}: tu documento "${doc.originalFilename}" en la mediación ${req.mediation.code} quedó observado. Motivo: ${doc.reviewNotes}`);
        const thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.partyId === party.id);
        if (thread) {
          await postSystemMessage(io, thread, `Documento observado — "${doc.originalFilename}": ${doc.reviewNotes}`, notifyResult.status === 'enviado' ? 'whatsapp' : 'sistema');
        }
      }
    }
    await commit();
    res.json({ ...serializeDocument(doc), notified: notifyResult ? notifyResult.status === 'enviado' : null });
  });

  router.post('/:id/documents', requireAuth, requireMediationAccess, requireEditAccess,
    (req, res, next) => {
      uploadDocument.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `El archivo supera el tamaño máximo permitido (${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB)` : (err.message || 'No se pudo subir el archivo') });
        next();
      });
    },
    async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
      const db = getDB();
      const { type, partyId } = req.body || {};
      if (partyId) {
        const party = db.parties.find((p) => p.id === partyId && p.mediationId === req.mediation.id);
        if (!party) return res.status(400).json({ error: 'La parte indicada no existe en esta mediación' });
      }
      const doc = {
        id: nanoid(), mediationId: req.mediation.id, uploadedBy: req.user.id, partyId: partyId || null,
        type: type || 'otro',
        originalFilename: req.file.originalname, // solo para mostrar
        storagePath: req.file.filename, // nombre físico real, generado por multer con nuestro nanoid — nunca sale de este archivo
        mimeType: req.file.mimetype, size: req.file.size,
        status: 'recibido', version: 1, createdAt: Date.now(),
      };
      db.documents.push(doc);
      // checklist: "registrar upload y download en audit_log"
      logAudit(db, {
        actorId: req.user.id, action: 'document_uploaded', channelCode: null,
        meta: { mediationId: req.mediation.id, documentId: doc.id, filename: doc.originalFilename, size: doc.size },
      });
      const uploadEvent = logMediationEvent(db, {
        mediationId: req.mediation.id, type: 'DOCUMENT_UPLOADED', actorId: req.user.id,
        entityType: 'document', entityId: doc.id,
        title: `Documento subido: ${doc.originalFilename}`,
      });
      // regla del motor operativo (§3.11): DOCUMENT_UPLOADED -> tarea
      // automática de revisión — a diferencia de HEARING_HELD, esto SÍ es
      // automático porque es un recordatorio de housekeeping de bajo
      // riesgo, no una decisión sustantiva sobre el contenido del documento.
      const reviewTask = {
        id: nanoid(), mediationId: req.mediation.id, assignedTo: req.mediation.mediatorUserId,
        title: `Revisar documento: ${doc.originalFilename}`, description: null,
        dueDate: null, priority: 'media', status: 'pendiente',
        createdBy: null, completedAt: null, createdAt: Date.now(), // createdBy null = generada por el sistema, no por una persona
      };
      db.tasks.push(reviewTask);
      logMediationEvent(db, {
        mediationId: req.mediation.id, type: 'TASK_CREATED', actorId: null,
        entityType: 'task', entityId: reviewTask.id,
        title: `Tarea generada: ${reviewTask.title}`,
        causedByEventId: uploadEvent.id, // la cadena causal que pidió el usuario en §6 de su revisión del plan
      });
      await commit();
      res.json(serializeDocument(doc));
    }
  );

  // ---------- versionado de documentos (hardening) ----------
  // "raíz" del linaje = parentDocumentId si existe, si no, el propio id
  // (o sea: la primera versión ES la raíz de sí misma). Evita tener que
  // seguir una cadena de punteros para saber a qué linaje pertenece algo.
  function documentLineage(db, mediationId, rootId) {
    return db.documents
      .filter((d) => d.mediationId === mediationId && (d.id === rootId || d.parentDocumentId === rootId))
      .sort((a, b) => (a.version || 1) - (b.version || 1));
  }

  router.get('/:id/documents/:docId/versions', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const doc = db.documents.find((d) => d.id === req.params.docId && d.mediationId === req.mediation.id);
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado en esta mediación' });
    const rootId = doc.parentDocumentId || doc.id;
    res.json(documentLineage(db, req.mediation.id, rootId).map(serializeDocument));
  });

  router.post('/:id/documents/:docId/versions', requireAuth, requireMediationAccess, requireEditAccess,
    (req, res, next) => {
      uploadDocument.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `El archivo supera el tamaño máximo permitido (${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB)` : (err.message || 'No se pudo subir el archivo') });
        next();
      });
    },
    async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
      const db = getDB();
      // mismo chequeo de pertenencia que cualquier otro endpoint puntual
      // de documento — no alcanza con que el documento exista, tiene que
      // ser DE esta mediación.
      const original = db.documents.find((d) => d.id === req.params.docId && d.mediationId === req.mediation.id);
      if (!original) return res.status(404).json({ error: 'Documento no encontrado en esta mediación' });

      const rootId = original.parentDocumentId || original.id;
      const lineage = documentLineage(db, req.mediation.id, rootId);
      const nextVersion = Math.max(...lineage.map((d) => d.version || 1)) + 1;

      const newVersion = {
        id: nanoid(), mediationId: req.mediation.id, uploadedBy: req.user.id,
        partyId: original.partyId, // hereda la parte del documento original — una nueva versión no cambia de dueño
        type: original.type, parentDocumentId: rootId,
        originalFilename: req.file.originalname, storagePath: req.file.filename,
        mimeType: req.file.mimetype, size: req.file.size,
        status: 'recibido', version: nextVersion, createdAt: Date.now(),
      };
      db.documents.push(newVersion);
      logAudit(db, {
        actorId: req.user.id, action: 'document_uploaded', channelCode: null,
        meta: { mediationId: req.mediation.id, documentId: newVersion.id, filename: newVersion.originalFilename, size: newVersion.size, version: nextVersion },
      });
      logMediationEvent(db, {
        mediationId: req.mediation.id, type: 'DOCUMENT_UPLOADED', actorId: req.user.id,
        entityType: 'document', entityId: newVersion.id,
        title: `Nueva versión (v${nextVersion}) de ${newVersion.originalFilename}`,
      });
      await commit();
      res.json(serializeDocument(newVersion));
    }
  );

  router.get('/:id/documents/:docId/download', requireAuth, requireMediationAccess, requireSupportAccessForPrivateContent, async (req, res) => {
    const db = getDB();
    // checklist: "verificar que el documento pertenece a la mediación
    // solicitada en la URL" — no alcanza con que el documento exista, tiene
    // que ser DE esta mediación puntual.
    const doc = db.documents.find((d) => d.id === req.params.docId && d.mediationId === req.mediation.id);
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado en esta mediación' });

    const filePath = path.join(UPLOADS_ROOT, req.mediation.id, doc.storagePath);

    logAudit(db, {
      actorId: req.user.id, action: 'document_downloaded', channelCode: null,
      meta: { mediationId: req.mediation.id, documentId: doc.id },
    });
    await commit();

    // checklist: "no permitir ejecución de archivos" — Content-Disposition
    // attachment fuerza descarga en vez de ejecución/render inline, y el
    // Content-Type sale de lo que YA validamos al subir, nunca de lo que
    // el sistema de archivos adivine en este momento.
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.originalFilename)}"`);
    res.setHeader('Content-Type', doc.mimeType);
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'El archivo no se encontró en el servidor' });
    });
  });

  // ================= Bloque 6: timeline, tareas, compromisos =================

  function serializeMediationEvent(e) {
    return {
      id: e.id, mediationId: e.mediationId, type: e.type, actorId: e.actorId,
      visibility: e.visibility, entityType: e.entityType, entityId: e.entityId,
      title: e.title, description: e.description, metadata: e.metadata,
      causedByEventId: e.causedByEventId, createdAt: e.createdAt,
    };
  }
  function serializeTask(t) {
    return {
      id: t.id, mediationId: t.mediationId, assignedTo: t.assignedTo,
      title: t.title, description: t.description, dueDate: t.dueDate, priority: t.priority,
      status: t.status, createdBy: t.createdBy, completedAt: t.completedAt, createdAt: t.createdAt,
      sourceMessageId: t.sourceMessageId || null, sourceDocumentId: t.sourceDocumentId || null,
      // Bloque 31 — si está seteado, esta tarea es DE una parte (visible y
      // completable desde su portal), no del equipo mediador.
      assignedToPartyId: t.assignedToPartyId || null,
    };
  }
  // helper de serializeCommitment de abajo — nunca devuelve un documento
  // de OTRA mediación, aunque documentId venga de un dato viejo/corrupto.
  function findCommitmentEvidenceDocument(documentId, mediationId) {
    const db = getDB();
    return db.documents.find((d) => d.id === documentId && d.mediationId === mediationId) || null;
  }
  function serializeCommitment(c) {
    const doc = c.documentId ? findCommitmentEvidenceDocument(c.documentId, c.mediationId) : null;
    return {
      id: c.id, mediationId: c.mediationId, partyId: c.partyId, description: c.description, dueDate: c.dueDate,
      status: c.status, createdFromEventId: c.createdFromEventId, completedAt: c.completedAt, createdAt: c.createdAt,
      sourceMessageId: c.sourceMessageId || null,
      // Bloque 31 — observaciones libres y evidencia (documento YA
      // existente de la misma mediación, nunca un adjunto nuevo/paralelo).
      notes: c.notes || null,
      documentId: c.documentId || null,
      document: doc ? { id: doc.id, originalFilename: doc.originalFilename, type: doc.type } : null,
    };
  }

  // ---------- timeline ----------
  // un abogado (visibility scoped) nunca ve las filas mediator_only —
  // spec §10, sin excepción. Mediador/admin/asistente ven todo.
  router.get('/:id/timeline', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const canSeePrivate = ['mediador', 'admin', 'asistente'].includes(req.mediationRole);
    let list = db.mediationEvents.filter((e) => e.mediationId === req.mediation.id);
    if (!canSeePrivate) list = list.filter((e) => e.visibility === 'public');
    if (req.query.type) list = list.filter((e) => e.type === req.query.type);
    list = list.sort((a, b) => b.createdAt - a.createdAt);
    res.json(list.map(serializeMediationEvent));
  });

  // Bloque 10 — expediente histórico navegable: el mismo timeline de
  // arriba, pero agrupado por día, pensado para revisar un caso YA
  // cerrado de punta a punta, no para el día a día de uno activo. No
  // duplica el filtro de visibilidad/tipo — llama a la misma lógica.
  router.get('/:id/timeline/grouped', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const canSeePrivate = ['mediador', 'admin', 'asistente'].includes(req.mediationRole);
    let list = db.mediationEvents.filter((e) => e.mediationId === req.mediation.id);
    if (!canSeePrivate) list = list.filter((e) => e.visibility === 'public');
    list = list.sort((a, b) => a.createdAt - b.createdAt); // ascendente acá — un expediente histórico se lee como una narrativa, del principio al final

    const groups = [];
    let currentDay = null;
    for (const e of list) {
      const day = new Date(e.createdAt).toISOString().slice(0, 10);
      if (day !== currentDay) {
        currentDay = day;
        groups.push({ date: day, events: [] });
      }
      groups[groups.length - 1].events.push(serializeMediationEvent(e));
    }
    res.json(groups);
  });

  // ---------- tareas ----------
  router.get('/:id/tasks', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const list = db.tasks.filter((t) => t.mediationId === req.mediation.id).sort((a, b) => b.createdAt - a.createdAt);
    res.json(list.map(serializeTask));
  });

  // Bloque 19 — "mensaje → acción": el mediador elige a mano "Convertir en
  // tarea"/"Crear compromiso" desde un mensaje puntual, nunca se genera
  // solo porque el texto menciona una fecha. Esto solo valida que el
  // mensaje sea de verdad de ESTA mediación antes de guardar la
  // referencia — nunca confiar en que el frontend ya lo comprobó.
  function resolveSourceMessage(db, mediationId, sourceMessageId) {
    if (!sourceMessageId) return null;
    const msg = db.messages.find((m) => m.id === sourceMessageId);
    if (!msg) return null;
    const channel = db.channels.find((c) => c.id === msg.channelId && c.mediationId === mediationId);
    return channel ? msg.id : null;
  }

  // Bloque 22 §6 — mismo criterio que resolveSourceMessage: valida que el
  // documento sea de ESTA mediación antes de guardarlo como referencia,
  // nunca confía en el id que manda el frontend.
  function resolveSourceDocument(db, mediationId, sourceDocumentId) {
    if (!sourceDocumentId) return null;
    const doc = db.documents.find((d) => d.id === sourceDocumentId && d.mediationId === mediationId);
    return doc ? doc.id : null;
  }

  router.post('/:id/tasks', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { title, description, dueDate, priority, sourceMessageId, sourceDocumentId, assignedToPartyId } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'Falta el título de la tarea' });
    const db = getDB();
    // Bloque 31 — delegar la tarea a una parte (en vez de al equipo
    // mediador): la parte tiene que existir en ESTA mediación.
    let resolvedAssignedToPartyId = null;
    if (assignedToPartyId) {
      const party = db.parties.find((p) => p.id === assignedToPartyId && p.mediationId === req.mediation.id);
      if (!party) return res.status(400).json({ error: 'La parte indicada no existe en esta mediación' });
      resolvedAssignedToPartyId = party.id;
    }
    const resolvedSourceDocumentId = resolveSourceDocument(db, req.mediation.id, sourceDocumentId);
    // Bloque 22 §6 — "si ya existe una tarea activa de revisión para ese
    // documento, no duplicarla": en vez de crear una segunda, devolvemos
    // la que ya existe (misma idea que el guard de "doble click" que ya
    // usa el cambio de estado de audiencia/mediación).
    if (resolvedSourceDocumentId) {
      const existing = db.tasks.find((t) => t.mediationId === req.mediation.id && t.sourceDocumentId === resolvedSourceDocumentId && ['pendiente', 'en_proceso'].includes(t.status));
      if (existing) return res.json({ ...serializeTask(existing), alreadyExisted: true });
    }
    const resolvedSourceMessageId = resolveSourceMessage(db, req.mediation.id, sourceMessageId);
    const task = {
      id: nanoid(), mediationId: req.mediation.id, assignedTo: req.user.id,
      title: title.trim(), description: description || null, dueDate: dueDate || null,
      priority: ['baja', 'media', 'alta', 'urgente'].includes(priority) ? priority : 'media',
      status: 'pendiente', createdBy: req.user.id, completedAt: null, createdAt: Date.now(),
      sourceMessageId: resolvedSourceMessageId, sourceDocumentId: resolvedSourceDocumentId,
      assignedToPartyId: resolvedAssignedToPartyId,
    };
    db.tasks.push(task);
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'TASK_CREATED', actorId: req.user.id,
      entityType: 'task', entityId: task.id,
      title: resolvedAssignedToPartyId ? `Tarea asignada a ${partyDisplayName(db, resolvedAssignedToPartyId) || 'una parte'}: ${task.title}` : `Tarea creada: ${task.title}`,
      metadata: (resolvedSourceMessageId || resolvedSourceDocumentId) ? { sourceMessageId: resolvedSourceMessageId, sourceDocumentId: resolvedSourceDocumentId } : null,
    });
    await commit();
    res.json(serializeTask(task));
  });

  router.patch('/:id/tasks/:taskId', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const task = db.tasks.find((t) => t.id === req.params.taskId && t.mediationId === req.mediation.id);
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada en esta mediación' });
    const { title, description, dueDate, priority, status } = req.body || {};
    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (dueDate !== undefined) task.dueDate = dueDate;
    if (priority !== undefined) task.priority = priority;
    if (status !== undefined && status !== task.status) {
      if (!['pendiente', 'en_proceso', 'completada', 'cancelada'].includes(status)) {
        return res.status(400).json({ error: 'Estado de tarea inválido' });
      }
      task.status = status;
      task.completedAt = status === 'completada' ? Date.now() : null;
      logMediationEvent(db, {
        mediationId: req.mediation.id, type: status === 'completada' ? 'TASK_COMPLETED' : 'TASK_UPDATED',
        actorId: req.user.id, entityType: 'task', entityId: task.id,
        title: `Tarea ${status}: ${task.title}`,
      });
    }
    await commit();
    res.json(serializeTask(task));
  });

  // ---------- compromisos ----------
  router.get('/:id/commitments', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const list = db.commitments.filter((c) => c.mediationId === req.mediation.id).sort((a, b) => b.createdAt - a.createdAt);
    res.json(list.map(serializeCommitment));
  });

  router.post('/:id/commitments', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { partyId, description, dueDate, causedByEventId, sourceMessageId, notes, documentId } = req.body || {};
    if (!partyId) return res.status(400).json({ error: 'Falta la parte responsable del compromiso' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'Falta la descripción del compromiso' });
    const db = getDB();
    const party = db.parties.find((p) => p.id === partyId && p.mediationId === req.mediation.id);
    if (!party) return res.status(400).json({ error: 'La parte indicada no existe en esta mediación' });
    // evidencia: solo puede ser un documento YA existente de ESTA
    // mediación — nunca de otra, ni un id inventado.
    let resolvedDocumentId = null;
    if (documentId) {
      const doc = db.documents.find((d) => d.id === documentId && d.mediationId === req.mediation.id);
      if (!doc) return res.status(400).json({ error: 'El documento indicado no existe en esta mediación' });
      resolvedDocumentId = doc.id;
    }
    const resolvedSourceMessageId = resolveSourceMessage(db, req.mediation.id, sourceMessageId);
    const commitment = {
      id: nanoid(), mediationId: req.mediation.id, partyId, description: description.trim(),
      dueDate: dueDate || null, status: 'pendiente', createdFromEventId: causedByEventId || null,
      completedAt: null, createdAt: Date.now(), sourceMessageId: resolvedSourceMessageId,
      notes: (notes && notes.trim()) || null, documentId: resolvedDocumentId,
    };
    db.commitments.push(commitment);
    // COMMITMENT_CREATED: no se genera una fila aparte en la tabla de
    // calendario (events) — el propio dueDate del compromiso ES el
    // vencimiento, ver IMPLEMENTATION_PLAN.md §3.11 sobre por qué evitar
    // duplicar el mismo dato en dos tablas.
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'COMMITMENT_CREATED', actorId: req.user.id,
      entityType: 'commitment', entityId: commitment.id,
      title: `Compromiso: ${commitment.description}`,
      causedByEventId: causedByEventId || null,
      metadata: resolvedSourceMessageId ? { sourceMessageId: resolvedSourceMessageId } : null,
    });
    await commit();
    res.json(serializeCommitment(commitment));
  });

  router.patch('/:id/commitments/:commitmentId', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const commitment = db.commitments.find((c) => c.id === req.params.commitmentId && c.mediationId === req.mediation.id);
    if (!commitment) return res.status(404).json({ error: 'Compromiso no encontrado en esta mediación' });
    const { description, dueDate, status, notes, documentId } = req.body || {};
    if (description !== undefined) commitment.description = description;
    if (dueDate !== undefined) commitment.dueDate = dueDate;
    if (notes !== undefined) commitment.notes = (notes && notes.trim()) || null;
    if (documentId !== undefined) {
      if (documentId === null) {
        commitment.documentId = null;
      } else {
        const doc = db.documents.find((d) => d.id === documentId && d.mediationId === req.mediation.id);
        if (!doc) return res.status(400).json({ error: 'El documento indicado no existe en esta mediación' });
        commitment.documentId = doc.id;
      }
    }
    if (status !== undefined && status !== commitment.status) {
      if (!['pendiente', 'cumplido', 'vencido', 'cancelado'].includes(status)) {
        return res.status(400).json({ error: 'Estado de compromiso inválido' });
      }
      commitment.status = status;
      commitment.completedAt = status === 'cumplido' ? Date.now() : null;
      logMediationEvent(db, {
        mediationId: req.mediation.id, type: status === 'cumplido' ? 'COMMITMENT_COMPLETED' : 'COMMITMENT_UPDATED',
        actorId: req.user.id, entityType: 'commitment', entityId: commitment.id,
        title: `Compromiso ${status}: ${commitment.description}`,
      });
    }
    await commit();
    res.json(serializeCommitment(commitment));
  });

  // ================= Bloque 8: cierre =================

  const CLOSE_RESULTS = ['acuerdo_total', 'acuerdo_parcial', 'sin_acuerdo', 'incomparecencia', 'desistimiento', 'otro'];
  const CLOSE_RESULT_TO_STATUS = {
    acuerdo_total: 'acuerdo', acuerdo_parcial: 'acuerdo_parcial', sin_acuerdo: 'sin_acuerdo',
    incomparecencia: 'incomparecencia', desistimiento: 'sin_acuerdo', otro: 'cerrada',
  };

  // checklist de la especificación original §28 — se devuelve SIEMPRE
  // (incluso al cerrar con pendientes: la spec permite cerrar igual, pero
  // pide mostrar la advertencia, nunca bloquear el cierre por esto).
  function buildCloseChecklist(db, mediationId) {
    const mediation = db.mediations.find((m) => m.id === mediationId);
    const hearings = db.hearings.filter((h) => h.mediationId === mediationId);
    const documents = db.documents.filter((d) => d.mediationId === mediationId);
    const commitments = db.commitments.filter((c) => c.mediationId === mediationId);
    const tasks = db.tasks.filter((t) => t.mediationId === mediationId);
    const pendingCommitments = commitments.filter((c) => ['pendiente', 'vencido'].includes(c.status));
    // pendiente por vencer también — no solo "abierta", que es lo obvio.
    const pendingTasks = tasks.filter((t) => ['pendiente', 'en_proceso'].includes(t.status));
    // Bloque 10: antes cualquier documento contaba como "final" — ahora
    // exige de verdad al menos uno marcado status:'final', no cualquiera.
    const hasFinalDocuments = documents.some((d) => d.status === 'final');
    // Bloque 10, chequeo nuevo: audiencias agendadas que nunca se resolvieron
    // (ni realizada, ni cancelada, ni no_realizada) — antes no se avisaba de esto al cerrar.
    const unresolvedHearings = hearings
      .filter((h) => ['programada', 'confirmada'].includes(h.status))
      .map((h) => ({ id: h.id, date: h.date, status: h.status }));
    // documentos todavía sin revisar (status:'recibido', el estado inicial) —
    // distinto de "no hay ningún documento final": puede haber documentos
    // finales Y ADEMÁS otros sin revisar todavía, la especificación pide
    // avisar de esto último específicamente.
    const documentsPendingReview = documents
      .filter((d) => d.status === 'recibido')
      .map((d) => ({ id: d.id, originalFilename: d.originalFilename }));
    // próxima acción sin resolver — reusa exactamente el mismo campo que ya
    // usa el dashboard (nextActionText), no un concepto nuevo.
    const hasPendingNextAction = !!(mediation && mediation.nextActionText && mediation.nextActionText.trim());
    return {
      hearingsRegistered: hearings.length > 0,
      hasFinalDocuments,
      documentsPendingReview,
      hasPendingNextAction,
      pendingTasks: pendingTasks.map((t) => ({ id: t.id, title: t.title })),
      pendingCommitments: pendingCommitments.map((c) => ({ id: c.id, description: c.description, partyName: partyDisplayName(db, c.partyId) })),
      unresolvedHearings,
    };
  }

  router.get('/:id/close-checklist', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    res.json(buildCloseChecklist(db, req.mediation.id));
  });

  router.post('/:id/close', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { result, notes, confirmDespiteWarnings } = req.body || {};
    if (!CLOSE_RESULTS.includes(result)) {
      return res.status(400).json({ error: 'Resultado de cierre inválido' });
    }
    const db = getDB();
    const mediation = db.mediations.find((m) => m.id === req.mediation.id);
    if (mediation.closedAt) return res.status(400).json({ error: 'Esta mediación ya está cerrada' });

    const checklist = buildCloseChecklist(db, mediation.id);
    // la spec permite cerrar con pendientes, pero no en silencio — si hay
    // compromisos sin resolver O audiencias sin resolver (Bloque 10) y el
    // mediador no confirmó explícitamente que quiere cerrar igual, se le
    // devuelve la advertencia en vez de cerrar.
    const hasWarnings = checklist.pendingCommitments.length > 0 || checklist.unresolvedHearings.length > 0
      || checklist.pendingTasks.length > 0 || checklist.documentsPendingReview.length > 0 || checklist.hasPendingNextAction;
    if (hasWarnings && !confirmDespiteWarnings) {
      const parts = [];
      if (checklist.pendingCommitments.length > 0) parts.push('compromisos pendientes');
      if (checklist.unresolvedHearings.length > 0) parts.push('audiencias sin resolver');
      if (checklist.pendingTasks.length > 0) parts.push('tareas pendientes');
      if (checklist.documentsPendingReview.length > 0) parts.push('documentos sin revisar');
      if (checklist.hasPendingNextAction) parts.push('una próxima acción todavía cargada');
      return res.status(409).json({ error: `Hay ${parts.join(', ')}`, checklist, needsConfirmation: true });
    }

    const fromStatus = mediation.status;
    mediation.status = CLOSE_RESULT_TO_STATUS[result];
    mediation.closedAt = Date.now();
    mediation.closedResult = result;
    mediation.closedNotes = notes || null;
    mediation.closedBy = req.user.id; // Bloque 10 — "responsable del cierre", faltaba desde el Bloque 8

    db.mediationStatusHistory.push({
      id: nanoid(), mediationId: mediation.id, fromStatus, toStatus: mediation.status,
      changedBy: req.user.id, note: `Cierre: ${result}`, createdAt: Date.now(),
    });
    logMediationEvent(db, {
      mediationId: mediation.id, type: 'MEDIATION_CLOSED', actorId: req.user.id,
      entityType: 'mediation', entityId: mediation.id,
      title: `Mediación cerrada: ${result}`, description: notes || null,
    });
    await commit();
    res.json(serializeMediation(mediation));
  });

  // ================= Bloque 8: exportación certificada =================

  // Bloque 10 — una sola función para juntar los datos de una mediación
  // completa (partes, abogados, audiencias, documentos, compromisos,
  // timeline público). La usan /export, /export/package y /expediente —
  // antes /export y /export/package tenían cada una su propia copia de
  // este mismo bloque; se consolida acá en vez de agregar una tercera copia.
  function gatherMediationExportData(db, mediation) {
    return {
      mediation,
      parties: db.parties.filter((p) => p.mediationId === mediation.id),
      lawyers: db.lawyers.filter((l) => l.mediationId === mediation.id),
      hearings: db.hearings.filter((h) => h.mediationId === mediation.id),
      documents: db.documents.filter((d) => d.mediationId === mediation.id),
      commitments: db.commitments.filter((c) => c.mediationId === mediation.id),
      timeline: db.mediationEvents
        .filter((e) => e.mediationId === mediation.id && e.visibility === 'public')
        .sort((a, b) => a.createdAt - b.createdAt),
    };
  }

  // Bloque 10 — expediente final: la vista A-K pedida, en JSON (para
  // mostrar en pantalla), no en PDF. Mismos datos exactos que la
  // exportación — mismo requireEditAccess, por la misma razón de
  // seguridad (no convertirse en una vía indirecta de ver todo lo de
  // todas las partes para quien no debería).
  router.get('/:id/expediente', requireAuth, requireMediationAccess, requireEditAccess, (req, res) => {
    const db = getDB();
    const data = gatherMediationExportData(db, req.mediation);
    const closedByUser = req.mediation.closedBy ? db.users.find((u) => u.id === req.mediation.closedBy) : null;
    const mediatorUser = db.users.find((u) => u.id === req.mediation.mediatorUserId);
    res.json({
      identificacion: serializeMediation(req.mediation), // A
      mediador: mediatorUser ? { id: mediatorUser.id, name: mediatorUser.name } : null, // B
      partes: data.parties.map(serializeParty), // C
      abogados: data.lawyers.map(serializeLawyer), // D
      audiencias: data.hearings.map((h) => serializeHearing(h, db.hearingConfirmations.filter((c) => c.hearingId === h.id))), // E
      documentos: data.documents.map(serializeDocument), // F
      timeline: data.timeline.map(serializeMediationEvent), // G
      tareas: db.tasks.filter((t) => t.mediationId === req.mediation.id).map(serializeTask), // H
      compromisos: data.commitments.map(serializeCommitment), // I
      resultado: req.mediation.closedResult || null, // J
      cierre: req.mediation.closedAt ? { // K
        closedAt: req.mediation.closedAt, closedNotes: req.mediation.closedNotes,
        closedByName: closedByUser ? closedByUser.name : null,
      } : null,
    });
  });

  router.get('/:id/export', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const mediation = req.mediation;
    const { parties, lawyers, hearings, documents, commitments, timeline } = gatherMediationExportData(db, mediation);

    try {
      const exportData = { mediation, parties, lawyers, hearings, documents, commitments, timeline };
      const plainContent = buildMediationPlainContent(exportData);
      const hash = integrityHash(plainContent);
      const signature = signHash(hash);
      const verifyUrl = `${process.env.FRONTEND_URL || ''}/verificar/${hash}`;

      const buffer = await buildMediationCertifiedPDF({
        ...exportData, hash, signature, verifyUrl,
        generatedBy: { name: req.user.name },
      });

      // el hash es determinístico a partir del contenido: exportar la MISMA
      // mediación dos veces sin actividad nueva en el medio da el mismo
      // hash. La columna es UNIQUE, así que insertar de nuevo rompía el
      // commit entero (y con él, cualquier otra escritura hasta reiniciar
      // el proceso — incluido el login) — mismo criterio que routes/channels.js.
      if (!db.certifiedExports.some((e) => e.hash === hash)) {
        db.certifiedExports.push({
          id: nanoid(), hash, signature, channelCode: null, mediationCode: mediation.code,
          generatedByName: req.user.name, generatedByRole: 'mediador', createdAt: Date.now(),
        });
      }
      await commit();

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="mediacion-${mediation.code}.pdf"`);
      res.send(buffer);
    } catch (err) {
      console.error('Error generando exportación de mediación:', err);
      res.status(500).json({ error: 'No se pudo generar la exportación' });
    }
  });

  // Bloque 22 (Parte 3) — documentos de trabajo. Mismo criterio de
  // permisos que la exportación certificada (requireEditAccess): un
  // abogado de solo lectura no puede generarlos, igual que no puede
  // exportar el expediente certificado.
  router.get('/:id/hearings/:hearingId/draft-minutes', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const mediation = req.mediation;
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    const parties = db.parties.filter((p) => p.mediationId === mediation.id && p.status === 'activa');
    const lawyers = db.lawyers.filter((l) => l.mediationId === mediation.id);
    const confirmations = db.hearingConfirmations.filter((c) => c.hearingId === hearing.id);
    try {
      const buffer = await buildDraftMinutesPDF({ mediation, hearing, parties, lawyers, confirmations });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="borrador-acta-${mediation.code}-${hearing.date}.pdf"`);
      res.send(buffer);
    } catch (err) {
      console.error('Error generando borrador de acta:', err);
      res.status(500).json({ error: 'No se pudo generar el borrador de acta' });
    }
  });

  router.get('/:id/hearings/:hearingId/convocation-letter', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const mediation = req.mediation;
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    const parties = db.parties.filter((p) => p.mediationId === mediation.id && p.status === 'activa');
    try {
      const buffer = await buildConvocationLetterPDF({ mediation, hearing, parties });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="convocatoria-${mediation.code}-${hearing.date}.pdf"`);
      res.send(buffer);
    } catch (err) {
      console.error('Error generando carta de convocatoria:', err);
      res.status(500).json({ error: 'No se pudo generar la carta de convocatoria' });
    }
  });

  // Herramientas Legales — Generador de actas (Bloque 41). Acta de
  // apertura: documento de trabajo, mismo patrón que draft-minutes de
  // arriba (banner BORRADOR, sin hash ni firma — eso queda reservado
  // para el acta de cierre, que es la que certifica el resultado final).
  router.get('/:id/export/acta-apertura', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const mediation = req.mediation;
    const parties = db.parties.filter((p) => p.mediationId === mediation.id && p.status === 'activa');
    const lawyers = db.lawyers.filter((l) => l.mediationId === mediation.id);
    try {
      const buffer = await buildOpeningActPDF({ mediation, parties, lawyers });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="acta-apertura-${mediation.code}.pdf"`);
      res.send(buffer);
    } catch (err) {
      console.error('Error generando acta de apertura:', err);
      res.status(500).json({ error: 'No se pudo generar el acta de apertura' });
    }
  });

  router.get('/:id/hearings/:hearingId/acta-incomparecencia', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const mediation = req.mediation;
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    if (hearing.status !== 'no_realizada') {
      return res.status(400).json({ error: 'Esta audiencia no está marcada como no realizada.' });
    }
    const parties = db.parties.filter((p) => p.mediationId === mediation.id && p.status === 'activa');
    const lawyers = db.lawyers.filter((l) => l.mediationId === mediation.id);
    const confirmations = db.hearingConfirmations.filter((c) => c.hearingId === hearing.id);
    const noteEvent = db.mediationEvents
      .filter((e) => e.type === 'HEARING_NOT_HELD' && e.entityId === hearing.id)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    try {
      const buffer = await buildNoShowActPDF({ mediation, hearing, parties, lawyers, confirmations, note: noteEvent?.description || hearing.notes || null });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="acta-incomparecencia-${mediation.code}-${hearing.date}.pdf"`);
      res.send(buffer);
    } catch (err) {
      console.error('Error generando acta de incomparecencia:', err);
      res.status(500).json({ error: 'No se pudo generar el acta de incomparecencia' });
    }
  });

  router.get('/:id/hearings/:hearingId/acta-reprogramacion', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const mediation = req.mediation;
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    const event = db.mediationEvents
      .filter((e) => e.type === 'HEARING_RESCHEDULED' && e.entityId === hearing.id)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!event) return res.status(400).json({ error: 'Esta audiencia no tiene ninguna reprogramación registrada.' });
    const meta = event.metadata || {};
    try {
      const buffer = await buildRescheduleActPDF({ mediation, hearing, fromDate: meta.fromDate, fromStartTime: meta.fromStartTime, toDate: meta.toDate, toStartTime: meta.toStartTime, note: event.description || null });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="acta-reprogramacion-${mediation.code}-${hearing.date}.pdf"`);
      res.send(buffer);
    } catch (err) {
      console.error('Error generando acta de reprogramación:', err);
      res.status(500).json({ error: 'No se pudo generar el acta de reprogramación' });
    }
  });

  // Bloque 10 — constancia corta: una sola página, contenido propio (no
  // reusa buildMediationPlainContent del informe completo, porque el hash
  // tiene que representar exactamente lo que ESTE documento muestra, no
  // el expediente entero).
  router.get('/:id/export/constancia', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const mediation = req.mediation;
    try {
      const plainContent = [
        'CONSTANCIA DE MEDIACIÓN', mediation.code, mediation.object,
        mediation.closedAt ? `Resultado: ${mediation.closedResult} — ${new Date(mediation.closedAt).toISOString()}` : 'En curso',
      ].join('\n');
      const hash = integrityHash(plainContent);
      const signature = signHash(hash);
      const verifyUrl = `${process.env.FRONTEND_URL || ''}/verificar/${hash}`;
      const buffer = await buildMediationConstanciaPDF({ mediation, hash, signature, verifyUrl });

      // ver el comentario de más arriba (export del informe completo): el
      // hash es determinístico, así que no duplicamos el registro si ya
      // existe uno con el mismo hash — insertar de nuevo rompía el commit
      // entero hasta reiniciar el proceso.
      if (!db.certifiedExports.some((e) => e.hash === hash)) {
        db.certifiedExports.push({
          id: nanoid(), hash, signature, channelCode: null, mediationCode: mediation.code,
          generatedByName: req.user.name, generatedByRole: 'mediador', createdAt: Date.now(),
        });
      }
      await commit();

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="constancia-${mediation.code}.pdf"`);
      res.send(buffer);
    } catch (err) {
      console.error('Error generando constancia de mediación:', err);
      res.status(500).json({ error: 'No se pudo generar la constancia' });
    }
  });

  // Bloque 34 — Acta de Cierre automática. Solo tiene sentido una vez
  // cerrada la mediación (closedResult/closedNotes recién existen a partir
  // de ahí) — nunca antes, a diferencia de la constancia que también sirve
  // para mediaciones en curso.
  router.get('/:id/export/acta-cierre', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const mediation = req.mediation;
    if (!mediation.closedAt) {
      return res.status(400).json({ error: 'La mediación todavía no está cerrada — el acta de cierre se genera recién al cerrarla.' });
    }
    try {
      const parties = db.parties.filter((p) => p.mediationId === mediation.id);
      const lawyers = db.lawyers.filter((l) => l.mediationId === mediation.id);
      const plainContent = buildMediationActaCierrePlainContent({ mediation, parties, lawyers });
      const hash = integrityHash(plainContent);
      const signature = signHash(hash);
      const verifyUrl = `${process.env.FRONTEND_URL || ''}/verificar/${hash}`;
      const buffer = await buildMediationActaCierrePDF({ mediation, parties, lawyers, hash, signature, verifyUrl, generatedBy: { name: req.user.name } });

      // el hash es determinístico a partir del contenido: volver a
      // descargar la MISMA acta sin cambios da el mismo hash. La columna
      // es UNIQUE, así que insertar de nuevo rompía el commit entero hasta
      // reiniciar el proceso — mismo criterio que el resto de las
      // exportaciones certificadas (ver el comentario en /export arriba).
      if (!db.certifiedExports.some((e) => e.hash === hash)) {
        db.certifiedExports.push({
          id: nanoid(), hash, signature, channelCode: null, mediationCode: mediation.code,
          generatedByName: req.user.name, generatedByRole: 'mediador', createdAt: Date.now(),
        });
      }
      await commit();

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="acta-cierre-${mediation.code}.pdf"`);
      res.send(buffer);
    } catch (err) {
      console.error('Error generando acta de cierre:', err);
      res.status(500).json({ error: 'No se pudo generar el acta de cierre' });
    }
  });

  // Bloque 10 — paquete documental final: el informe certificado COMPLETO
  // (misma función de siempre, sin duplicar) + cada documento original,
  // todo junto en un .zip — antes había que bajar el PDF y cada archivo
  // por separado.
  router.get('/:id/export/package', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const mediation = req.mediation;
    const { parties, lawyers, hearings, documents, commitments, timeline } = gatherMediationExportData(db, mediation);

    try {
      const exportData = { mediation, parties, lawyers, hearings, documents, commitments, timeline };
      const plainContent = buildMediationPlainContent(exportData);
      const hash = integrityHash(plainContent);
      const signature = signHash(hash);
      const verifyUrl = `${process.env.FRONTEND_URL || ''}/verificar/${hash}`;
      const pdfBuffer = await buildMediationCertifiedPDF({ ...exportData, hash, signature, verifyUrl, generatedBy: { name: req.user.name } });

      // ver el comentario de más arriba (export del informe completo): el
      // hash es determinístico, así que no duplicamos el registro si ya
      // existe uno con el mismo hash — insertar de nuevo rompía el commit
      // entero hasta reiniciar el proceso.
      if (!db.certifiedExports.some((e) => e.hash === hash)) {
        db.certifiedExports.push({
          id: nanoid(), hash, signature, channelCode: null, mediationCode: mediation.code,
          generatedByName: req.user.name, generatedByRole: 'mediador', createdAt: Date.now(),
        });
      }
      await commit();

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="paquete-${mediation.code}.zip"`);

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (err) => { console.error('Error armando el paquete:', err); if (!res.headersSent) res.status(500).end(); });
      archive.pipe(res);
      archive.append(pdfBuffer, { name: `informe-${mediation.code}.pdf` });
      for (const doc of documents) {
        const filePath = path.join(UPLOADS_ROOT, mediation.id, doc.storagePath);
        if (fs.existsSync(filePath)) archive.file(filePath, { name: `documentos/${doc.originalFilename}` });
      }
      await archive.finalize();
    } catch (err) {
      console.error('Error generando el paquete documental:', err);
      if (!res.headersSent) res.status(500).json({ error: 'No se pudo generar el paquete' });
    }
  });

  return router;
};
