// routes/admin-mediador.js
// Bloque 27 — "Centro de control de Mediador": admin console de PLATAFORMA
// para el producto Mediador, separado del panel general de Puente Digital
// (routes/admin.js, que es sobre coparentalidad) y separado del dashboard
// operativo de cada mediador (routes/mediations.js). Mismo mecanismo de
// autorización que routes/admin.js y routes/radar.js — isAdminUser de
// roles.js, sin sistema de permisos nuevo.
//
// Regla dura de todo el archivo (§16 de la spec): esto NUNCA expone
// contenido privado de una mediación — nunca texto de mensajes, nunca notas
// privadas, nunca el contenido de un documento. Todo lo que sale de acá es
// METADATA operativa (códigos, fechas, estados, conteos) — "ver datos
// operativos" sí, "acceder a contenido privado" no.

const express = require('express');
const { getDB, commit } = require('../db');
const { isAdminUser } = require('../roles');
const { logAudit } = require('../audit');
const { getJobStatuses, getRecentErrors } = require('../systemStatus');
const { getMyMediations } = require('../mediationAccess');
const radarEngine = require('../radarEngine');

const WHATSAPP_FAILURE_KINDS = ['notification_failed', 'notification_error', 'notification_unavailable', 'webhook_invalid_signature'];

function partyName(db, partyId) {
  const p = db.parties.find((x) => x.id === partyId);
  if (!p) return null;
  return p.legalName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || null;
}
function studioNameFor(db, userId) {
  const u = db.users.find((x) => x.id === userId);
  if (!u || !u.studioId) return null;
  const s = db.studios.find((x) => x.id === u.studioId);
  return s ? s.name : null;
}
function clampPaging(req) {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  return { limit, offset };
}
function paginate(list, { limit, offset }) {
  return { items: list.slice(offset, offset + limit), total: list.length, limit, offset };
}

