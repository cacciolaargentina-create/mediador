// routes/admin.js
// Panel de administración de la plataforma: el acceso se decide por una
// lista de emails en ADMIN_EMAILS (.env), no por un campo de rol en la
// base — así el primer admin no depende de que otro admin ya exista.
//
// Dos cosas distintas conviven acá: la moderación automática por IA (cuánto
// interviene y qué pasa con esas intervenciones), y los mediadores/estudios
// jurídicos humanos que las partes ya pueden invitar a su canal desde
// routes/channels.js (acceso de solo lectura, sin poder escribir en nombre
// de las partes). Este panel suma la vista "de plataforma" sobre eso
// segundo: cuántos hay, en qué canales, y una vía para que un admin los
// asigne directamente a un canal sin depender de que las partes lo inviten.
const express = require('express');
const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');
const { serializeMessage } = require('../serializers');
const { isAdminUser, PROFESSIONAL_ROLE_LABELS } = require('../roles');
const { logAudit } = require('../audit');
const wa = require('../whatsapp');
const { getPendingNotificationsCount } = require('../messaging');
const waRoutes = require('./whatsapp');
const { FREE_TIER_MONTHLY_LIMIT, currentMonth } = require('../quota');

// costo aproximado por llamada a la API de Anthropic para el modelo de
// moderación — mismo número ya usado antes en esta conversación. Es una
// estimación (el pricing real depende de tokens de entrada/salida), no una
// cifra facturada; ajustar acá si cambia el pricing del modelo.
const ANTHROPIC_COST_PER_CALL = 0.0016;

const WHATSAPP_EVENT_LABELS = {
  notification_sent: 'Notificación enviada',
  notification_failed: 'Notificación falló',
  onboarding_create: 'Creó canal (CREAR)',
  onboarding_join: 'Se unió a canal (UNIRSE)',
  onboarding_error: 'Onboarding con error',
  inbound_processed: 'Mensaje procesado',
  webhook_invalid_signature: 'Firma de webhook inválida',
};

