// routes/admin.js
// Panel de administración: sin rol nuevo en la base de datos — el acceso se
// decide por una lista de emails en ADMIN_EMAILS (.env). "Mediadores" acá es
// la moderación automática por IA (no hay mediadores humanos en el producto
// todavía), así que las métricas reflejan eso: cuánto interviene la IA y qué
// pasa con esas intervenciones.
const express = require('express');
const { getDB } = require('../db');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isAdminUser(user) {
  return !!user && !!user.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
}

module.exports = function () {
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

    res.json({
      totalUsers: db.users.length,
      guestUsers: db.users.filter((u) => u.guest).length,
      totalChannels: db.channels.length,
      activeChannels,
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

  return router;
};