module.exports = function () {
  const router = express.Router();

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    next();
  }
  // admin de ESTUDIO (studioRole==='admin') NUNCA entra acá — es un concepto
  // totalmente distinto de isAdminUser (admin de PLATAFORMA, por
  // ADMIN_EMAILS). Esto es justo lo que pide §2/§19.5: "no permitir que
  // admin de estudio sea tratado como admin de plataforma".
  function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (!isAdminUser(req.user)) return res.status(403).json({ error: 'No tenés acceso al centro de control de Mediador' });
    next();
  }
  router.use(requireAuth, requireAdmin);

  // ================= DASHBOARD (§4/§17/§18) =================
  router.get('/dashboard', (req, res) => {
    const db = getDB();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const realUsers = db.users.filter((u) => !u.guest);
    const activeUsers30d = realUsers.filter((u) => u.lastLoginAt && now - u.lastLoginAt <= 30 * day);
    const activeStudios = db.studios.filter((s) => s.status === 'activo');
    const activeMediatorIds = new Set(db.mediations.filter((m) => !m.closedAt).map((m) => m.mediatorUserId));
    const activeMediations = db.mediations.filter((m) => !m.closedAt);
    const closedMediations = db.mediations.filter((m) => !!m.closedAt);
    const upcomingHearings = db.hearings.filter((h) => ['programada', 'confirmada'].includes(h.status) && h.date >= new Date(now).toISOString().slice(0, 10) && new Date(h.date).getTime() - now <= 7 * day);
    const overdueTasks = db.tasks.filter((t) => ['pendiente', 'en_proceso'].includes(t.status) && t.dueDate && new Date(t.dueDate).getTime() < now);
    const recentFailedNotifications = db.whatsappLog.filter((w) => WHATSAPP_FAILURE_KINDS.includes(w.kind) && now - w.createdAt <= 7 * day);
    const recentErrors = getRecentErrors(500).filter((e) => now - e.at <= 24 * day / 24); // últimas 24h

    // §18 — "requiere atención": SIEMPRE basado en datos reales, nunca artificial.
    const attention = [];
    if (recentFailedNotifications.length >= 5) {
      attention.push({ type: 'notificaciones_fallidas', level: 'HIGH', detail: `${recentFailedNotifications.length} notificaciones fallidas en los últimos 7 días` });
    }
    const jobStatuses = getJobStatuses();
    for (const [name, status] of Object.entries(jobStatuses)) {
      if (status.lastErrorAt && (!status.lastOkAt || status.lastErrorAt > status.lastOkAt)) {
        attention.push({ type: 'job_con_error', level: 'HIGH', detail: `El job "${name}" falló en su última corrida: ${status.lastError}` });
      }
    }
    const studiosDesactivadosConActividad = db.studios.filter((s) => s.status !== 'activo' && db.users.some((u) => u.studioId === s.id && u.lastLoginAt && now - u.lastLoginAt <= 7 * day));
    if (studiosDesactivadosConActividad.length) {
      attention.push({ type: 'estudio_desactivado_con_actividad', level: 'MEDIUM', detail: `${studiosDesactivadosConActividad.length} estudio(s) desactivado(s) con accesos recientes de sus miembros` });
    }
    const radarPending = db.competitorChanges.filter((c) => c.status === 'nueva').length;
    if (radarPending >= 3) {
      attention.push({ type: 'radar_cambios_sin_revisar', level: 'LOW', detail: `${radarPending} cambios del radar competitivo sin revisar` });
    }
    // Bloque 28 §22 — solo estado técnico agregado, nunca URLs/tokens.
    const hearingsWithVideo = db.hearings.filter((h) => h.videoProvider);
    const videoErrors = hearingsWithVideo.filter((h) => h.meetingStatus === 'error');
    if (videoErrors.length >= 3) {
      attention.push({ type: 'videoconferencias_con_error', level: 'MEDIUM', detail: `${videoErrors.length} audiencia(s) con la videoconferencia en estado de error` });
    }

    res.json({
      kpis: {
        usuariosRegistrados: realUsers.length,
        usuariosActivos30d: activeUsers30d.length,
        estudiosActivos: activeStudios.length,
        mediadoresActivos: activeMediatorIds.size,
        mediacionesActivas: activeMediations.length,
        mediacionesCerradas: closedMediations.length,
        audienciasProximas7d: upcomingHearings.length,
        tareasVencidas: overdueTasks.length,
        notificacionesFallidas7d: recentFailedNotifications.length,
        erroresRecientes24h: recentErrors.length,
      },
      billing: { enabled: false, note: 'Billing todavía no está habilitado — sin datos de suscripciones.' },
      radar: {
        totalSources: db.competitorSources.length,
        pendingChanges: radarPending,
        pendingOpportunities: db.competitorOpportunities.filter((o) => o.status === 'pendiente').length,
      },
      video: {
        reunionesCreadas: hearingsWithVideo.length,
        reunionesConError: videoErrors.length,
        porProveedor: hearingsWithVideo.reduce((acc, h) => { acc[h.videoProvider] = (acc[h.videoProvider] || 0) + 1; return acc; }, {}),
      },
      requiereAtencion: attention,
    });
  });

  // ================= VIDEOCONFERENCIAS (Bloque 28 §22) =================
  // Métricas agregadas — reuniones creadas, con error, por proveedor,
  // errores por proveedor. NUNCA joinUrl/hostUrl/tokens (spec §22): el
  // admin ve estado técnico, no contenido privado de la mediación.
  router.get('/video-metrics', (req, res) => {
    const db = getDB();
    const withVideo = db.hearings.filter((h) => h.videoProvider);
    const porProveedor = {};
    const erroresPorProveedor = {};
    for (const h of withVideo) {
      porProveedor[h.videoProvider] = (porProveedor[h.videoProvider] || 0) + 1;
      if (h.meetingStatus === 'error') erroresPorProveedor[h.videoProvider] = (erroresPorProveedor[h.videoProvider] || 0) + 1;
    }
    res.json({
      reunionesCreadas: withVideo.filter((h) => ['creada', 'actualizada'].includes(h.meetingStatus)).length,
      reunionesConError: withVideo.filter((h) => h.meetingStatus === 'error').length,
      reunionesCanceladas: withVideo.filter((h) => h.meetingStatus === 'cancelada').length,
      porProveedor, erroresPorProveedor,
    });
  });

  // ================= ACTIVIDAD (§5) =================
  // Unifica mediationEvents (global, no por-mediación como en
  // routes/mediations.js) + altas de usuario/estudio + fallos de WhatsApp —
  // todo derivado de tablas que YA EXISTÍAN, sin un event bus nuevo.
  router.get('/activity', (req, res) => {
    const db = getDB();
    let events = [];

    for (const e of db.mediationEvents) {
      const mediation = db.mediations.find((m) => m.id === e.mediationId);
      events.push({
        id: `me_${e.id}`, type: e.type, createdAt: e.createdAt,
        actorId: e.actorId || null, actorName: e.actorId ? (db.users.find((u) => u.id === e.actorId)?.name || null) : null,
        entityType: 'mediation', entityId: e.mediationId, entityLabel: mediation ? mediation.code : null,
        studioId: mediation ? (db.users.find((u) => u.id === mediation.mediatorUserId)?.studioId || null) : null,
        resultado: 'ok', detail: e.title || null,
      });
    }
    for (const u of db.users) {
      if (u.guest) continue;
      events.push({ id: `user_${u.id}`, type: 'USER_REGISTERED', createdAt: u.createdAt, actorId: u.id, actorName: u.name, entityType: 'user', entityId: u.id, entityLabel: u.email, studioId: u.studioId || null, resultado: 'ok', detail: 'Nuevo usuario registrado' });
    }
    for (const s of db.studios) {
      events.push({ id: `studio_${s.id}`, type: 'STUDIO_CREATED', createdAt: s.createdAt, actorId: s.ownerId, actorName: db.users.find((u) => u.id === s.ownerId)?.name || null, entityType: 'studio', entityId: s.id, entityLabel: s.name, studioId: s.id, resultado: 'ok', detail: 'Nuevo estudio creado' });
    }
    for (const w of db.whatsappLog) {
      if (!WHATSAPP_FAILURE_KINDS.includes(w.kind)) continue;
      const mediation = w.mediationId ? db.mediations.find((m) => m.id === w.mediationId) : null;
      events.push({ id: `wa_${w.id}`, type: 'NOTIFICATION_FAILED', createdAt: w.createdAt, actorId: null, actorName: null, entityType: 'notification', entityId: w.id, entityLabel: mediation ? mediation.code : w.userName, studioId: mediation ? (db.users.find((u) => u.id === mediation.mediatorUserId)?.studioId || null) : null, resultado: 'error', detail: w.detail || w.kind });
    }

    if (req.query.type) events = events.filter((e) => e.type === req.query.type);
    if (req.query.userId) events = events.filter((e) => e.actorId === req.query.userId);
    if (req.query.studioId) events = events.filter((e) => e.studioId === req.query.studioId);
    if (req.query.mediationId) events = events.filter((e) => e.entityType === 'mediation' && e.entityId === req.query.mediationId);
    if (req.query.resultado) events = events.filter((e) => e.resultado === req.query.resultado);
    if (req.query.desde) events = events.filter((e) => e.createdAt >= Number(req.query.desde));
    if (req.query.hasta) events = events.filter((e) => e.createdAt <= Number(req.query.hasta));

    events.sort((a, b) => b.createdAt - a.createdAt);
    res.json(paginate(events, clampPaging(req)));
  });

  // ================= USUARIOS (§6) =================
  function serializeUserRow(db, u) {
    const mediationsCount = db.mediations.filter((m) => m.mediatorUserId === u.id).length + db.mediationAccess.filter((a) => a.userId === u.id).length;
    return {
      id: u.id, name: u.name, email: u.email || null, avatar: u.avatar || null,
      role: u.studioRole || (isAdminUser(u) ? 'admin_plataforma' : 'independiente'),
      studioId: u.studioId || null, studioName: studioNameFor(db, u.id),
      estado: u.disabledAt ? 'desactivado' : 'activo',
      createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null,
      mediationsCount,
    };
  }
  router.get('/users', (req, res) => {
    const db = getDB();
    let list = db.users.filter((u) => req.query.includeGuests === '1' || !u.guest);
    if (req.query.role) list = list.filter((u) => (u.studioRole || 'independiente') === req.query.role);
    if (req.query.studioId) list = list.filter((u) => u.studioId === req.query.studioId);
    if (req.query.estado) list = list.filter((u) => (u.disabledAt ? 'desactivado' : 'activo') === req.query.estado);
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      list = list.filter((u) => (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
    }
    list = [...list].sort((a, b) => b.createdAt - a.createdAt);
    const rows = list.map((u) => serializeUserRow(db, u));
    res.json(paginate(rows, clampPaging(req)));
  });

  router.get('/users/:id', (req, res) => {
    const db = getDB();
    const u = db.users.find((x) => x.id === req.params.id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const mediations = db.mediations
      .filter((m) => m.mediatorUserId === u.id || db.mediationAccess.some((a) => a.mediationId === m.id && a.userId === u.id))
      .map((m) => ({ id: m.id, code: m.code, object: m.object, status: m.status, createdAt: m.createdAt }));
    // actividad reciente: SOLO metadata de eventos donde esta persona fue actor — nunca contenido de mensajes.
    const recentActivity = db.mediationEvents
      .filter((e) => e.actorId === u.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20)
      .map((e) => ({ type: e.type, title: e.title, createdAt: e.createdAt, mediationId: e.mediationId }));
    res.json({
      ...serializeUserRow(db, u),
      billing: { enabled: false, note: 'Billing todavía no está habilitado.' },
      mediations,
      recentActivity,
    });
  });

  router.post('/users/:id/disable', async (req, res) => {
    const db = getDB();
    const u = db.users.find((x) => x.id === req.params.id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (isAdminUser(u)) return res.status(400).json({ error: 'No se puede desactivar una cuenta de admin de plataforma desde acá' });
    u.disabledAt = Date.now();
    logAudit(db, { actorId: req.user.id, action: 'admin_mediador_disable_user', channelCode: null, meta: { targetUserId: u.id, targetEmail: u.email } });
    await commit();
    res.json(serializeUserRow(db, u));
  });
  router.post('/users/:id/enable', async (req, res) => {
    const db = getDB();
    const u = db.users.find((x) => x.id === req.params.id);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    u.disabledAt = null;
    logAudit(db, { actorId: req.user.id, action: 'admin_mediador_enable_user', channelCode: null, meta: { targetUserId: u.id, targetEmail: u.email } });
    await commit();
    res.json(serializeUserRow(db, u));
  });

  // ================= ESTUDIOS (§7) =================
  function serializeStudioRow(db, s) {
    const memberCount = db.users.filter((u) => u.studioId === s.id).length;
    const mediationsCount = db.mediations.filter((m) => db.users.find((u) => u.id === m.mediatorUserId)?.studioId === s.id).length;
    return {
      id: s.id, name: s.name, ownerId: s.ownerId, ownerName: db.users.find((u) => u.id === s.ownerId)?.name || null,
      memberCount, mediationsCount, status: s.status, createdAt: s.createdAt,
    };
  }
  router.get('/studios', (req, res) => {
    const db = getDB();
    let list = [...db.studios];
    if (req.query.status) list = list.filter((s) => s.status === req.query.status);
    list.sort((a, b) => b.createdAt - a.createdAt);
    res.json(paginate(list.map((s) => serializeStudioRow(db, s)), clampPaging(req)));
  });
  router.get('/studios/:id', (req, res) => {
    const db = getDB();
    const s = db.studios.find((x) => x.id === req.params.id);
    if (!s) return res.status(404).json({ error: 'Estudio no encontrado' });
    const members = db.users.filter((u) => u.studioId === s.id).map((u) => ({ id: u.id, name: u.name, email: u.email, studioRole: u.studioRole, estado: u.disabledAt ? 'desactivado' : 'activo' }));
    const memberIds = new Set(members.map((m) => m.id));
    const mediations = db.mediations.filter((m) => memberIds.has(m.mediatorUserId)).map((m) => ({ id: m.id, code: m.code, status: m.status, createdAt: m.createdAt }));
    const mediationIds = new Set(mediations.map((m) => m.id));
    const recentActivity = db.mediationEvents.filter((e) => mediationIds.has(e.mediationId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20).map((e) => ({ type: e.type, title: e.title, createdAt: e.createdAt, mediationId: e.mediationId }));
    res.json({ ...serializeStudioRow(db, s), members, mediations, recentActivity });
  });

  // ================= MEDIACIONES — vista global (§8) =================
  router.get('/mediations', (req, res) => {
    const db = getDB();
    // getMyMediations ya devuelve TODAS para isAdminUser — misma función
    // que usa cada mediador para "las mías", sin bifurcar la autorización.
    let list = getMyMediations(db, req.user);
    if (req.query.status) list = list.filter((m) => m.status === req.query.status);
    if (req.query.mediatorUserId) list = list.filter((m) => m.mediatorUserId === req.query.mediatorUserId);
    if (req.query.studioId) list = list.filter((m) => db.users.find((u) => u.id === m.mediatorUserId)?.studioId === req.query.studioId);
    if (req.query.responsable) list = list.filter((m) => m.nextActionResponsibleType === req.query.responsable);
    if (req.query.alertas === '1') list = list.filter((m) => m.nextActionDueDate && new Date(m.nextActionDueDate).getTime() < Date.now());
    if (req.query.q) {
      const q = req.query.q.toLowerCase();
      list = list.filter((m) => m.code.toLowerCase().includes(q) || (m.internalNumber || '').toLowerCase().includes(q) || (db.users.find((u) => u.id === m.mediatorUserId)?.name || '').toLowerCase().includes(q) || (studioNameFor(db, m.mediatorUserId) || '').toLowerCase().includes(q));
    }
    list = [...list].sort((a, b) => b.createdAt - a.createdAt);
    const now = Date.now();
    const rows = list.map((m) => {
      const mediador = db.users.find((u) => u.id === m.mediatorUserId);
      const proximaAudiencia = db.hearings.filter((h) => h.mediationId === m.id && ['programada', 'confirmada'].includes(h.status) && h.date >= new Date(now).toISOString().slice(0, 10)).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
      return {
        id: m.id, code: m.code, internalNumber: m.internalNumber || null,
        mediadorNombre: mediador ? mediador.name : null, studioName: studioNameFor(db, m.mediatorUserId),
        status: m.status, nextActionText: m.nextActionText || null, nextActionResponsibleType: m.nextActionResponsibleType || null,
        nextActionDueDate: m.nextActionDueDate || null, vencida: !!(m.nextActionDueDate && new Date(m.nextActionDueDate).getTime() < now),
        proximaAudiencia: proximaAudiencia ? proximaAudiencia.date : null, createdAt: m.createdAt,
      };
    });
    res.json(paginate(rows, clampPaging(req)));
  });

  // ================= AUDIENCIAS — vista global (§9) =================
  router.get('/hearings', (req, res) => {
    const db = getDB();
    const myMediationIds = new Set(getMyMediations(db, req.user).map((m) => m.id));
    let list = db.hearings.filter((h) => myMediationIds.has(h.mediationId));
    const now = Date.now();
    const todayStr = new Date(now).toISOString().slice(0, 10);
    if (req.query.fecha === 'hoy') list = list.filter((h) => h.date === todayStr);
    if (req.query.fecha === 'proximas') list = list.filter((h) => h.date >= todayStr);
    if (req.query.estado) list = list.filter((h) => h.status === req.query.estado);
    if (req.query.modalidad) list = list.filter((h) => h.modality === req.query.modalidad);
    if (req.query.mediatorUserId) list = list.filter((h) => db.mediations.find((m) => m.id === h.mediationId)?.mediatorUserId === req.query.mediatorUserId);
    if (req.query.studioId) list = list.filter((h) => studioNameFor(db, db.mediations.find((m) => m.id === h.mediationId)?.mediatorUserId || '') !== null && db.users.find((u) => u.id === db.mediations.find((m) => m.id === h.mediationId)?.mediatorUserId)?.studioId === req.query.studioId);
    list.sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || ''));

    const rows = list.map((h) => {
      const mediation = db.mediations.find((m) => m.id === h.mediationId);
      const confirmations = db.hearingConfirmations.filter((c) => c.hearingId === h.id);
      return {
        id: h.id, mediationId: h.mediationId, mediationCode: mediation ? mediation.code : null,
        date: h.date, startTime: h.startTime, modality: h.modality, status: h.status,
        pendingConfirmations: confirmations.filter((c) => c.response === 'pendiente').length,
        sinResultado: ['programada', 'confirmada'].includes(h.status) && h.date < todayStr,
        realizadaSinProximaAccion: h.status === 'realizada' && mediation && !mediation.nextActionText,
      };
    });
    res.json({
      items: paginate(rows, clampPaging(req)),
      summary: {
        hoy: rows.filter((r) => r.date === todayStr).length,
        reprogramaciones: db.hearingRescheduleRequests.filter((r) => myMediationIds.has(r.mediationId) && r.status === 'aceptada').length,
        canceladas: rows.filter((r) => r.status === 'cancelada').length,
        confirmacionesPendientes: rows.reduce((sum, r) => sum + r.pendingConfirmations, 0),
        sinResultado: rows.filter((r) => r.sinResultado).length,
        realizadasSinProximaAccion: rows.filter((r) => r.realizadaSinProximaAccion).length,
      },
    });
  });

  // ================= NOTIFICACIONES (§10) =================
  router.get('/notifications', (req, res) => {
    const db = getDB();
    let list = [...db.whatsappLog];
    if (req.query.kind) list = list.filter((w) => w.kind === req.query.kind);
    if (req.query.mediationId) list = list.filter((w) => w.mediationId === req.query.mediationId);
    if (req.query.desde) list = list.filter((w) => w.createdAt >= Number(req.query.desde));
    list.sort((a, b) => b.createdAt - a.createdAt);
    const rows = list.map((w) => {
      const mediation = w.mediationId ? db.mediations.find((m) => m.id === w.mediationId) : null;
      return {
        id: w.id, createdAt: w.createdAt, kind: w.kind, canal: 'whatsapp',
        destinatario: w.userName || w.phone || null, mediationCode: mediation ? mediation.code : null,
        estado: WHATSAPP_FAILURE_KINDS.includes(w.kind) ? 'fallida' : (w.kind === 'notification_sent' ? 'enviada' : 'informativo'),
        detail: w.detail || null,
      };
    });
    res.json({
      ...paginate(rows, clampPaging(req)),
      pushSubscriptionsCount: db.pushSubscriptions.length,
    });
  });

  // ================= SISTEMA (§11/§12) =================
  router.get('/system', (req, res) => {
    const db = getDB();
    res.json({
      jobs: getJobStatuses(),
      recentErrors: getRecentErrors(100),
      webhooksInvalidosRecientes: db.whatsappLog.filter((w) => w.kind === 'webhook_invalid_signature').length,
    });
  });

  router.get('/system/health', async (req, res) => {
    const now = Date.now();
    const checks = {};

    // DB — lectura real, no simulada.
    try { getDB().users.length; checks.db = { status: 'OK' }; }
    catch (e) { checks.db = { status: 'ERROR', detail: e.message }; }

    checks.api = { status: 'OK' };

    // Jobs — ATENCIÓN si el último intento conocido falló; sin dato = recién
    // reiniciado, no se reporta como error (todavía no tuvo su primera corrida).
    const jobStatuses = getJobStatuses();
    const failedJobs = Object.entries(jobStatuses).filter(([, s]) => s.lastErrorAt && (!s.lastOkAt || s.lastErrorAt > s.lastOkAt));
    checks.jobs = failedJobs.length ? { status: 'ATENCION', detail: `${failedJobs.length} job(s) con error en su última corrida` } : { status: 'OK' };

    // WhatsApp — proporción de fallos en los últimos intentos recientes.
    const db = getDB();
    const recentWa = db.whatsappLog.filter((w) => now - w.createdAt <= 24 * 60 * 60 * 1000);
    const recentWaFailed = recentWa.filter((w) => WHATSAPP_FAILURE_KINDS.includes(w.kind));
    checks.whatsapp = recentWa.length && recentWaFailed.length / recentWa.length > 0.3
      ? { status: 'ATENCION', detail: `${recentWaFailed.length}/${recentWa.length} intentos fallidos en 24h` }
      : { status: 'OK' };

    // WebSocket — conteo real de sockets conectados ahora mismo (io se
    // inyecta desde server.js vía req.app, ver mount más abajo).
    const io = req.app.get('io');
    checks.websocket = io ? { status: 'OK', clientsConnected: io.engine.clientsCount } : { status: 'ATENCION', detail: 'io no disponible' };

    // Integraciones externas — solo si están CONFIGURADAS (nunca se prueba
    // el login real ni se manda un WhatsApp de prueba desde un health check).
    const whatsappModule = require('../whatsapp');
    checks.integraciones = {
      status: 'OK',
      google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      whatsapp: whatsappModule.configured(),
    };

    // almacenamiento — sin verificación real implementada (no hay chequeo
    // de espacio en disco en este stack); se declara explícitamente en vez
    // de simular un estado.
    checks.almacenamiento = { status: 'NO_IMPLEMENTADO', detail: 'Sin chequeo de espacio en disco implementado todavía' };

    res.json(checks);
  });

  // ================= BILLING (§13) =================
  router.get('/billing', (req, res) => {
    res.json({ enabled: false, message: 'Billing todavía no está habilitado.' });
  });

  // ================= RADAR — resumen (§14) =================
  // No duplica /radar.html ni routes/radar.js: solo un resumen liviano para
  // el dashboard del admin console. El detalle completo sigue viviendo en
  // el módulo del radar (link desde el sidebar).
  router.get('/radar-summary', (req, res) => {
    const db = getDB();
    res.json({
      totalSources: db.competitorSources.length,
      activeSources: db.competitorSources.filter((s) => s.active).length,
      pendingChanges: db.competitorChanges.filter((c) => c.status === 'nueva').length,
      pendingOpportunities: db.competitorOpportunities.filter((o) => o.status === 'pendiente').length,
      featureCatalogSize: radarEngine.FEATURE_CATALOG.length,
    });
  });

  return router;
};
