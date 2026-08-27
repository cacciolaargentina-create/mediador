// routes/channels.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const { nanoid, customAlphabet } = require('nanoid');
const { getDB, commit } = require('../db');
const { analyzeMessage } = require('../moderation');
const { askAssistant } = require('../assistant');
const { publicUser, serializeChannel, serializeMessage, serializeEvent } = require('../serializers');
const { buildCalendarFeed } = require('../ics');
const { postMessage } = require('../messaging');

const genCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const PATTERN_THRESHOLD = 3;

const REPEAT_LABELS = { weekly: 'semanal', biweekly: 'quincenal', monthly: 'mensual' };
const PROFESSIONAL_ROLE_LABELS = { mediador: 'mediador/a', estudio: 'estudio jurídico' };
const MAX_SERIES_OCCURRENCES = 52; // tope de seguridad para no generar series infinitas por error

// calcula la ocurrencia n-ésima siempre a partir de la fecha ancla original
// (no de la anterior) para que una fecha mensual no vaya "corriéndose" mes a
// mes cuando el día no existe en algún mes corto (ej. 31 de enero -> 28 de
// febrero -> tiene que volver al 31 en marzo, no quedarse en 28+1mes=28/03).
function addOccurrence(startDateStr, repeat, n) {
  const [y, m, d] = startDateStr.split('-').map(Number);
  if (repeat === 'monthly') {
    const totalMonth = (m - 1) + n;
    const targetYear = y + Math.floor(totalMonth / 12);
    const targetMonth = ((totalMonth % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    return new Date(Date.UTC(targetYear, targetMonth, Math.min(d, lastDay))).toISOString().slice(0, 10);
  }
  const stepDays = repeat === 'weekly' ? 7 : 14; // biweekly
  return new Date(Date.UTC(y, m - 1, d + n * stepDays)).toISOString().slice(0, 10);
}

// /analyze pega contra la API de Anthropic (cuesta plata por llamada) y el
// envío de mensajes es el punto obvio para floodear el chat — limitamos los
// dos por IP, generoso para uso normal de a dos personas.
const analyzeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes de análisis — esperá unos minutos.' },
});
const messageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Estás enviando mensajes muy rápido — esperá un momento.' },
});
const assistantLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas preguntas al asistente — esperá unos minutos.' },
});