module.exports = function (io) {
  const router = express.Router();

  function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (!isAdminUser(req.user)) return res.status(403).json({ error: 'No tenés acceso a esta sección' });
    next();
  }

  // usado por el frontend para mostrar/ocultar el link "Admin" sin exponer la lista completa
  router.get('/am-i-admin', (req, res) => {
    res.json({ isAdmin: isAdminUser(req.user) });
  });

  router.get('/overview', requireAdmin, (req, res) => {
    const db = getDB();
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const activeChannels = db.channels.filter(
      (c) => db.members.filter((m) => m.channelId === c.id).length >= 2
    ).length;

    const realMessages = db.messages.filter((m) => m.senderId); // excluye texto del sistema
    const flagged = realMessages.filter((m) => m.flagged);
    const overrode = flagged.filter((m) => m.reason === 'Enviado sin cambios pese a la señal del sistema.');

    const events = db.events;
    const byStatus = (status) => events.filter((e) => e.status === status).length;

    const proMembers = db.members.filter((m) => m.role === 'mediador' || m.role === 'estudio');
    const proUserIds = new Set(proMembers.map((m) => m.userId));
    const channelsWithProfessional = new Set(proMembers.map((m) => m.channelId)).size;

    res.json({
      totalUsers: db.users.length,
      guestUsers: db.users.filter((u) => u.guest).length,
      totalChannels: db.channels.length,
      activeChannels,
      professionals: {
        mediadores: new Set(proMembers.filter((m) => m.role === 'mediador').map((m) => m.userId)).size,
        estudios: new Set(proMembers.filter((m) => m.role === 'estudio').map((m) => m.userId)).size,
        totalProfessionals: proUserIds.size,
        channelsWithProfessional,
      },
      totalMessages: db.messages.length,
      messagesLast7d: db.messages.filter((m) => m.createdAt >= weekAgo).length,
      moderation: {
        flaggedCount: flagged.length,
        usedReformulation: flagged.length - overrode.length,
        overrode: overrode.length,
        patternAlerts: db.messages.filter((m) => m.pattern).length,
      },
      events: { confirmado: byStatus('confirmado'), pendiente: byStatus('pendiente'), rechazado: byStatus('rechazado') },
    });
  });

  // últimas 8 semanas: mensajes, cuántos marcó la IA y cuántos acuerdos se
  // confirmaron — la pregunta que más importa es si el conflicto baja con el tiempo.
  router.get('/trend', requireAdmin, (req, res) => {
    const db = getDB();
    const WEEKS = 8;
    const now = new Date();
    const dayOfWeek = (now.getUTCDay() + 6) % 7; // 0 = lunes
    const thisMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOfWeek));

    const buckets = [];
    for (let i = WEEKS - 1; i >= 0; i--) {
      const start = new Date(thisMonday);
      start.setUTCDate(start.getUTCDate() - i * 7);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 7);
      buckets.push({ start: start.getTime(), end: end.getTime(), label: start.toISOString().slice(5, 10) });
    }

    const realMessages = db.messages.filter((m) => m.senderId);
    const data = buckets.map((b) => {
      const inWeek = realMessages.filter((m) => m.createdAt >= b.start && m.createdAt < b.end);
      const confirmedInWeek = db.events.filter(
        (e) => e.status === 'confirmado' && e.respondedAt && e.respondedAt >= b.start && e.respondedAt < b.end
      ).length;
      return {
        week: b.label,
        messages: inWeek.length,
        flagged: inWeek.filter((m) => m.flagged).length,
        eventsConfirmed: confirmedInWeek,
      };
    });

    res.json(data);
  });

  router.get('/users', requireAdmin, (req, res) => {
    const db = getDB();
    const list = db.users
      .map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email || null,
        avatar: u.avatar || null,
        guest: !!u.guest,
        createdAt: u.createdAt,
        channelCount: db.members.filter((m) => m.userId === u.id).length,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json(list);
  });

  router.get('/channels', requireAdmin, (req, res) => {
    const db = getDB();
    const list = db.channels
      .map((c) => {
        const members = db.members
          .filter((m) => m.channelId === c.id)
          .map((m) => ({ role: m.role, name: (db.users.find((u) => u.id === m.userId) || {}).name || '—' }));
        const msgs = db.messages.filter((m) => m.channelId === c.id);
        const evs = db.events.filter((e) => e.channelId === c.id);
        const lastActivity = msgs.reduce((max, m) => Math.max(max, m.createdAt), c.createdAt);
        return {
          code: c.code,
          createdAt: c.createdAt,
          members,
          messageCount: msgs.length,
          flaggedCount: msgs.filter((m) => m.flagged).length,
          events: {
            confirmado: evs.filter((e) => e.status === 'confirmado').length,
            pendiente: evs.filter((e) => e.status === 'pendiente').length,
            rechazado: evs.filter((e) => e.status === 'rechazado').length,
          },
          lastActivity,
        };
      })
      .sort((a, b) => b.lastActivity - a.lastActivity);
    res.json(list);
  });

  // ---------- mediadores/as y estudios jurídicos (vista de plataforma) ----------
  // Las partes ya pueden invitar a su propio profesional desde el canal
  // (routes/channels.js); esto agrega la vista agregada "todos los
  // profesionales del sistema" y una asignación directa por si el admin de
  // la plataforma necesita sumar uno sin depender de que las partes lo hagan.
  router.get('/professionals', requireAdmin, (req, res) => {
    const db = getDB();
    const proMembers = db.members.filter((m) => m.role === 'mediador' || m.role === 'estudio');
    const byUser = new Map();
    for (const m of proMembers) {
      const user = db.users.find((u) => u.id === m.userId);
      if (!user) continue;
      if (!byUser.has(user.id)) {
        byUser.set(user.id, { id: user.id, name: user.name, email: user.email || null, channels: [] });
      }
      const channel = db.channels.find((c) => c.id === m.channelId);
      byUser.get(user.id).channels.push({
        code: channel ? channel.code : '—',
        role: m.role,
        roleLabel: PROFESSIONAL_ROLE_LABELS[m.role] || m.role,
        label: m.label || null,
        joinedAt: m.joinedAt,
      });
    }
    res.json([...byUser.values()].sort((a, b) => b.channels.length - a.channels.length));
  });

  // Asigna un usuario YA REGISTRADO (por email, tiene que haber entrado alguna
  // vez con Google) como mediador/a o estudio jurídico de un canal. Mismo
  // efecto que la invitación que hacen las partes desde el chat — mismo
  // aviso en el canal, misma transparencia — solo que la dispara un admin.
  router.post('/channels/:code/assign-professional', requireAdmin, async (req, res) => {
    const { email, role, label } = req.body;
    if (!PROFESSIONAL_ROLE_LABELS[role]) return res.status(400).json({ error: 'Rol inválido' });
    if (!label || !label.trim()) return res.status(400).json({ error: 'Falta el nombre del mediador/a o del estudio' });
    if (!email || !email.trim()) return res.status(400).json({ error: 'Falta el email del usuario a asignar' });

    const db = getDB();
    const channel = db.channels.find((c) => c.code === req.params.code.toUpperCase());
    if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });

    const user = db.users.find((u) => (u.email || '').toLowerCase() === email.trim().toLowerCase());
    if (!user) {
      return res.status(404).json({ error: 'No hay ningún usuario registrado con ese email — tiene que haber iniciado sesión con Google al menos una vez antes de poder asignarlo.' });
    }

    const existing = db.members.find((m) => m.channelId === channel.id && m.userId === user.id);
    if (existing) return res.status(409).json({ error: 'Ese usuario ya es parte de este canal' });

    db.members.push({
      id: nanoid(), channelId: channel.id, userId: user.id,
      role, label: label.trim(), joinedAt: Date.now(), assignedByAdmin: true,
    });
    const sysMsg = {
      id: nanoid(), channelId: channel.id, senderId: null,
      text: `${user.name} se sumó al canal como ${PROFESSIONAL_ROLE_LABELS[role]} (${label.trim()}), asignado por un administrador.`,
      flagged: false, reason: null, pattern: false, createdAt: Date.now(),
    };
    db.messages.push(sysMsg);
    logAudit(db, { actorId: req.user.id, action: 'assign_professional', channelCode: channel.code, meta: { role, targetEmail: user.email } });
    await commit();

    if (io) {
      io.to(channel.code).emit('message:new', serializeMessage(sysMsg));
      io.to(channel.code).emit('channel:update', { code: channel.code });
    }
    res.json({ ok: true });
  });

  // Quita a un mediador/a o estudio jurídico de un canal — nunca a una parte
  // A/B (esas no se "desasignan" desde acá). Igual que al asignar, queda
  // avisado en el chat para que no sea un cambio silencioso.
  router.delete('/channels/:code/professionals/:userId', requireAdmin, async (req, res) => {
    const db = getDB();
    const channel = db.channels.find((c) => c.code === req.params.code.toUpperCase());
    if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });

    const membership = db.members.find((m) => m.channelId === channel.id && m.userId === req.params.userId);
    if (!membership) return res.status(404).json({ error: 'Ese usuario no es parte de este canal' });
    if (membership.role !== 'mediador' && membership.role !== 'estudio') {
      return res.status(400).json({ error: 'Este endpoint solo quita mediadores/as o estudios jurídicos, no a las partes A/B' });
    }

    const user = db.users.find((u) => u.id === req.params.userId);
    const roleLabel = PROFESSIONAL_ROLE_LABELS[membership.role] || membership.role;
    db.members = db.members.filter((m) => m.id !== membership.id);

    const sysMsg = {
      id: nanoid(), channelId: channel.id, senderId: null,
      text: `${user ? user.name : 'Un usuario'} (${roleLabel}) fue quitado del canal por un administrador.`,
      flagged: false, reason: null, pattern: false, createdAt: Date.now(),
    };
    db.messages.push(sysMsg);
    logAudit(db, { actorId: req.user.id, action: 'unassign_professional', channelCode: channel.code, meta: { role: membership.role, targetEmail: user ? user.email : null } });
    await commit();

    if (io) {
      io.to(channel.code).emit('message:new', serializeMessage(sysMsg));
      io.to(channel.code).emit('channel:update', { code: channel.code });
    }
    res.json({ ok: true });
  });

  // ---------- solicitudes de autoregistro de profesionales ----------
  // Distinto del alta que hace una parte desde su canal (routes/channels.js):
  // acá el profesional llega solo, sin ningún caso todavía, vía el
  // formulario público, y queda "pendiente" hasta que un admin lo revisa.
  router.get('/professional-applications', requireAdmin, (req, res) => {
    const db = getDB();
    const status = req.query.status; // opcional: filtra por estado, default todas
    const list = db.professionalApplications
      .filter((a) => !status || a.status === status)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((a) => {
        const user = db.users.find((u) => u.id === a.userId);
        return {
          id: a.id,
          userId: a.userId,
          userName: user ? user.name : 'Desconocido',
          userEmail: user ? user.email : null,
          role: a.role,
          roleLabel: PROFESSIONAL_ROLE_LABELS[a.role] || a.role,
          orgName: a.orgName,
          status: a.status,
          createdAt: a.createdAt,
          decidedAt: a.decidedAt || null,
        };
      });
    res.json(list);
  });

  router.post('/professional-applications/:id/approve', requireAdmin, async (req, res) => {
    const db = getDB();
    const application = db.professionalApplications.find((a) => a.id === req.params.id);
    if (!application) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (application.status !== 'pending') return res.status(409).json({ error: 'Esta solicitud ya fue resuelta' });

    const user = db.users.find((u) => u.id === application.userId);
    if (!user) return res.status(404).json({ error: 'El usuario que hizo la solicitud ya no existe' });

    application.status = 'approved';
    application.decidedAt = Date.now();
    application.decidedBy = req.user.id;
    user.verifiedProfessional = true;
    user.verifiedProfessionalRole = application.role;
    user.verifiedProfessionalOrg = application.orgName;

    logAudit(db, {
      actorId: req.user.id, action: 'approve_professional_application',
      meta: { targetEmail: user.email, role: application.role, orgName: application.orgName },
    });
    await commit();
    res.json({ ok: true });
  });

  router.post('/professional-applications/:id/reject', requireAdmin, async (req, res) => {
    const db = getDB();
    const application = db.professionalApplications.find((a) => a.id === req.params.id);
    if (!application) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (application.status !== 'pending') return res.status(409).json({ error: 'Esta solicitud ya fue resuelta' });

    application.status = 'rejected';
    application.decidedAt = Date.now();
    application.decidedBy = req.user.id;

    const user = db.users.find((u) => u.id === application.userId);
    logAudit(db, {
      actorId: req.user.id, action: 'reject_professional_application',
      meta: { targetEmail: user ? user.email : null, role: application.role, orgName: application.orgName },
    });
    await commit();
    res.json({ ok: true });
  });

  // ---------- log de auditoría ----------
  // Acciones sensibles, no un duplicado del chat: exports de informes,
  // asignación/remoción de profesionales. Las últimas primero.
  router.get('/audit', requireAdmin, (req, res) => {
    const db = getDB();
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const list = [...db.auditLog]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((a) => {
        const actor = db.users.find((u) => u.id === a.actorId);
        return {
          id: a.id,
          actorName: actor ? actor.name : 'Desconocido',
          actorEmail: actor ? actor.email : null,
          action: a.action,
          channelCode: a.channelCode,
          meta: a.meta,
          createdAt: a.createdAt,
        };
      });
    res.json(list);
  });

  // ---------- panel de WhatsApp ----------
  router.get('/whatsapp/status', requireAdmin, (req, res) => {
    const db = getDB();
    res.json({
      configured: wa.configured(),
      webhookConfigured: !!(process.env.WHATSAPP_VERIFY_TOKEN && process.env.WHATSAPP_APP_SECRET),
      usersWithPhone: db.users.filter((u) => u.phone).length,
      pendingNotifications: getPendingNotificationsCount(),
      pendingConfirmations: waRoutes.getPendingConfirmationsCount(),
    });
  });

  router.get('/whatsapp/log', requireAdmin, (req, res) => {
    const db = getDB();
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const list = [...db.whatsappLog]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((e) => ({ ...e, kindLabel: WHATSAPP_EVENT_LABELS[e.kind] || e.kind }));
    res.json(list);
  });

  router.get('/whatsapp/users', requireAdmin, (req, res) => {
    const db = getDB();
    const list = db.users
      .filter((u) => u.phone)
      .map((u) => ({
        id: u.id, name: u.name, phone: u.phone, createdAt: u.createdAt,
        channels: db.members
          .filter((m) => m.userId === u.id)
          .map((m) => (db.channels.find((c) => c.id === m.channelId) || {}).code)
          .filter(Boolean),
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json(list);
  });

  // payloads crudos del webhook — solo debug técnico, se muestra recortado
  router.get('/whatsapp/webhook-log', requireAdmin, (req, res) => {
    const db = getDB();
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const list = [...db.whatsappWebhookRaw]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    res.json(list);
  });

  // ---------- Costos y Salud ----------
  // Todo acá sale de contadores/logs que YA existen (moderationStats,
  // whatsappLog) — nada de esto asume un sistema de pagos conectado.
  function dateCutoff(daysAgo) {
    return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  }
  function sumModeration(db, sinceDate, onlyChannelCode) {
    return db.moderationStats
      .filter((r) => r.date >= sinceDate && (onlyChannelCode === undefined || r.channelCode === onlyChannelCode))
      .reduce((acc, r) => {
        acc.success += r.successCount; acc.fail += r.failCount; acc.flagged += r.flaggedCount;
        return acc;
      }, { success: 0, fail: 0, flagged: 0 });
  }
  function moderationCostPeriod(db, sinceDate) {
    const m = sumModeration(db, sinceDate);
    const calls = m.success + m.fail;
    return { calls, estimatedCost: Math.round(calls * ANTHROPIC_COST_PER_CALL * 100) / 100 };
  }
  function whatsappSentPeriod(db, sinceMs) {
    return db.whatsappLog.filter((e) => e.kind === 'notification_sent' && e.createdAt >= sinceMs).length;
  }
  // canales cuyo volumen de /analyze en los últimos 7 días se dispara muy
  // por encima del resto — protección extra, más allá del rate limiting,
  // contra un uso anormal que ya haya pasado los límites por request.
  function abnormalChannels(db) {
    const cutoff = dateCutoff(7);
    const byChannel = {};
    db.moderationStats
      .filter((r) => r.date >= cutoff && r.channelCode)
      .forEach((r) => { byChannel[r.channelCode] = (byChannel[r.channelCode] || 0) + r.successCount + r.failCount; });
    const entries = Object.entries(byChannel);
    if (!entries.length) return [];
    const avg = entries.reduce((s, [, c]) => s + c, 0) / entries.length;
    const threshold = Math.max(10, avg * 3);
    return entries
      .filter(([, c]) => c > threshold)
      .map(([code, c]) => ({ code, count: c, avgOtherChannels: Math.round(avg * 10) / 10 }))
      .sort((a, b) => b.count - a.count);
  }

  router.get('/costs', requireAdmin, (req, res) => {
    const db = getDB();
    const now = Date.now();
    const day = 86400000;

    const m30 = sumModeration(db, dateCutoff(30));
    const m30Total = m30.success + m30.fail;

    const lastWaActivity = db.whatsappLog.length
      ? Math.max(...db.whatsappLog.map((e) => e.createdAt))
      : null;
    const lastWebhookRaw = db.whatsappWebhookRaw.length
      ? Math.max(...db.whatsappWebhookRaw.map((e) => e.createdAt))
      : null;

    res.json({
      anthropic: {
        configured: !!process.env.ANTHROPIC_API_KEY,
        today: moderationCostPeriod(db, dateCutoff(0)),
        last7d: moderationCostPeriod(db, dateCutoff(7)),
        last30d: moderationCostPeriod(db, dateCutoff(30)),
        costPerCall: ANTHROPIC_COST_PER_CALL,
        errorRate: {
          successCount: m30.success, failCount: m30.fail,
          failPct: m30Total ? Math.round((m30.fail / m30Total) * 1000) / 10 : 0,
        },
      },
      whatsapp: {
        configured: wa.configured(),
        // conteo real; sin monto en $ porque no hay un precio por mensaje
        // confirmado todavía (Meta cambia el pricing en octubre) — mejor
        // no estimar un costo que podría estar mal.
        today: whatsappSentPeriod(db, now - (now % day)), // arranque del día UTC actual
        last7d: whatsappSentPeriod(db, now - 7 * day),
        last30d: whatsappSentPeriod(db, now - 30 * day),
        lastActivityAt: lastWaActivity,
      },
      mercadoPago: { configured: false }, // sin integración de pagos todavía
      webhookHealth: {
        whatsappLastActivityAt: lastWaActivity,
        whatsappLastRawPayloadAt: lastWebhookRaw,
        mercadoPagoLastActivityAt: null, // N/A — no hay webhook de MP configurado
      },
      abnormalChannels: abnormalChannels(db),
    });
  });

  // ---------- Suscripciones ----------
  // Sección honesta: no hay sistema de cobro real conectado (sin Mercado
  // Pago ni otro proveedor) — se completa el día que eso exista. Lo único
  // real que se puede mostrar hoy es quién llegó al límite del free tier,
  // como señal de a quién le convendría un plan pago si existiera.
  router.get('/subscriptions', requireAdmin, (req, res) => {
    const db = getDB();
    const month = currentMonth();
    const usersWithUsage = db.users.filter((u) => u.aiUsage && u.aiUsage.month === month);
    const usersAtLimit = usersWithUsage
      .filter((u) => u.aiUsage.count >= FREE_TIER_MONTHLY_LIMIT)
      .map((u) => ({ id: u.id, name: u.name, email: u.email || null, count: u.aiUsage.count }))
      .sort((a, b) => b.count - a.count);
    res.json({
      configured: false,
      freeTierLimit: FREE_TIER_MONTHLY_LIMIT,
      usersWithUsageThisMonth: usersWithUsage.length,
      usersAtLimit,
    });
  });

  // ---------- Soporte ----------
  // Vista consolidada por email o teléfono + un puñado de acciones sobre un
  // usuario/canal puntual. Cada acción con efecto queda en el log de
  // auditoría, mismo criterio que exportar informes o asignar profesionales.
  router.get('/support/search', requireAdmin, (req, res) => {
    const db = getDB();
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);
    const month = currentMonth();
    const matches = db.users
      .filter((u) => (u.email && u.email.toLowerCase().includes(q)) || (u.phone && u.phone.toLowerCase().includes(q)))
      .slice(0, 20);
    const results = matches.map((u) => {
      const channels = db.members
        .filter((m) => m.userId === u.id)
        .map((m) => {
          const channel = db.channels.find((c) => c.id === m.channelId);
          if (!channel) return null;
          const otherNames = db.members
            .filter((x) => x.channelId === channel.id && x.userId !== u.id)
            .map((x) => (db.users.find((uu) => uu.id === x.userId) || {}).name)
            .filter(Boolean);
          return {
            code: channel.code,
            role: m.role,
            roleLabel: m.role === 'A' ? 'Parte A' : m.role === 'B' ? 'Parte B' : (PROFESSIONAL_ROLE_LABELS[m.role] || m.role),
            otherNames,
          };
        })
        .filter(Boolean);
      const usage = (u.aiUsage && u.aiUsage.month === month) ? u.aiUsage.count : 0;
      return {
        id: u.id, name: u.name, email: u.email || null, phone: u.phone || null, guest: !!u.guest,
        verifiedProfessional: !!u.verifiedProfessional,
        channels,
        usageThisMonth: usage,
        freeTierLimit: FREE_TIER_MONTHLY_LIMIT,
        subscriptionAvailable: false, // sin sistema de pagos conectado — no hay estado real que mostrar
      };
    });
    res.json(results);
  });

  router.post('/support/users/:id/adjust-usage', requireAdmin, async (req, res) => {
    const db = getDB();
    const user = db.users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const count = Number(req.body.count);
    if (!Number.isFinite(count) || count < 0) return res.status(400).json({ error: 'Cantidad inválida' });

    const month = currentMonth();
    const previous = (user.aiUsage && user.aiUsage.month === month) ? user.aiUsage.count : 0;
    user.aiUsage = { month, count };
    logAudit(db, { actorId: req.user.id, action: 'adjust_usage', meta: { targetEmail: user.email || null, from: previous, to: count } });
    await commit();
    res.json({ ok: true, count });
  });

  // solo muestra/registra el link ya existente para copiarlo — no manda
  // ningún mensaje desde acá.
  router.get('/support/channels/:code/invite-link', requireAdmin, async (req, res) => {
    const db = getDB();
    const channel = db.channels.find((c) => c.code === req.params.code.toUpperCase());
    if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
    const url = `${req.protocol}://${req.get('host')}/?channel=${channel.code}`;
    const guestUrl = channel.guestToken ? `${req.protocol}://${req.get('host')}/?guest=${channel.guestToken}` : null;
    logAudit(db, { actorId: req.user.id, action: 'view_invite_link', channelCode: channel.code });
    await commit();
    res.json({ url, guestUrl });
  });

  return router;
};
