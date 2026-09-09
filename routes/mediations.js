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
const { integrityHash, buildMediationPlainContent, buildMediationCertifiedPDF, buildMediationConstanciaPDF } = require('../certificate');
const { askMediationAssistant, askDashboardAssistant } = require('../assistant');
const archiver = require('archiver');
const { postMessage } = require('../messaging');
const { serializeMessage } = require('../serializers');

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
  };
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
    createdAt: m.createdAt,
  };
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

  // ---------- crear mediación ----------
  router.post('/', requireAuth, async (req, res) => {
    const { type, object, description, internalNumber } = req.body || {};
    if (!object || !object.trim()) {
      return res.status(400).json({ error: 'Falta el objeto de la mediación' });
    }

    const db = getDB();

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
    res.json(serializeMediation(mediation));
  });

  // ---------- listar mis mediaciones ----------
  // "mis" = soy el mediador titular, o tengo una fila en mediation_access
  // (asistente/abogado), o soy admin (ve todas). Mismo chequeo que
  // requireMediationAccess pero para una lista, no para un id puntual.
  //
  // Filtros opcionales por query string (nuevo, a pedido explícito):
  //   ?estado=iniciada            -> por status exacto
  //   ?responsable=mediador       -> por nextActionResponsibleType
  //   ?vencidas=1                 -> solo con nextActionDueDate ya pasado
  router.get('/', requireAuth, (req, res) => {
    const db = getDB();
    let mine;
    if (isAdminUser(req.user)) {
      mine = db.mediations;
    } else {
      const accessIds = new Set(
        db.mediationAccess.filter((a) => a.userId === req.user.id).map((a) => a.mediationId)
      );
      mine = db.mediations.filter((m) => m.mediatorUserId === req.user.id || accessIds.has(m.id));
    }
    if (req.query.estado) mine = mine.filter((m) => m.status === req.query.estado);
    if (req.query.responsable) mine = mine.filter((m) => m.nextActionResponsibleType === req.query.responsable);
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
  router.get('/search', requireAuth, (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json([]);
    const db = getDB();
    const accessIds = new Set(
      db.mediationAccess.filter((a) => a.userId === req.user.id).map((a) => a.mediationId)
    );
    const scope = isAdminUser(req.user)
      ? db.mediations
      : db.mediations.filter((m) => m.mediatorUserId === req.user.id || accessIds.has(m.id));
    const results = scope.filter((m) =>
      m.code.toLowerCase().includes(q) ||
      (m.object || '').toLowerCase().includes(q) ||
      (m.internalNumber || '').toLowerCase().includes(q)
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
    const accessIds = new Set(
      db.mediationAccess.filter((a) => a.userId === req.user.id).map((a) => a.mediationId)
    );
    const mine = isAdminUser(req.user)
      ? db.mediations
      : db.mediations.filter((m) => m.mediatorUserId === req.user.id || accessIds.has(m.id));

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

    const proximasAudiencias = db.hearings
      .filter((h) => mineIds.has(h.mediationId) && ['programada', 'confirmada'].includes(h.status))
      .filter((h) => new Date(h.date).getTime() >= now - 24 * 60 * 60 * 1000) // no mostrar audiencias muy viejas que quedaron sin cerrar
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 10)
      .map((h) => ({ id: h.id, mediationId: h.mediationId, mediationCode: mediationById[h.mediationId]?.code || null, date: h.date, startTime: h.startTime, modality: h.modality, status: h.status }));

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
    });
  });

  // Bloque 12 — asistente cross-mediación: arma un resumen en texto plano
  // de TODAS las mediaciones activas del usuario (no solo una), para
  // preguntas del estilo "¿qué mediaciones tienen algo pendiente esta
  // semana?". Reusa el mismo criterio de "mis mediaciones" que ya usan
  // GET / y GET /dashboard — no un cálculo nuevo.
  function buildDashboardPlainContext(db, user) {
    const accessIds = new Set(db.mediationAccess.filter((a) => a.userId === user.id).map((a) => a.mediationId));
    const mine = isAdminUser(user)
      ? db.mediations
      : db.mediations.filter((m) => m.mediatorUserId === user.id || accessIds.has(m.id));
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
    const accessIds = new Set(db.mediationAccess.filter((a) => a.userId === req.user.id).map((a) => a.mediationId));
    const mine = isAdminUser(req.user)
      ? db.mediations
      : db.mediations.filter((m) => m.mediatorUserId === req.user.id || accessIds.has(m.id));

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

  // ---------- expediente (registro básico — el resumen agregado con
  // partes/audiencias/etc es el Bloque 3, acá todavía no existen esas
  // tablas) ----------
  router.get('/:id', requireAuth, requireMediationAccess, (req, res) => {
    res.json(serializeMediation(req.mediation));
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
  router.get('/:id/status-history', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const history = db.mediationStatusHistory
      .filter((h) => h.mediationId === req.mediation.id)
      .sort((a, b) => a.createdAt - b.createdAt);
    res.json(history);
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
    return {
      id: h.id, mediationId: h.mediationId, date: h.date, startTime: h.startTime, endTime: h.endTime,
      type: h.type, modality: h.modality, location: h.location, meetingUrl: h.meetingUrl,
      status: h.status, notes: h.notes, createdAt: h.createdAt,
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
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'PARTY_INVITED', actorId: req.user.id,
      entityType: 'party', entityId: party.id, title: `Invitación al portal generada para ${partyDisplayName(db, party.id)}`,
    });
    await commit();
    res.json({ portalToken: party.portalToken, portalUrl: `/portal.html?token=${party.portalToken}` });
  });

  // ---------- comunicaciones con una parte (lado del mediador) ----------
  // el hilo de esta parte, si ya se le generó uno al invitarla — nunca
  // antes, no tiene sentido un chat sin nadie del otro lado todavía.
  router.get('/:id/parties/:partyId/messages', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.partyId === req.params.partyId);
    if (!thread) return res.json([]);
    const messages = db.messages.filter((m) => m.channelId === thread.id).sort((a, b) => a.createdAt - b.createdAt);
    res.json(messages.map(serializeMessage));
  });

  router.post('/:id/parties/:partyId/messages', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'Falta el texto del mensaje' });
    const db = getDB();
    const thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.partyId === req.params.partyId);
    if (!thread) return res.status(400).json({ error: 'Esta parte todavía no fue invitada al portal' });
    const msg = await postMessage(io, thread, { senderId: req.user.id, text: text.trim(), flagged: false });
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'MESSAGE_SENT', actorId: req.user.id,
      visibility: 'mediator_only', entityType: 'message', entityId: msg.id,
      title: `Mensaje enviado a ${partyDisplayName(db, req.params.partyId)}`,
    });
    await commit();
    res.json(msg);
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

    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'LAWYER_INVITED', actorId: req.user.id,
      entityType: 'lawyer', entityId: lawyer.id, title: `Invitación al portal generada para ${lawyer.name}`,
    });
    await commit();
    res.json({ portalToken: lawyer.portalToken, portalUrl: `/lawyer-portal.html?token=${lawyer.portalToken}` });
  });

  // ---------- audiencias ----------
  router.get('/:id/hearings', requireAuth, requireMediationAccess, (req, res) => {
    const db = getDB();
    const list = db.hearings.filter((h) => h.mediationId === req.mediation.id).sort((a, b) => a.date.localeCompare(b.date));
    res.json(list.map((h) => serializeHearing(h, db.hearingConfirmations.filter((c) => c.hearingId === h.id))));
  });

  // regla del motor operativo (IMPLEMENTATION_PLAN.md §3.11):
  // HEARING_SCHEDULED -> genera una fila de confirmación pendiente por
  // cada parte activa de la mediación, automático, en el mismo request.
  router.post('/:id/hearings', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { date, startTime, endTime, type, modality, location, meetingUrl, notes } = req.body || {};
    if (!date) return res.status(400).json({ error: 'Falta la fecha de la audiencia' });
    const db = getDB();
    const hearing = {
      id: nanoid(), mediationId: req.mediation.id, date, startTime: startTime || null, endTime: endTime || null,
      type: type || 'primera', modality: modality || 'presencial', location: location || null, meetingUrl: meetingUrl || null,
      status: 'programada', notes: notes || null, createdAt: Date.now(),
    };
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
      title: `Audiencia agendada: ${hearing.date}${hearing.startTime ? ' ' + hearing.startTime : ''}`,
      description: `Se generaron ${confirmations.length} confirmación(es) pendiente(s)`,
    });

    await commit();
    res.json(serializeHearing(hearing, confirmations));
  });

  const HEARING_STATUS_EVENT_TYPE = {
    confirmada: 'HEARING_CONFIRMED', realizada: 'HEARING_HELD',
    cancelada: 'HEARING_CANCELLED', no_realizada: 'HEARING_NOT_HELD',
  };

  router.post('/:id/hearings/:hearingId/status', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { status } = req.body || {};
    if (!['programada', 'confirmada', 'realizada', 'cancelada', 'no_realizada'].includes(status)) {
      return res.status(400).json({ error: 'Estado de audiencia inválido' });
    }
    const db = getDB();
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === req.mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada en esta mediación' });
    hearing.status = status;

    let hearingEvent = null;
    if (HEARING_STATUS_EVENT_TYPE[status]) {
      hearingEvent = logMediationEvent(db, {
        mediationId: req.mediation.id, type: HEARING_STATUS_EVENT_TYPE[status], actorId: req.user.id,
        entityType: 'hearing', entityId: hearing.id,
        title: `Audiencia ${status}: ${hearing.date}`,
      });
    }

    await commit();
    const response = serializeHearing(hearing, db.hearingConfirmations.filter((c) => c.hearingId === hearing.id));
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

  // el mediador registra la respuesta de una parte "a mano" (llamada,
  // WhatsApp, lo que sea) — el endpoint donde la PARTE confirma ella misma
  // desde el portal, sin cuenta, es el Bloque 7, todavía no existe.
  function serializeRescheduleRequest(r) {
    return {
      id: r.id, hearingId: r.hearingId, mediationId: r.mediationId,
      requestedByPartyId: r.requestedByPartyId, requestedByType: r.requestedByType, requestedByLawyerId: r.requestedByLawyerId,
      reason: r.reason, proposedDate: r.proposedDate, proposedStartTime: r.proposedStartTime,
      status: r.status, mediatorNote: r.mediatorNote, resolvedBy: r.resolvedBy, resolvedAt: r.resolvedAt, createdAt: r.createdAt,
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

  // "Solo el mediador puede confirmar/rechazar/proponer la reprogramación
  // definitiva" — requireEditAccess, ninguna excepción. Ni la parte ni el
  // abogado tienen ningún endpoint que toque hearings.date directamente
  // (confirmar el pedido de cambio en el portal solo crea la SOLICITUD).
  router.post('/:id/hearings/:hearingId/reschedule-requests/:requestId/resolve', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { action, newDate, newStartTime, note } = req.body || {};
    if (!['aceptar', 'rechazar', 'proponer'].includes(action)) {
      return res.status(400).json({ error: 'Acción inválida — usar aceptar, rechazar o proponer' });
    }
    const db = getDB();
    const request = db.hearingRescheduleRequests.find(
      (r) => r.id === req.params.requestId && r.hearingId === req.params.hearingId && r.mediationId === req.mediation.id
    );
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada en esta mediación' });
    if (request.status !== 'pendiente') return res.status(400).json({ error: 'Esta solicitud ya fue resuelta' });
    const hearing = db.hearings.find((h) => h.id === req.params.hearingId && h.mediationId === req.mediation.id);
    if (!hearing) return res.status(404).json({ error: 'Audiencia no encontrada' });

    if (action === 'rechazar') {
      request.status = 'rechazada';
      request.mediatorNote = note || null;
      request.resolvedBy = req.user.id;
      request.resolvedAt = Date.now();
      logMediationEvent(db, {
        mediationId: req.mediation.id, type: 'HEARING_RESCHEDULE_REJECTED', actorId: req.user.id,
        entityType: 'hearing_reschedule_request', entityId: request.id,
        title: 'El mediador rechazó el pedido de cambio de audiencia', description: note || null,
      });
      await commit();
      return res.json(serializeRescheduleRequest(request));
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

    const fromDate = hearing.date;
    const fromStartTime = hearing.startTime;
    hearing.date = targetDate;
    hearing.startTime = targetStartTime;
    hearing.status = 'programada'; // vuelve a programada — hay que reconfirmar contra la fecha nueva

    // se reinician TODAS las confirmaciones de esta audiencia — una
    // confirmación contra la fecha vieja no dice nada sobre la fecha
    // nueva, así que no tiene sentido dejarla como estaba.
    const resetConfirmations = db.hearingConfirmations.filter((c) => c.hearingId === hearing.id);
    resetConfirmations.forEach((c) => { c.response = 'pendiente'; c.respondedAt = null; });

    request.status = 'reprogramada';
    request.mediatorNote = note || null;
    request.resolvedBy = req.user.id;
    request.resolvedAt = Date.now();

    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'HEARING_RESCHEDULED', actorId: req.user.id,
      entityType: 'hearing', entityId: hearing.id,
      title: `Audiencia reprogramada: ${fromDate} → ${targetDate}`,
      description: note || null,
      metadata: { fromDate, fromStartTime, toDate: targetDate, toStartTime: targetStartTime, resolvedRequestId: request.id },
      causedByEventId: null,
    });
    await commit();
    res.json({ request: serializeRescheduleRequest(request), hearing: serializeHearing(hearing, resetConfirmations) });
  });


  router.post('/:id/hearings/:hearingId/confirmations/:partyId', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { response } = req.body || {};
    if (!['confirma', 'no_puede', 'pide_cambio', 'pendiente'].includes(response)) {
      return res.status(400).json({ error: 'Respuesta inválida' });
    }
    const db = getDB();
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
    const { status } = req.body || {};
    if (!['pendiente_escaneo', 'recibido', 'pendiente_revision', 'revisado', 'observado', 'final'].includes(status)) {
      return res.status(400).json({ error: 'Estado de documento inválido' });
    }
    const db = getDB();
    const doc = db.documents.find((d) => d.id === req.params.docId && d.mediationId === req.mediation.id);
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado en esta mediación' });
    doc.status = status;
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'DOCUMENT_REVIEWED', actorId: req.user.id,
      entityType: 'document', entityId: doc.id, title: `Documento ${status}: ${doc.originalFilename}`,
    });
    await commit();
    res.json(serializeDocument(doc));
  });

  router.post('/:id/documents', requireAuth, requireMediationAccess, requireEditAccess,
    (req, res, next) => {
      uploadDocument.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'No se pudo subir el archivo' });
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
        if (err) return res.status(400).json({ error: err.message || 'No se pudo subir el archivo' });
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

  router.get('/:id/documents/:docId/download', requireAuth, requireMediationAccess, async (req, res) => {
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
    };
  }
  function serializeCommitment(c) {
    return {
      id: c.id, mediationId: c.mediationId, partyId: c.partyId, description: c.description, dueDate: c.dueDate,
      status: c.status, createdFromEventId: c.createdFromEventId, completedAt: c.completedAt, createdAt: c.createdAt,
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

  router.post('/:id/tasks', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const { title, description, dueDate, priority } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'Falta el título de la tarea' });
    const db = getDB();
    const task = {
      id: nanoid(), mediationId: req.mediation.id, assignedTo: req.user.id,
      title: title.trim(), description: description || null, dueDate: dueDate || null,
      priority: ['baja', 'media', 'alta', 'urgente'].includes(priority) ? priority : 'media',
      status: 'pendiente', createdBy: req.user.id, completedAt: null, createdAt: Date.now(),
    };
    db.tasks.push(task);
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'TASK_CREATED', actorId: req.user.id,
      entityType: 'task', entityId: task.id, title: `Tarea creada: ${task.title}`,
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
    const { partyId, description, dueDate, causedByEventId } = req.body || {};
    if (!partyId) return res.status(400).json({ error: 'Falta la parte responsable del compromiso' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'Falta la descripción del compromiso' });
    const db = getDB();
    const party = db.parties.find((p) => p.id === partyId && p.mediationId === req.mediation.id);
    if (!party) return res.status(400).json({ error: 'La parte indicada no existe en esta mediación' });
    const commitment = {
      id: nanoid(), mediationId: req.mediation.id, partyId, description: description.trim(),
      dueDate: dueDate || null, status: 'pendiente', createdFromEventId: causedByEventId || null,
      completedAt: null, createdAt: Date.now(),
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
    });
    await commit();
    res.json(serializeCommitment(commitment));
  });

  router.patch('/:id/commitments/:commitmentId', requireAuth, requireMediationAccess, requireEditAccess, async (req, res) => {
    const db = getDB();
    const commitment = db.commitments.find((c) => c.id === req.params.commitmentId && c.mediationId === req.mediation.id);
    if (!commitment) return res.status(404).json({ error: 'Compromiso no encontrado en esta mediación' });
    const { description, dueDate, status } = req.body || {};
    if (description !== undefined) commitment.description = description;
    if (dueDate !== undefined) commitment.dueDate = dueDate;
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

      db.certifiedExports.push({
        id: nanoid(), hash, signature, channelCode: null, mediationCode: mediation.code,
        generatedByName: req.user.name, generatedByRole: 'mediador', createdAt: Date.now(),
      });
      await commit();

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="mediacion-${mediation.code}.pdf"`);
      res.send(buffer);
    } catch (err) {
      console.error('Error generando exportación de mediación:', err);
      res.status(500).json({ error: 'No se pudo generar la exportación' });
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

      db.certifiedExports.push({
        id: nanoid(), hash, signature, channelCode: null, mediationCode: mediation.code,
        generatedByName: req.user.name, generatedByRole: 'mediador', createdAt: Date.now(),
      });
      await commit();

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="constancia-${mediation.code}.pdf"`);
      res.send(buffer);
    } catch (err) {
      console.error('Error generando constancia de mediación:', err);
      res.status(500).json({ error: 'No se pudo generar la constancia' });
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

      db.certifiedExports.push({
        id: nanoid(), hash, signature, channelCode: null, mediationCode: mediation.code,
        generatedByName: req.user.name, generatedByRole: 'mediador', createdAt: Date.now(),
      });
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