module.exports = function (io) {
  const router = express.Router();

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    next();
  }

  function getChannelByCode(code) {
    const db = getDB();
    return db.channels.find((c) => c.code === code.toUpperCase());
  }
  function memberOf(channelId, userId) {
    const db = getDB();
    return db.members.find((m) => m.channelId === channelId && m.userId === userId);
  }
  function requireMembership(req, res, next) {
    const channel = getChannelByCode(req.params.code);
    if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });
    const membership = memberOf(channel.id, req.user.id);
    if (!membership) return res.status(403).json({ error: 'No sos parte de este canal' });
    req.channel = channel;
    req.membership = membership;
    next();
  }
  // mediadores y estudios jurídicos tienen acceso de lectura al canal pero no
  // pueden escribir en nombre de las partes — esto separa esas dos acciones.
  function requireParty(req, res, next) {
    if (req.membership.role !== 'A' && req.membership.role !== 'B') {
      return res.status(403).json({ error: 'Esta acción es solo para las partes del canal, no para perfiles invitados como mediador/a o estudio jurídico' });
    }
    next();
  }

  // ---------- crear canal ----------
  router.post('/', requireAuth, async (req, res) => {
    const db = getDB();
    const channel = { id: nanoid(), code: genCode(), guestToken: nanoid(24), calendarToken: nanoid(24), createdAt: Date.now() };
    db.channels.push(channel);
    db.members.push({ id: nanoid(), channelId: channel.id, userId: req.user.id, role: 'A', joinedAt: Date.now() });
    db.messages.push({
      id: nanoid(), channelId: channel.id, senderId: null,
      text: `Canal creado por ${req.user.name}. Todo mensaje enviado queda registrado.`,
      flagged: false, reason: null, pattern: false, createdAt: Date.now(),
    });
    await commit();
    res.json(serializeChannel(channel));
  });

  // ---------- unirse a canal ----------
  router.post('/join', requireAuth, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Falta el código' });
    const channel = getChannelByCode(code);
    if (!channel) return res.status(404).json({ error: 'Canal no encontrado' });

    const db = getDB();
    const existing = memberOf(channel.id, req.user.id);
    if (existing) return res.json(serializeChannel(channel));

    const members = db.members.filter((m) => m.channelId === channel.id);
    const parties = members.filter((m) => m.role === 'A' || m.role === 'B');
    if (parties.length >= 2) return res.status(409).json({ error: 'Ese canal ya tiene dos participantes' });
    const role = parties.some((m) => m.role === 'A') ? 'B' : 'A';

    db.members.push({ id: nanoid(), channelId: channel.id, userId: req.user.id, role, joinedAt: Date.now() });
    db.messages.push({
      id: nanoid(), channelId: channel.id, senderId: null,
      text: `${req.user.name} se unió al canal.`, flagged: false, reason: null, pattern: false, createdAt: Date.now(),
    });
    await commit();
    const payload = serializeChannel(channel);
    io.to(channel.code).emit('channel:update', payload);
    res.json(payload);
  });

  // ---------- info del canal ----------
  router.get('/:code', requireAuth, requireMembership, (req, res) => {
    res.json(serializeChannel(req.channel));
  });

  // ---------- acceso de mediador/a o estudio jurídico ----------
  // Solo las partes pueden generar esta invitación. Quien la usa entra con su
  // propia cuenta de Google (no anónimo, para que quede identificado quién es)
  // y con acceso de solo lectura — no puede mandar mensajes ni resolver
  // acuerdos en nombre de las partes. Su ingreso siempre queda anunciado en el
  // chat y visible en la lista de integrantes del canal: nunca es un acceso oculto.
  router.post('/:code/professionals/invite', requireAuth, requireMembership, requireParty, async (req, res) => {
    const { role, label } = req.body;
    if (!PROFESSIONAL_ROLE_LABELS[role]) return res.status(400).json({ error: 'Rol inválido' });
    if (!label || !label.trim()) return res.status(400).json({ error: 'Falta el nombre del mediador/a o del estudio' });

    const db = getDB();
    const channel = db.channels.find((c) => c.id === req.channel.id);
    if (!channel.professionalInvites) channel.professionalInvites = [];
    const invite = { token: nanoid(24), role, label: label.trim(), createdBy: req.user.id, createdAt: Date.now() };
    channel.professionalInvites.push(invite);
    await commit();
    res.json({ url: `${req.protocol}://${req.get('host')}/?pro=${invite.token}` });
  });

  // pública (sin sesión) para poder mostrar de qué canal/rol se trata antes de pedir login
  router.get('/professional/:token', (req, res) => {
    const db = getDB();
    for (const channel of db.channels) {
      const invite = (channel.professionalInvites || []).find((i) => i.token === req.params.token);
      if (invite) {
        return res.json({ role: invite.role, label: invite.label, used: !!invite.usedAt });
      }
    }
    res.status(404).json({ error: 'Invitación no encontrada' });
  });

  router.post('/professional/:token/accept', requireAuth, async (req, res) => {
    const db = getDB();
    let found = null;
    for (const channel of db.channels) {
      const invite = (channel.professionalInvites || []).find((i) => i.token === req.params.token);
      if (invite) { found = { channel, invite }; break; }
    }
    if (!found) return res.status(404).json({ error: 'Invitación no encontrada' });
    const { channel, invite } = found;
    if (invite.usedAt) return res.status(409).json({ error: 'Esta invitación ya fue usada' });

    const existing = memberOf(channel.id, req.user.id);
    if (existing) return res.json(serializeChannel(channel)); // ya es miembro (ej. recarga de página)

    db.members.push({
      id: nanoid(), channelId: channel.id, userId: req.user.id,
      role: invite.role, label: invite.label, joinedAt: Date.now(),
    });
    invite.usedAt = Date.now();
    invite.usedBy = req.user.id;

    const sysMsg = {
      id: nanoid(), channelId: channel.id, senderId: null,
      text: `${req.user.name} se unió al canal como ${PROFESSIONAL_ROLE_LABELS[invite.role]} (${invite.label}).`,
      flagged: false, reason: null, pattern: false, createdAt: Date.now(),
    };
    db.messages.push(sysMsg);
    await commit();

    const payload = serializeChannel(channel);
    io.to(channel.code).emit('channel:update', payload);
    io.to(channel.code).emit('message:new', serializeMessage(sysMsg));
    res.json(payload);
  });

  // ---------- mensajes ----------
  router.get('/:code/messages', requireAuth, requireMembership, (req, res) => {
    const db = getDB();
    const msgs = db.messages
      .filter((m) => m.channelId === req.channel.id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(serializeMessage);
    res.json(msgs);
  });

  // analiza sin guardar — el frontend decide si usa la reformulación
  router.post('/:code/analyze', analyzeLimiter, requireAuth, requireMembership, async (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
    try {
      const result = await analyzeMessage(text);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: 'No se pudo analizar el mensaje', flagged: false });
    }
  });

  // guarda el mensaje final (original o reformulado, ya decidido por el usuario)
  // — lógica compartida con WhatsApp vía messaging.js: postMessage además
  // dispara la notificación agrupada hacia la otra parte cuando corresponde.
  router.post('/:code/messages', messageLimiter, requireAuth, requireMembership, requireParty, async (req, res) => {
    const { text, flagged, reason } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
    const out = await postMessage(io, req.channel, { senderId: req.user.id, text, flagged: !!flagged, reason: reason || null });
    res.json(out);
  });

  // ---------- calendario ----------
  router.get('/:code/events', requireAuth, requireMembership, (req, res) => {
    const db = getDB();
    const events = db.events
      .filter((e) => e.channelId === req.channel.id)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(serializeEvent);
    res.json(events);
  });

  router.post('/:code/events', requireAuth, requireMembership, requireParty, async (req, res) => {
    const { date, detail, repeat, until } = req.body;
    if (!date || !detail) return res.status(400).json({ error: 'Faltan datos' });
    const isRecurring = Object.keys(REPEAT_LABELS).includes(repeat) && !!until;
    if (isRecurring && until < date) {
      return res.status(400).json({ error: 'La fecha "hasta" tiene que ser posterior a la fecha inicial' });
    }

    const dates = [date];
    if (isRecurring) {
      for (let n = 1; dates.length < MAX_SERIES_OCCURRENCES; n++) {
        const next = addOccurrence(date, repeat, n);
        if (next > until) break;
        dates.push(next);
      }
    }
    const seriesId = dates.length > 1 ? nanoid() : null;

    const db = getDB();
    const createdEvents = dates.map((d) => ({
      id: nanoid(), channelId: req.channel.id, date: d, detail,
      requestedBy: req.user.id, status: 'pendiente', seriesId, createdAt: Date.now(),
    }));
    db.events.push(...createdEvents);

    const seriesNote = createdEvents.length > 1
      ? ` — serie ${REPEAT_LABELS[repeat]} de ${createdEvents.length} fechas`
      : '';
    const sysMsg = {
      id: nanoid(), channelId: req.channel.id, senderId: null,
      text: `${req.user.name} propuso: ${detail} (${date})${seriesNote}`,
      flagged: false, reason: null, pattern: false, eventId: createdEvents[0].id, createdAt: Date.now(),
    };
    db.messages.push(sysMsg);
    await commit();

    createdEvents.forEach((ev) => io.to(req.channel.code).emit('event:new', serializeEvent(ev)));
    io.to(req.channel.code).emit('message:new', serializeMessage(sysMsg));
    res.json(serializeEvent(createdEvents[0]));
  });

  router.post('/:code/events/series/:seriesId/respond', requireAuth, requireMembership, requireParty, async (req, res) => {
    const { decision } = req.body;
    if (!['confirmado', 'rechazado'].includes(decision)) {
      return res.status(400).json({ error: 'Decisión inválida' });
    }
    const db = getDB();
    const evs = db.events.filter(
      (e) => e.seriesId === req.params.seriesId && e.channelId === req.channel.id && e.status === 'pendiente'
    );
    if (!evs.length) return res.status(404).json({ error: 'No hay fechas pendientes en esta serie' });
    evs.forEach((e) => { e.status = decision; e.respondedAt = Date.now(); });
    const verb = decision === 'confirmado' ? 'confirmó' : 'rechazó';
    const sysMsg = {
      id: nanoid(), channelId: req.channel.id, senderId: null,
      text: `${req.user.name} ${verb} ${evs.length} fechas de una serie: ${evs[0].detail}`,
      flagged: false, reason: null, pattern: false, createdAt: Date.now(),
    };
    db.messages.push(sysMsg);
    await commit();
    evs.forEach((e) => io.to(req.channel.code).emit('event:update', serializeEvent(e)));
    io.to(req.channel.code).emit('message:new', serializeMessage(sysMsg));
    res.json({ updated: evs.length });
  });

  router.post('/:code/events/:id/respond', requireAuth, requireMembership, requireParty, async (req, res) => {
    const { decision } = req.body; // 'confirmado' | 'rechazado'
    if (!['confirmado', 'rechazado'].includes(decision)) {
      return res.status(400).json({ error: 'Decisión inválida' });
    }
    const db = getDB();
    const ev = db.events.find((e) => e.id === req.params.id && e.channelId === req.channel.id);
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
    ev.status = decision;
    ev.respondedAt = Date.now();
    const verb = decision === 'confirmado' ? 'confirmó' : 'rechazó';
    const sysMsg = {
      id: nanoid(), channelId: req.channel.id, senderId: null,
      text: `${req.user.name} ${verb} el pedido: ${ev.detail} (${ev.date})`,
      flagged: false, reason: null, pattern: false, createdAt: Date.now(),
    };
    db.messages.push(sysMsg);
    await commit();
    const out = serializeEvent(ev);
    io.to(req.channel.code).emit('event:update', out);
    io.to(req.channel.code).emit('message:new', serializeMessage(sysMsg));
    res.json(out);
  });

  // ---------- sincronizar con Google/Apple Calendar ----------
  // Devuelve la URL del feed .ics del canal, generando el token la primera
  // vez que se pide (canales creados antes de este feature no lo tienen).
  router.get('/:code/calendar-link', requireAuth, requireMembership, async (req, res) => {
    const db = getDB();
    const channel = db.channels.find((c) => c.id === req.channel.id);
    if (!channel.calendarToken) {
      channel.calendarToken = nanoid(24);
      await commit();
    }
    const base = `${req.protocol}://${req.get('host')}/api/channels/${channel.code}/calendar.ics?token=${channel.calendarToken}`;
    res.json({ icsUrl: base, webcalUrl: base.replace(/^https?:/, 'webcal:') });
  });

  // Feed .ics público (sin sesión — así lo pueden pollear Apple/Google Calendar),
  // protegido por el token en vez de por login. Solo expone eventos confirmados.
  router.get('/:code/calendar.ics', async (req, res) => {
    const channel = getChannelByCode(req.params.code);
    if (!channel || !channel.calendarToken || req.query.token !== channel.calendarToken) {
      return res.status(404).send('No encontrado');
    }
    const db = getDB();
    const events = db.events
      .filter((e) => e.channelId === channel.id && e.status === 'confirmado')
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(serializeEvent);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="puente-digital-${channel.code}.ics"`);
    res.send(buildCalendarFeed(channel.code, events));
  });

  // ---------- asistente (preguntas sobre el historial del canal) ----------
  router.post('/:code/assistant', assistantLimiter, requireAuth, requireMembership, async (req, res) => {
    const { question } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ error: 'Falta la pregunta' });

    const db = getDB();
    const msgs = db.messages
      .filter((m) => m.channelId === req.channel.id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-200); // suficiente historial reciente sin dejar crecer el contexto sin límite
    const events = db.events.filter((e) => e.channelId === req.channel.id).sort((a, b) => a.date.localeCompare(b.date));
    const nameOf = (id) => (db.users.find((u) => u.id === id) || {}).name || 'Desconocido';

    const msgLines = msgs
      .map((m) => {
        const who = m.senderId ? nameOf(m.senderId) : m.pattern ? 'ALERTA DE PATRÓN' : 'SISTEMA';
        const ts = new Date(m.createdAt).toISOString().slice(0, 16).replace('T', ' ');
        return `[${ts}] ${who}: ${m.text}`;
      })
      .join('\n');
    const evLines = events
      .map((e) => `${e.date} — ${e.detail} · pedido por ${nameOf(e.requestedBy)} · estado: ${e.status}`)
      .join('\n');

    try {
      const answer = await askAssistant(question.trim(), { msgLines, evLines });
      res.json({ answer });
    } catch (err) {
      console.error(err);
      res.status(502).json({ error: 'No se pudo consultar al asistente en este momento.' });
    }
  });

  // ---------- informe exportable ----------
  router.get('/:code/export', requireAuth, requireMembership, (req, res) => {
    const db = getDB();
    const msgs = db.messages.filter((m) => m.channelId === req.channel.id).sort((a, b) => a.createdAt - b.createdAt);
    const events = db.events.filter((e) => e.channelId === req.channel.id).sort((a, b) => a.date.localeCompare(b.date));

    const lines = [];
    lines.push('INFORME — PUENTE DIGITAL');
    lines.push(`Código de canal: ${req.channel.code}`);
    lines.push(`Generado: ${new Date().toLocaleString('es-AR')}`);
    lines.push('');
    lines.push('--- MENSAJES ---');
    msgs.forEach((m) => {
      const who = m.senderId ? (publicUser(m.senderId)?.name || m.senderId) : (m.pattern ? 'ALERTA DE PATRON' : 'SISTEMA');
      lines.push(`[${new Date(m.createdAt).toLocaleString('es-AR')}] ${who}: ${m.text}${m.flagged ? '  (marcado por IA)' : ''}`);
    });
    lines.push('');
    lines.push('--- CALENDARIO / ACUERDOS ---');
    events.forEach((e) => {
      const who = publicUser(e.requestedBy)?.name || e.requestedBy;
      lines.push(`${e.date} — ${e.detail} · pedido por ${who} · estado: ${e.status}`);
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="informe-${req.channel.code}.txt"`);
    res.send(lines.join('\n'));
  });

  return router;
};
