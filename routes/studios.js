// routes/studios.js
// Bloque 14 (Parte 1) — núcleo multiusuario/estudio. Esto NO es un
// sistema de permisos paralelo: sigue siendo mediation_access quien
// decide el acceso a CADA mediación puntual (ver requireMediationAccess
// en routes/mediations.js, que solo gana una rama nueva: admin de
// estudio con acceso general a las mediaciones de su equipo). Acá vive
// únicamente la administración del equipo en sí — quién pertenece, con
// qué rol, y las invitaciones.

const express = require('express');
const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');
const { logAudit } = require('../audit');

module.exports = function () {
  const router = express.Router();

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    next();
  }

  // admin de ESTUDIO — nada que ver con isAdminUser (ese es admin de
  // plataforma, por ADMIN_EMAILS, un concepto totalmente distinto).
  function requireStudioAdmin(req, res, next) {
    if (!req.user.studioId || req.user.studioRole !== 'admin') {
      return res.status(403).json({ error: 'Necesitás ser administrador del estudio para hacer esto' });
    }
    next();
  }

  function serializeStudio(s) {
    return { id: s.id, name: s.name, ownerId: s.ownerId, status: s.status, createdAt: s.createdAt };
  }
  function serializeMember(u) {
    return { id: u.id, name: u.name, email: u.email, avatar: u.avatar, studioRole: u.studioRole, createdAt: u.createdAt };
  }
  function serializeInvitation(i) {
    return {
      id: i.id, studioId: i.studioId, email: i.email, role: i.role,
      status: i.status, createdAt: i.createdAt, resolvedAt: i.resolvedAt,
      // el token en sí NUNCA sale acá salvo en el momento de crearla (ver
      // POST /invitations) — mismo criterio que portalToken de partes/
      // abogados: es la credencial, no un dato para listar.
    };
  }

  // ---------- crear estudio ----------
  // cualquier usuario autenticado puede crear UNO — se vuelve owner+admin
  // automáticamente. No se permite crear un segundo si ya pertenece a uno.
  router.post('/', requireAuth, async (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Falta el nombre del estudio' });
    const db = getDB();
    if (req.user.studioId) return res.status(400).json({ error: 'Ya pertenecés a un estudio' });

    const studio = { id: nanoid(), name: name.trim(), ownerId: req.user.id, status: 'activo', createdAt: Date.now() };
    db.studios.push(studio);
    const user = db.users.find((u) => u.id === req.user.id);
    user.studioId = studio.id;
    user.studioRole = 'admin';
    logAudit(db, { actorId: req.user.id, action: 'studio_created', channelCode: null, meta: { studioId: studio.id, name: studio.name } });
    await commit();
    res.json(serializeStudio(studio));
  });

  // ---------- mi estudio + equipo ----------
  router.get('/me', requireAuth, (req, res) => {
    const db = getDB();
    if (!req.user.studioId) return res.json(null);
    const studio = db.studios.find((s) => s.id === req.user.studioId);
    if (!studio) return res.json(null);
    const members = db.users.filter((u) => u.studioId === studio.id).map(serializeMember);
    res.json({ ...serializeStudio(studio), members, myRole: req.user.studioRole });
  });

  // ---------- invitaciones ----------
  router.post('/invitations', requireAuth, requireStudioAdmin, async (req, res) => {
    const { email, role } = req.body || {};
    if (!email || !email.trim()) return res.status(400).json({ error: 'Falta el email' });
    if (!['admin', 'mediador', 'asistente'].includes(role)) {
      return res.status(400).json({ error: "Rol inválido — usar 'admin', 'mediador' o 'asistente'" });
    }
    const db = getDB();
    // Bloque 14 (Parte 3): un estudio dado de baja no admite invitaciones nuevas
    const studio = db.studios.find((s) => s.id === req.user.studioId);
    if (studio && studio.status !== 'activo') return res.status(400).json({ error: 'El estudio está dado de baja — no se pueden enviar invitaciones' });
    const normalizedEmail = email.trim().toLowerCase();
    // no duplicar cuenta ni invitación: si esa persona ya es del estudio, cortar acá
    const alreadyMember = db.users.find((u) => u.studioId === req.user.studioId && u.email?.toLowerCase() === normalizedEmail);
    if (alreadyMember) return res.status(400).json({ error: 'Esa persona ya pertenece al estudio' });
    const pendingInvite = db.studioInvitations.find((i) => i.studioId === req.user.studioId && i.email === normalizedEmail && i.status === 'pendiente');
    if (pendingInvite) return res.status(400).json({ error: 'Ya hay una invitación pendiente para ese email' });

    const invitation = {
      id: nanoid(), studioId: req.user.studioId, email: normalizedEmail, role,
      token: nanoid(24), invitedBy: req.user.id, status: 'pendiente', createdAt: Date.now(), resolvedAt: null,
    };
    db.studioInvitations.push(invitation);
    logAudit(db, { actorId: req.user.id, action: 'studio_invitation_sent', channelCode: null, meta: { studioId: req.user.studioId, email: normalizedEmail, role } });
    await commit();
    // acá SÍ sale el token — es el único momento en que hace falta, para
    // que el admin se lo pueda pasar a la persona invitada.
    res.json({ ...serializeInvitation(invitation), token: invitation.token, invitationUrl: `/studio-invitation.html?token=${invitation.token}` });
  });

  router.get('/invitations', requireAuth, requireStudioAdmin, (req, res) => {
    const db = getDB();
    const list = db.studioInvitations.filter((i) => i.studioId === req.user.studioId).sort((a, b) => b.createdAt - a.createdAt);
    res.json(list.map(serializeInvitation));
  });

  // ver el detalle de UNA invitación por token — sin requireAuth todavía,
  // para que la persona pueda ver "te invitaron a tal estudio" ANTES de
  // loguearse con Google, pero sin aceptarla hasta que sí lo haga.
  router.get('/invitations/:token', (req, res) => {
    const db = getDB();
    const invitation = db.studioInvitations.find((i) => i.token === req.params.token);
    if (!invitation) return res.status(404).json({ error: 'Invitación inválida o vencida' });
    const studio = db.studios.find((s) => s.id === invitation.studioId);
    res.json({ email: invitation.email, role: invitation.role, status: invitation.status, studioName: studio ? studio.name : null });
  });

  router.post('/invitations/:token/accept', requireAuth, async (req, res) => {
    const db = getDB();
    const invitation = db.studioInvitations.find((i) => i.token === req.params.token);
    if (!invitation) return res.status(404).json({ error: 'Invitación inválida o vencida' });
    if (invitation.status !== 'pendiente') return res.status(400).json({ error: 'Esta invitación ya fue resuelta' });
    // el chequeo central de todo este flujo: el email de la SESIÓN actual
    // tiene que coincidir con el de la invitación — nunca se acepta "en
    // nombre de" otra persona con solo tener el link.
    if ((req.user.email || '').toLowerCase() !== invitation.email) {
      return res.status(403).json({ error: 'Esta invitación es para otra cuenta de Google' });
    }
    if (req.user.studioId) return res.status(400).json({ error: 'Ya pertenecés a un estudio' });
    // Bloque 14 (Parte 3): el estudio pudo haberse dado de baja ENTRE que
    // se mandó la invitación y que se intenta aceptar — se revalida acá,
    // no solo al crearla.
    const targetStudio = db.studios.find((s) => s.id === invitation.studioId);
    if (targetStudio && targetStudio.status !== 'activo') {
      return res.status(400).json({ error: 'Este estudio fue dado de baja — la invitación ya no es válida' });
    }

    const user = db.users.find((u) => u.id === req.user.id);
    user.studioId = invitation.studioId;
    user.studioRole = invitation.role;
    invitation.status = 'aceptada';
    invitation.resolvedAt = Date.now();
    logAudit(db, { actorId: req.user.id, action: 'studio_invitation_accepted', channelCode: null, meta: { studioId: invitation.studioId, role: invitation.role } });
    await commit();
    const studio = db.studios.find((s) => s.id === invitation.studioId);
    res.json(serializeStudio(studio));
  });

  router.post('/invitations/:token/reject', requireAuth, async (req, res) => {
    const db = getDB();
    const invitation = db.studioInvitations.find((i) => i.token === req.params.token);
    if (!invitation) return res.status(404).json({ error: 'Invitación inválida o vencida' });
    if (invitation.status !== 'pendiente') return res.status(400).json({ error: 'Esta invitación ya fue resuelta' });
    if ((req.user.email || '').toLowerCase() !== invitation.email) {
      return res.status(403).json({ error: 'Esta invitación es para otra cuenta de Google' });
    }
    invitation.status = 'rechazada';
    invitation.resolvedAt = Date.now();
    await commit();
    res.json({ ok: true });
  });

  // ---------- administrar miembros ----------
  router.patch('/members/:userId/role', requireAuth, requireStudioAdmin, async (req, res) => {
    const { role } = req.body || {};
    if (!['admin', 'mediador', 'asistente'].includes(role)) {
      return res.status(400).json({ error: "Rol inválido — usar 'admin', 'mediador' o 'asistente'" });
    }
    const db = getDB();
    const target = db.users.find((u) => u.id === req.params.userId && u.studioId === req.user.studioId);
    if (!target) return res.status(404).json({ error: 'Esa persona no pertenece a tu estudio' });
    const studio = db.studios.find((s) => s.id === req.user.studioId);
    if (target.id === studio.ownerId && role !== 'admin') {
      return res.status(400).json({ error: 'El propietario del estudio no puede dejar de ser admin' });
    }
    // "un usuario no puede cambiarse el rol a sí mismo" — ni siquiera un
    // admin, para que un admin no pueda auto-degradarse por error sin que
    // otro admin lo note, y sobre todo para que nadie pueda auto-ascenderse
    // silenciosamente si en algún momento este endpoint se llama con otro rol de sesión.
    if (target.id === req.user.id) {
      return res.status(400).json({ error: 'No podés cambiar tu propio rol' });
    }
    const fromRole = target.studioRole;
    target.studioRole = role;
    logAudit(db, { actorId: req.user.id, action: 'studio_role_changed', channelCode: null, meta: { studioId: req.user.studioId, targetUserId: target.id, fromRole, toRole: role } });
    await commit();
    res.json(serializeMember(target));
  });

  router.delete('/members/:userId', requireAuth, requireStudioAdmin, async (req, res) => {
    const db = getDB();
    const target = db.users.find((u) => u.id === req.params.userId && u.studioId === req.user.studioId);
    if (!target) return res.status(404).json({ error: 'Esa persona no pertenece a tu estudio' });
    const studio = db.studios.find((s) => s.id === req.user.studioId);
    if (target.id === studio.ownerId) return res.status(400).json({ error: 'No se puede quitar al propietario del estudio' });
    target.studioId = null;
    target.studioRole = null;
    logAudit(db, { actorId: req.user.id, action: 'studio_member_removed', channelCode: null, meta: { studioId: req.user.studioId, targetUserId: target.id } });
    await commit();
    res.json({ ok: true });
  });

  // ---------- abandonar el estudio (voluntario) ----------
  // Bloque 14 (Parte 2). El propietario nunca puede abandonar por acá —
  // "transferencia de propiedad" es a propósito algo que NO existe
  // todavía (pedido explícito: no construirla sin una estructura segura).
  // Mediador/asistente sí pueden, salvo que dejen mediaciones activas sin
  // nadie del estudio a cargo — ahí se bloquea y se informa cuáles.
  router.post('/leave', requireAuth, async (req, res) => {
    const db = getDB();
    if (!req.user.studioId) return res.status(400).json({ error: 'No pertenecés a ningún estudio' });
    const studio = db.studios.find((s) => s.id === req.user.studioId);
    if (studio && studio.ownerId === req.user.id) {
      return res.status(400).json({ error: 'Sos el propietario del estudio — no podés abandonarlo. Por ahora hay que transferir la propiedad o dar de baja el estudio, ninguna de las dos cosas está implementada todavía.' });
    }
    // mediaciones propias, ABIERTAS, que quedarían sin nadie del estudio a
    // cargo si se va — las cerradas no bloquean, ya no necesitan gestión activa.
    const orphanRisk = db.mediations.filter((m) => m.mediatorUserId === req.user.id && !m.closedAt);
    if (orphanRisk.length > 0) {
      return res.status(409).json({
        error: 'Tenés mediaciones activas a tu nombre — hay que reasignarlas antes de poder abandonar el estudio.',
        mediations: orphanRisk.map((m) => ({ id: m.id, code: m.code, object: m.object })),
      });
    }

    const studioId = req.user.studioId;
    const user = db.users.find((u) => u.id === req.user.id);
    user.studioId = null;
    user.studioRole = null;
    // revoca todo el acceso puntual que tuviera dentro de ESTE estudio —
    // no tiene sentido que le sigan apareciendo mediaciones asignadas de
    // un equipo del que ya no forma parte.
    const revoked = db.mediationAccess.filter((a) => a.userId === req.user.id);
    db.mediationAccess = db.mediationAccess.filter((a) => a.userId !== req.user.id);
    logAudit(db, { actorId: req.user.id, action: 'studio_member_left', channelCode: null, meta: { studioId, revokedAccessCount: revoked.length } });
    await commit();
    res.json({ ok: true, revokedAccessCount: revoked.length });
  });

  // ---------- transferir propiedad (Bloque 14, Parte 3) ----------
  // Solo el owner ACTUAL puede iniciarla — ni siquiera otro admin. Todas
  // las mutaciones (los dos roles + ownerId) pasan en el mismo bloque
  // síncrono, antes del único await commit() — en Node, sin otro request
  // pudiendo intercalarse en medio de código síncrono, esto es
  // efectivamente atómico para este modelo de datos (no hay un mecanismo
  // de transacción SQL explícito en toda esta capa, así que esta es la
  // forma real de conseguir esa propiedad acá).
  router.post('/transfer-ownership', requireAuth, async (req, res) => {
    const { newOwnerId } = req.body || {};
    const db = getDB();
    if (!req.user.studioId) return res.status(400).json({ error: 'No pertenecés a ningún estudio' });
    const studio = db.studios.find((s) => s.id === req.user.studioId);
    if (!studio) return res.status(404).json({ error: 'Estudio no encontrado' });
    if (studio.ownerId !== req.user.id) return res.status(403).json({ error: 'Solo el propietario actual puede transferir la propiedad' });
    if (studio.status !== 'activo') return res.status(400).json({ error: 'El estudio está dado de baja' });

    const newOwner = db.users.find((u) => u.id === newOwnerId);
    if (!newOwner) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (newOwner.studioId !== studio.id) return res.status(400).json({ error: 'Esa persona no es miembro activo de este estudio' });
    if (newOwner.id === req.user.id) return res.status(400).json({ error: 'Ya sos el propietario' });

    const previousOwnerId = studio.ownerId;
    // decisión de diseño, documentada en el informe: el propietario
    // anterior NO se degrada — se queda como admin (el rol más cercano
    // que ya existe en el modelo), para no dejarlo sin capacidad
    // administrativa por el solo hecho de haber cedido la propiedad.
    studio.ownerId = newOwner.id;
    newOwner.studioRole = 'admin';
    const previousOwnerUser = db.users.find((u) => u.id === previousOwnerId);
    if (previousOwnerUser) previousOwnerUser.studioRole = 'admin';

    // a propósito, NADA de esto se toca: mediatorUserId de ninguna
    // mediación, ni ninguna fila de mediation_access — transferir la
    // propiedad del estudio no es lo mismo que transferir mediaciones.
    logAudit(db, {
      actorId: req.user.id, action: 'studio_ownership_transferred', channelCode: null,
      meta: { studioId: studio.id, previousOwnerId, newOwnerId: newOwner.id },
    });
    await commit();
    res.json(serializeStudio(studio));
  });

  // ---------- dar de baja el estudio (Bloque 14, Parte 3) ----------
  // Baja lógica, nunca borrado físico — nada de esto toca usuarios,
  // mediaciones, documentos, timeline ni auditoría existentes.
  router.post('/deactivate', requireAuth, async (req, res) => {
    const db = getDB();
    if (!req.user.studioId) return res.status(400).json({ error: 'No pertenecés a ningún estudio' });
    const studio = db.studios.find((s) => s.id === req.user.studioId);
    if (!studio) return res.status(404).json({ error: 'Estudio no encontrado' });
    if (studio.ownerId !== req.user.id) return res.status(403).json({ error: 'Solo el propietario puede dar de baja el estudio' });
    if (studio.status !== 'activo') return res.status(400).json({ error: 'El estudio ya está dado de baja' });

    // mismo criterio que en /leave: lo que bloquea son las mediaciones
    // ABIERTAS de cualquier integrante del estudio — las cerradas se
    // conservan sin problema, no necesitan seguir gestionándose.
    const studioUserIds = new Set(db.users.filter((u) => u.studioId === studio.id).map((u) => u.id));
    const activeMediations = db.mediations.filter((m) => studioUserIds.has(m.mediatorUserId) && !m.closedAt);
    if (activeMediations.length > 0) {
      return res.status(409).json({
        error: 'Hay mediaciones activas en el estudio — hay que cerrarlas o reasignarlas antes de dar de baja el estudio.',
        mediations: activeMediations.map((m) => ({ id: m.id, code: m.code, object: m.object, mediatorUserId: m.mediatorUserId })),
      });
    }

    studio.status = 'inactivo';
    logAudit(db, { actorId: req.user.id, action: 'studio_deactivated', channelCode: null, meta: { studioId: studio.id } });
    await commit();
    res.json(serializeStudio(studio));
  });

  return router;
};
