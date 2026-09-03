// routes/channels.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const { nanoid, customAlphabet } = require('nanoid');
const { getDB, commit } = require('../db');
const { analyzeMessage } = require('../moderation');
const { askAssistant } = require('../assistant');
const { publicUser, serializeChannel, serializeMessage, serializeEvent } = require('../serializers');
const { buildCalendarFeed } = require('../ics');
const { postMessage, postSystemMessage } = require('../messaging');
const { buildCertifiedReport, integrityHash, buildPlainContent } = require('../certificate');
const { signHash, getPublicKeyPem, publicKeyFingerprint, signingConfigured } = require('../signing');
const { isAdminUser, PROFESSIONAL_ROLE_LABELS } = require('../roles');
const { logAudit } = require('../audit');
const { requireQuotaOrSubscription } = require('../quota');
const { recordModerationCall } = require('../moderationStats');

const genCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const PATTERN_THRESHOLD = 3;

const REPEAT_LABELS = { weekly: 'semanal', biweekly: 'quincenal', monthly: 'mensual' };
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

module.exports = function (io, presence) {
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
  // notas privadas de caso: solo para mediador/a, estudio jurídico o un admin
  // de la plataforma — nunca para las partes A/B, que no deben ver
  // anotaciones profesionales sobre su propio conflicto.
  function requireProfessionalOrAdmin(req, res, next) {
    if (req.membership.role === 'mediador' || req.membership.role === 'estudio') return next();
    if (isAdminUser(req.user)) return next();
    return res.status(403).json({ error: 'Esta sección es solo para mediador/a, estudio jurídico o administración' });
  }

  // ---------- crear canal ----------
  router.post('/', requireAuth, async (req, res) => {
    const db = getDB();
    const channel = { id: nanoid(), code: genCode(), guestToken: nanoid(24), calendarToken: nanoid(24), status: 'abierto', createdAt: Date.now() };
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

  // ---------- mis casos ----------
  // Registrado ANTES de "/:code" a propósito: si no, Express interpretaría
  // "mine" como si fuera un código de canal. Sirve tanto para las partes
  // (si alguna vez tuvieron más de un canal) como para mediador/a y estudio
  // jurídico, que suelen estar en varios a la vez.
  router.get('/mine', requireAuth, (req, res) => {
    const db = getDB();
    const now = Date.now();
    const monthKey = new Date(now).toISOString().slice(0, 7); // "2026-08"
    const mine = db.members
      .filter((m) => m.userId === req.user.id)
      .map((m) => {
        const channel = db.channels.find((c) => c.id === m.channelId);
        if (!channel) return null;
        const otherMembers = db.members.filter((x) => x.channelId === channel.id && x.userId !== req.user.id);
        const channelPresence = presence.get(channel.code);
        // { name, role, roleLabel, online } por cada otro miembro — antes
        // era solo el nombre en texto plano, sin forma de distinguir un
        // mediador/a de la otra parte ni de saber si hay alguien conectado
        // ahora mismo (para eso había que entrar al canal y abrir la ⚙).
        const others = otherMembers
          .map((x) => {
            const u = db.users.find((u) => u.id === x.userId);
            if (!u) return null;
            return {
              name: u.name,
              role: x.role,
              roleLabel: x.role === 'A' || x.role === 'B' ? null : PROFESSIONAL_ROLE_LABELS[x.role] || x.role,
              online: !!(channelPresence && channelPresence.has(x.userId)),
            };
          })
          .filter(Boolean);
        const otherOnline = others.some((o) => o.online);
        const msgs = db.messages.filter((x) => x.channelId === channel.id);
        const lastActivity = msgs.reduce((max, x) => Math.max(max, x.createdAt), channel.createdAt);
        // último mensaje que MANDÉ yo en este canal, para mostrar "enviado" /
        // "leído" en la lista de casos — igual que el doble check de WhatsApp,
        // pero derivado de readAt, que ya existe y se usa dentro del chat.
        const myMessages = msgs.filter((x) => x.senderId === req.user.id);
        const lastOwnMessage = myMessages.length
          ? myMessages.reduce((latest, x) => (x.createdAt > latest.createdAt ? x : latest))
          : null;
        return {
          code: channel.code,
          status: channel.status || 'abierto',
          myRole: m.role,
          myRoleLabel: m.role === 'A' ? 'Parte A' : m.role === 'B' ? 'Parte B' : (PROFESSIONAL_ROLE_LABELS[m.role] || m.role),
          others,
          otherOnline,
          messageCount: msgs.length,
          lastActivity,
          lastOwnMessageStatus: lastOwnMessage ? (lastOwnMessage.readAt ? 'leido' : 'enviado') : null,
          inactiveDays: Math.floor((now - lastActivity) / 86400000),
          flaggedThisMonth: msgs.filter((x) => x.flagged && new Date(x.createdAt).toISOString().slice(0, 7) === monthKey).length,
          createdAt: channel.createdAt,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.lastActivity - a.lastActivity);
    res.json(mine);
  });

  // ---------- info del canal ----------
  router.get('/:code', requireAuth, requireMembership, (req, res) => {
    res.json(serializeChannel(req.channel));
  });

  // ---------- estado del caso (abierto/en_proceso/cerrado) ----------
  // Solo las partes lo cambian — un mediador/a con acceso de lectura no
  // debería poder cerrar el caso de alguien más por su cuenta.
  const CASE_STATUSES = ['abierto', 'en_proceso', 'cerrado'];
  router.post('/:code/status', requireAuth, requireMembership, requireParty, async (req, res) => {
    const { status } = req.body;
    if (!CASE_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Estado inválido — tiene que ser abierto, en_proceso o cerrado' });
    }
    const db = getDB();
    const channel = db.channels.find((c) => c.id === req.channel.id);
    channel.status = status;
    await commit();
    io.to(channel.code).emit('channel:status', { code: channel.code, status });
    res.json({ code: channel.code, status });
  });

  // ---------- acceso de mediador/a o estudio jurídico ----------
  // Solo las partes pueden generar esta invitación. Quien la usa entra con su
  // propia cuenta de Google (no anónimo, para que quede identificado quién es)
  // y con acceso de solo lectura — no puede mandar mensajes ni resolver
  // acuerdos en nombre de las partes. Su ingreso NUNCA es un acceso oculto:
  // siempre queda en la lista de integrantes del canal y en la fila de
  // presencia de arriba del chat, se elija o no avisar con un mensaje de
  // sistema en medio de la conversación (announceInChat, default true —
  // quien prefiere sumar a su mediador/a sin interrumpir el hilo activo
  // puede optar por eso, sin que deje de ser descubrible para la otra parte).
  router.post('/:code/professionals/invite', requireAuth, requireMembership, requireParty, async (req, res) => {
    const { role, label, announceInChat } = req.body;
    if (!PROFESSIONAL_ROLE_LABELS[role]) return res.status(400).json({ error: 'Rol inválido' });
    if (!label || !label.trim()) return res.status(400).json({ error: 'Falta el nombre del mediador/a o del estudio' });

    const db = getDB();
    const channel = db.channels.find((c) => c.id === req.channel.id);
    if (!channel.professionalInvites) channel.professionalInvites = [];
    const invite = {
      token: nanoid(24), role, label: label.trim(), createdBy: req.user.id, createdAt: Date.now(),
      announceInChat: announceInChat !== false, // default true — solo queda en false si se pidió explícitamente
      // un estudio jurídico real suele ser más de una persona (socios,
      // paralegal) — a diferencia de un/a mediador/a (una persona física
      // puntual), este mismo link se puede compartir y cada abogado/a se
      // suma con su propia cuenta de Google, cada uno como su propio
      // miembro del canal (ver /professional/:token/accept). No pide
      // volver a invitar caso por caso ni persona por persona.
      multiUse: role === 'estudio',
    };
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
        return res.json({ role: invite.role, label: invite.label, used: invite.multiUse ? false : !!invite.usedAt });
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
    // invitación de estudio jurídico: multiUse, se puede aceptar más de una
    // vez — cada abogado/a que la usa queda como su propio miembro, ver el
    // comentario en /professionals/invite más arriba.
    if (invite.usedAt && !invite.multiUse) return res.status(409).json({ error: 'Esta invitación ya fue usada' });

    const existing = memberOf(channel.id, req.user.id);
    if (existing) return res.json(serializeChannel(channel)); // ya es miembro (ej. recarga de página)

    db.members.push({
      id: nanoid(), channelId: channel.id, userId: req.user.id,
      role: invite.role, label: invite.label, joinedAt: Date.now(),
    });
    if (invite.multiUse) {
      // no se marca usedAt (eso la volvería de un solo uso) — se guarda el
      // historial de quién se sumó por acá, para poder mostrarlo después.
      invite.acceptedBy = invite.acceptedBy || [];
      invite.acceptedBy.push({ userId: req.user.id, at: Date.now() });
    } else {
      invite.usedAt = Date.now();
      invite.usedBy = req.user.id;
    }

    // el mensaje de sistema es opcional (announceInChat, elegido al invitar)
    // pero el ingreso NUNCA queda oculto: channel:update se emite siempre,
    // así que la lista de integrantes y la fila de presencia de arriba del
    // chat reflejan a la persona nueva de una, se haya anunciado o no acá.
    let sysMsg = null;
    if (invite.announceInChat !== false) {
      sysMsg = {
        id: nanoid(), channelId: channel.id, senderId: null,
        text: `${req.user.name} se unió al canal como ${PROFESSIONAL_ROLE_LABELS[invite.role]} (${invite.label}).`,
        flagged: false, reason: null, pattern: false, createdAt: Date.now(),
      };
      db.messages.push(sysMsg);
    }
    await commit();

    const payload = serializeChannel(channel);
    io.to(channel.code).emit('channel:update', payload);
    if (sysMsg) io.to(channel.code).emit('message:new', serializeMessage(sysMsg));
    res.json(payload);
  });

  // ---------- mensajes ----------
  // Paginado: sin ?before= devuelve los últimos `limit` mensajes (la
  // ventana "en vivo" con la que arranca el chat); con ?before=<createdAt>
  // devuelve los `limit` mensajes anteriores a esa fecha, para "cargar
  // mensajes anteriores" al scrollear hacia arriba. Antes traía TODO el
  // historial siempre — en un canal usado durante meses eso significa
  // repintar cientos de mensajes cada vez que llega uno nuevo.
  //
  // ?all=1 se salta la paginación — lo usa la pantalla Historial, que
  // necesita poder buscar sobre el registro completo, no solo la ventana
  // en vivo del chat (son usos distintos: Chat quiere ser liviano, Historial
  // promete ser el registro completo).
  router.get('/:code/messages', requireAuth, requireMembership, (req, res) => {
    const db = getDB();
    const all = db.messages
      .filter((m) => m.channelId === req.channel.id)
      .sort((a, b) => a.createdAt - b.createdAt);

    if (req.query.all) {
      return res.json({ messages: all.map(serializeMessage), hasMore: false });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const before = req.query.before ? Number(req.query.before) : null;
    const filtered = before ? all.filter((m) => m.createdAt < before) : all;

    const page = filtered.slice(-limit);
    res.json({
      messages: page.map(serializeMessage),
      hasMore: filtered.length > page.length,
    });
  });

  // analiza sin guardar — el frontend decide si usa la reformulación
  router.post('/:code/analyze', analyzeLimiter, requireAuth, requireMembership, requireQuotaOrSubscription, async (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
    try {
      const result = await analyzeMessage(text);
      // solo cuenta si había key configurada: si no, analyzeMessage nunca
      // pegó contra la API real, no hay costo que contar (ver moderationStats.js).
      if (process.env.ANTHROPIC_API_KEY) recordModerationCall(getDB(), { channelCode: req.channel.code, success: true, flagged: result.flagged });
      res.json(result);
    } catch (err) {
      console.error(err);
      if (process.env.ANTHROPIC_API_KEY) recordModerationCall(getDB(), { channelCode: req.channel.code, success: false, flagged: false });
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

  // marca de "leído" — solo la pone quien NO escribió el mensaje, y solo la
  // primera vez (no se reescribe si ya tenía valor). Nunca aplica a mensajes
  // de sistema (senderId null), que no tienen un "destinatario" real.
  router.post('/:code/messages/:id/read', requireAuth, requireMembership, async (req, res) => {
    const db = getDB();
    const msg = db.messages.find((m) => m.id === req.params.id && m.channelId === req.channel.id);
    if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });
    if (!msg.senderId || msg.senderId === req.user.id || msg.readAt) {
      return res.json({ id: msg.id, readAt: msg.readAt || null }); // no-op silencioso, no es un error de uso
    }
    msg.readAt = Date.now();
    await commit();
    io.to(req.channel.code).emit('message:read', { id: msg.id, readAt: msg.readAt });
    res.json({ id: msg.id, readAt: msg.readAt });
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
      requestedBy: req.user.id, status: 'pendiente', seriesId, createdAt: Date.now(), kind: 'entrega',
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

  // ---------- vencimientos procesales ----------
  // Igual mecanismo que un evento de entrega (mismo campo `date`, mismo
  // recordatorio un día antes en reminders.js) pero pensado para plazos
  // legales, no para coordinación entre las partes: NO pasa por
  // requireParty (un/a profesional también tiene que poder cargarlo, es
  // quien más lo necesita) y arranca directo en 'confirmado' — un
  // vencimiento no es algo que la otra parte "confirme o rechace", es un
  // hecho. kind:'vencimiento' es lo único que lo distingue de un evento
  // de entrega común a la hora de mostrarlo (ver caseCardHtml/calendario
  // en app.js) y de a quién le llega el recordatorio (ver reminders.js).
  router.post('/:code/events/vencimiento', requireAuth, requireMembership, async (req, res) => {
    const { date, detail } = req.body;
    if (!date || !detail) return res.status(400).json({ error: 'Faltan datos' });
    const db = getDB();
    const ev = {
      id: nanoid(), channelId: req.channel.id, date, detail,
      requestedBy: req.user.id, status: 'confirmado', kind: 'vencimiento', createdAt: Date.now(),
    };
    db.events.push(ev);
    const sysMsg = {
      id: nanoid(), channelId: req.channel.id, senderId: null,
      text: `${req.user.name} registró un vencimiento procesal: ${detail} (${date})`,
      flagged: false, reason: null, pattern: false, eventId: ev.id, createdAt: Date.now(),
    };
    db.messages.push(sysMsg);
    await commit();
    io.to(req.channel.code).emit('event:new', serializeEvent(ev));
    io.to(req.channel.code).emit('message:new', serializeMessage(sysMsg));
    res.json(serializeEvent(ev));
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

  // ---------- intercambio de fechas ----------
  // "Te doy mi turno del 15, a cambio del tuyo del 22" — dos eventos
  // creados juntos, atados por swapId, que se confirman o rechazan como
  // par (nunca uno sí y el otro no — un intercambio a medias no es un
  // intercambio). Mismo patrón que ya usan las series recurrentes arriba,
  // aplicado a un concepto distinto.
  router.post('/:code/events/swap', requireAuth, requireMembership, requireParty, async (req, res) => {
    const { dateA, detailA, dateB, detailB } = req.body;
    if (!dateA || !detailA || !dateB || !detailB) return res.status(400).json({ error: 'Faltan datos de las dos fechas del intercambio' });

    const db = getDB();
    const swapId = nanoid();
    const evA = { id: nanoid(), channelId: req.channel.id, date: dateA, detail: detailA, requestedBy: req.user.id, status: 'pendiente', swapId, createdAt: Date.now() };
    const evB = { id: nanoid(), channelId: req.channel.id, date: dateB, detail: detailB, requestedBy: req.user.id, status: 'pendiente', swapId, createdAt: Date.now() };
    db.events.push(evA, evB);

    const sysMsg = {
      id: nanoid(), channelId: req.channel.id, senderId: null,
      text: `${req.user.name} propuso un intercambio: "${detailA}" (${dateA}) por "${detailB}" (${dateB})`,
      flagged: false, reason: null, pattern: false, createdAt: Date.now(),
    };
    db.messages.push(sysMsg);
    await commit();

    io.to(req.channel.code).emit('event:new', serializeEvent(evA));
    io.to(req.channel.code).emit('event:new', serializeEvent(evB));
    io.to(req.channel.code).emit('message:new', serializeMessage(sysMsg));
    res.json({ swapId, events: [serializeEvent(evA), serializeEvent(evB)] });
  });

  router.post('/:code/events/swap/:swapId/respond', requireAuth, requireMembership, requireParty, async (req, res) => {
    const { decision } = req.body;
    if (!['confirmado', 'rechazado'].includes(decision)) {
      return res.status(400).json({ error: 'Decisión inválida' });
    }
    const db = getDB();
    const evs = db.events.filter(
      (e) => e.swapId === req.params.swapId && e.channelId === req.channel.id && e.status === 'pendiente'
    );
    if (evs.length !== 2) return res.status(404).json({ error: 'Intercambio no encontrado o ya resuelto' });
    evs.forEach((e) => { e.status = decision; e.respondedAt = Date.now(); });
    const verb = decision === 'confirmado' ? 'confirmó' : 'rechazó';
    const sysMsg = {
      id: nanoid(), channelId: req.channel.id, senderId: null,
      text: `${req.user.name} ${verb} el intercambio: "${evs[0].detail}" (${evs[0].date}) por "${evs[1].detail}" (${evs[1].date})`,
      flagged: false, reason: null, pattern: false, createdAt: Date.now(),
    };
    db.messages.push(sysMsg);
    await commit();
    evs.forEach((e) => io.to(req.channel.code).emit('event:update', serializeEvent(e)));
    io.to(req.channel.code).emit('message:new', serializeMessage(sysMsg));
    res.json({ updated: evs.length });
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

  // ---------- gastos compartidos ----------
  // Mismo patrón que los eventos: cualquier parte pide, la otra confirma o
  // rechaza. Sin pagos reales todavía — solo registro y confirmación del
  // monto, útil para llevar la cuenta de qué se dividió y qué falta saldar.
  function serializeExpense(e) {
    const linkedEvent = e.eventId ? getDB().events.find((ev) => ev.id === e.eventId) : null;
    return {
      id: e.id, amount: e.amount, description: e.description,
      requestedBy: publicUser(e.requestedBy), status: e.status, createdAt: e.createdAt,
      event: linkedEvent ? { id: linkedEvent.id, date: linkedEvent.date, detail: linkedEvent.detail } : null,
    };
  }

  router.get('/:code/expenses', requireAuth, requireMembership, (req, res) => {
    const db = getDB();
    const list = db.expenses
      .filter((e) => e.channelId === req.channel.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(serializeExpense);
    res.json(list);
  });

  router.post('/:code/expenses', requireAuth, requireMembership, requireParty, async (req, res) => {
    const { amount, description, eventId } = req.body;
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) return res.status(400).json({ error: 'Monto inválido' });
    if (!description || !description.trim()) return res.status(400).json({ error: 'Falta la descripción del gasto' });

    const db = getDB();
    // el evento vinculado (si se manda) tiene que ser del mismo canal — no
    // hay forma de que el frontend le pase el id de un evento de OTRO caso,
    // pero igual se valida acá, nunca confiar solo en lo que arma el cliente.
    let linkedEventId = null;
    if (eventId) {
      const ev = db.events.find((e) => e.id === eventId && e.channelId === req.channel.id);
      if (!ev) return res.status(400).json({ error: 'El evento vinculado no existe en este canal' });
      linkedEventId = ev.id;
    }

    const expense = {
      id: nanoid(), channelId: req.channel.id, amount: numAmount, description: description.trim(),
      requestedBy: req.user.id, status: 'pendiente', eventId: linkedEventId, createdAt: Date.now(),
    };
    db.expenses.push(expense);
    await commit();

    const linkedEvent = linkedEventId ? db.events.find((e) => e.id === linkedEventId) : null;
    const linkNote = linkedEvent ? ` — vinculado a "${linkedEvent.detail}" (${linkedEvent.date})` : '';
    await postSystemMessage(io, req.channel, `${req.user.name} registró un gasto compartido: ${description.trim()} ($${numAmount})${linkNote}.`);
    const out = serializeExpense(expense);
    io.to(req.channel.code).emit('expense:new', out);
    res.json(out);
  });

  router.post('/:code/expenses/:id/respond', requireAuth, requireMembership, requireParty, async (req, res) => {
    const { decision } = req.body;
    if (!['confirmado', 'rechazado'].includes(decision)) return res.status(400).json({ error: 'Decisión inválida' });
    const db = getDB();
    const expense = db.expenses.find((e) => e.id === req.params.id && e.channelId === req.channel.id);
    if (!expense) return res.status(404).json({ error: 'Gasto no encontrado' });
    expense.status = decision;
    expense.respondedAt = Date.now();
    await commit();

    const verb = decision === 'confirmado' ? 'confirmó' : 'rechazó';
    await postSystemMessage(io, req.channel, `${req.user.name} ${verb} el gasto: ${expense.description} ($${expense.amount}).`);
    const out = serializeExpense(expense);
    io.to(req.channel.code).emit('expense:update', out);
    res.json(out);
  });

  // ---------- check-in por geolocalización ----------
  // Solo lo hacen las partes (son quienes se encuentran físicamente) y solo
  // a pedido explícito de un botón — nunca automático. La ubicación exacta
  // se guarda en el registro pero jamás se muestra en el texto del chat.
  router.get('/:code/checkins', requireAuth, requireMembership, (req, res) => {
    const db = getDB();
    const list = db.checkins
      .filter((c) => c.channelId === req.channel.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => ({ id: c.id, user: publicUser(c.userId), createdAt: c.createdAt })); // sin lat/lng acá — esto sí lo ve cualquier miembro, incluido un mediador
    res.json(list);
  });

  router.post('/:code/checkins', requireAuth, requireMembership, requireParty, async (req, res) => {
    const { lat, lng } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number' || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'Ubicación inválida' });
    }
    const db = getDB();
    const checkin = { id: nanoid(), channelId: req.channel.id, userId: req.user.id, lat, lng, createdAt: Date.now() };
    db.checkins.push(checkin);
    await commit();

    // el mensaje de sistema avisa que hubo un check-in, sin exponer las coordenadas en el chat
    await postSystemMessage(io, req.channel, `${req.user.name} confirmó su llegada al punto de encuentro.`);
    const out = { id: checkin.id, user: publicUser(checkin.userId), createdAt: checkin.createdAt };
    io.to(req.channel.code).emit('checkin:new', out);
    res.json(out);
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
  router.get('/:code/export', requireAuth, requireMembership, async (req, res) => {
    const db = getDB();
    const { desde, hasta } = parseDateRange(req.query);
    let msgs = db.messages.filter((m) => m.channelId === req.channel.id).sort((a, b) => a.createdAt - b.createdAt);
    let events = db.events.filter((e) => e.channelId === req.channel.id).sort((a, b) => a.date.localeCompare(b.date));
    if (desde || hasta) {
      msgs = msgs.filter((m) => inRange(m.createdAt, desde, hasta));
      events = events.filter((e) => inRange(new Date(e.date + 'T00:00:00').getTime(), desde, hasta));
    }
    const expenses = db.expenses.filter((e) => e.channelId === req.channel.id);
    const confirmedTotal = expenses.filter((e) => e.status === 'confirmado').reduce((sum, e) => sum + e.amount, 0);

    const lines = [];
    lines.push('INFORME — PUENTE DIGITAL');
    lines.push(`Código de canal: ${req.channel.code}`);
    lines.push(`Generado: ${new Date().toLocaleString('es-AR')}`);
    lines.push(`Período: ${rangeLabel(desde, hasta)}`);
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
    lines.push('');
    lines.push('--- GASTOS COMPARTIDOS ---');
    if (expenses.length === 0) {
      lines.push('Sin gastos registrados.');
    } else {
      expenses.forEach((e) => {
        const who = publicUser(e.requestedBy)?.name || e.requestedBy;
        lines.push(`$${e.amount} — ${e.description} · pedido por ${who} · estado: ${e.status}`);
      });
      lines.push(`Total confirmado: $${confirmedTotal}`);
    }

    logAudit(db, { actorId: req.user.id, action: 'export_txt', channelCode: req.channel.code });
    await commit();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="informe-${req.channel.code}.txt"`);
    res.send(lines.join('\n'));
  });

  // ---------- informe certificado (PDF con membrete + hash de integridad) ----------
  // Mismo contenido que el .txt de arriba, pensado para llevar a otro ámbito
  // (juzgado, mediación presencial). No es una certificación notarial — el
  // propio documento lo aclara — pero incluye un hash SHA-256 verificable
  // del contenido al momento de generarse.
  router.get('/:code/export/certified', requireAuth, requireMembership, async (req, res) => {
    const db = getDB();
    const { desde, hasta } = parseDateRange(req.query);
    let msgs = db.messages.filter((m) => m.channelId === req.channel.id).sort((a, b) => a.createdAt - b.createdAt);
    let events = db.events.filter((e) => e.channelId === req.channel.id).sort((a, b) => a.date.localeCompare(b.date));
    if (desde || hasta) {
      msgs = msgs.filter((m) => inRange(m.createdAt, desde, hasta));
      events = events.filter((e) => inRange(new Date(e.date + 'T00:00:00').getTime(), desde, hasta));
    }
    const nameOf = (id) => publicUser(id)?.name || id;

    try {
      // el hash se calcula acá (no adentro de buildCertifiedReport) porque
      // hace falta ANTES de armar el PDF, para poder meter la URL de
      // verificación (con el hash incluido) en el QR del propio documento.
      const hash = integrityHash(buildPlainContent({ channel: req.channel, messages: msgs, events, nameOf, rangeLabel: rangeLabel(desde, hasta) }));
      const generatedBy = { name: req.user.name, role: roleLabelForExport(req.membership.role) };
      const verifyUrl = `${req.protocol}://${req.get('host')}/verificar/${hash}`;
      // firma electrónica (Ley 25.506 Art. 5 — no "firma digital" en el
      // sentido fuerte, ver signing.js) sobre el hash de integridad, no
      // sobre el documento entero: si no hay claves configuradas todavía
      // (SIGNING_PRIVATE_KEY/PUBLIC_KEY), signHash devuelve null y el PDF
      // sale igual, solo sin este agregado — nunca bloquea la exportación.
      const signature = signHash(hash);

      // carátula opcional para cuando el informe se va a adjuntar a un
      // escrito judicial (ver el <details> del export en Historial) — son
      // datos que la persona tipea al momento de exportar, no se guardan
      // en el canal (cada escrito puede ir a un expediente distinto).
      const juzgado = typeof req.query.juzgado === 'string' ? req.query.juzgado.trim().slice(0, 200) : '';
      const expediente = typeof req.query.expediente === 'string' ? req.query.expediente.trim().slice(0, 200) : '';
      const caratula = typeof req.query.caratula === 'string' ? req.query.caratula.trim().slice(0, 300) : '';
      const legalCase = (juzgado || expediente || caratula) ? { juzgado, expediente, caratula } : null;

      const pdf = await buildCertifiedReport({
        channel: req.channel,
        messages: msgs,
        events,
        nameOf,
        generatedBy,
        verifyUrl,
        rangeLabel: rangeLabel(desde, hasta),
        signature,
        publicKeyFingerprint: signature ? publicKeyFingerprint() : null,
        legalCase,
      });

      // el hash es determinístico a partir del contenido: exportar el MISMO
      // canal dos veces sin actividad nueva en el medio da el mismo hash. La
      // columna es UNIQUE, así que insertar de nuevo rompía el commit entero
      // (y con él, cualquier otra escritura hasta reiniciar el proceso) —
      // si ya existe un registro con este hash, no hace falta uno nuevo
      // (la firma tampoco cambiaría: es determinística a partir del mismo
      // hash y la misma clave).
      if (!db.certifiedExports.some((e) => e.hash === hash)) {
        db.certifiedExports.push({
          id: nanoid(), hash, signature, channelCode: req.channel.code,
          generatedByName: generatedBy.name, generatedByRole: generatedBy.role,
          createdAt: Date.now(),
        });
      }
      logAudit(db, { actorId: req.user.id, action: 'export_certified', channelCode: req.channel.code, meta: { hash } });
      await commit();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="informe-certificado-${req.channel.code}.pdf"`);
      res.send(pdf);
    } catch (err) {
      console.error('Error generando el PDF certificado:', err);
      res.status(500).json({ error: 'No se pudo generar el informe certificado' });
    }
  });

  function roleLabelForExport(role) {
    if (role === 'A' || role === 'B') return null;
    return PROFESSIONAL_ROLE_LABELS[role] || null;
  }

  // "2026-08-01" (input type=date del frontend, hora local implícita 00:00)
  // -> timestamp ms. Inválido o ausente -> null, así el resto del código no
  // tiene que distinguir "no vino" de "vino mal" en cada punto de uso.
  function parseDateRange(query) {
    const parseOne = (v, endOfDay) => {
      if (!v) return null;
      const d = new Date(v + (endOfDay ? 'T23:59:59.999' : 'T00:00:00'));
      return isNaN(d.getTime()) ? null : d.getTime();
    };
    return { desde: parseOne(query.desde, false), hasta: parseOne(query.hasta, true) };
  }
  function inRange(ts, desde, hasta) {
    if (desde !== null && ts < desde) return false;
    if (hasta !== null && ts > hasta) return false;
    return true;
  }
  // se imprime tal cual en el propio documento — un informe filtrado tiene
  // que decir que lo es, si no puede leerse como "todo lo que hay" cuando en
  // realidad es un recorte, y eso importa más todavía en un documento
  // pensado para llevar a un juzgado o mediación.
  function rangeLabel(desde, hasta) {
    const fmtDate = (ms) => new Date(ms).toLocaleDateString('es-AR');
    if (!desde && !hasta) return 'historial completo';
    if (desde && hasta) return `${fmtDate(desde)} a ${fmtDate(hasta)}`;
    if (desde) return `desde ${fmtDate(desde)}`;
    return `hasta ${fmtDate(hasta)}`;
  }

  // ---------- notas privadas del caso ----------
  // Visibles solo para mediador/a, estudio jurídico o admin de plataforma —
  // nunca aparecen en el chat ni son visibles para las partes A/B.
  router.get('/:code/notes', requireAuth, requireMembership, requireProfessionalOrAdmin, (req, res) => {
    const db = getDB();
    const notes = db.caseNotes
      .filter((n) => n.channelId === req.channel.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((n) => ({ id: n.id, text: n.text, author: publicUser(n.authorId), createdAt: n.createdAt }));
    res.json(notes);
  });

  router.post('/:code/notes', requireAuth, requireMembership, requireProfessionalOrAdmin, async (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Nota vacía' });
    const db = getDB();
    const note = { id: nanoid(), channelId: req.channel.id, authorId: req.user.id, text: text.trim(), createdAt: Date.now() };
    db.caseNotes.push(note);
    await commit();
    res.json({ id: note.id, text: note.text, author: publicUser(note.authorId), createdAt: note.createdAt });
  });

  return router;
};
