// routes/agenda.js
// Bloque 15 (Parte 1). hearings sigue siendo la única fuente de verdad
// de la audiencia — acá solo vive lo que antes no existía en ningún
// lado: disponibilidad recurrente, bloqueos puntuales, y la vista
// agregada que junta hearings de todas las mediaciones a las que el
// usuario tiene acceso (reusa mediationAccess.js, no duplica ese cálculo).

const express = require('express');
const rateLimit = require('express-rate-limit');
const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');
const { getMyMediations } = require('../mediationAccess');
const { checkHearingConflicts, toMinutes } = require('../agenda');
const { buildHearingsIcsFeed } = require('../ics');

// mismo throttle liviano que portalLimiter en party-portal.js/lawyer-
// portal.js — el token de 32 caracteres no es adivinable por fuerza
// bruta, esto es más que nada contra loops de un cliente mal configurado.
const feedLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos — esperá unos minutos.' },
});

// Buenos Aires es UTC-3 fijo, sin horario de verano desde 2009 — no hace
// falta Intl ni conversión real de zona horaria para la aritmética de
// calendario (a qué día de la semana cae una fecha, sumar/restar días).
// Se usan los métodos UTC de Date solo como un contador de días estable,
// nunca como un instante real — así el cálculo no depende de en qué
// huso horario corra el proceso de Node.
function parseCalendarDate(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function formatCalendarDate(date) {
  return date.toISOString().slice(0, 10);
}
function addDays(yyyyMmDd, days) {
  const d = parseCalendarDate(yyyyMmDd);
  d.setUTCDate(d.getUTCDate() + days);
  return formatCalendarDate(d);
}
function dayOfWeek(yyyyMmDd) {
  return parseCalendarDate(yyyyMmDd).getUTCDay();
}
function startOfWeek(yyyyMmDd) {
  // semana lunes a domingo
  const dow = dayOfWeek(yyyyMmDd); // 0=domingo..6=sabado
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  return addDays(yyyyMmDd, diffToMonday);
}

module.exports = function () {
  const router = express.Router();

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    next();
  }

  // ---------- disponibilidad (auto-gestión, cada quien la suya) ----------
  router.get('/availability', requireAuth, (req, res) => {
    const db = getDB();
    const list = db.mediatorAvailability.filter((a) => a.userId === req.user.id).sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
    res.json(list);
  });

  router.post('/availability', requireAuth, async (req, res) => {
    const { dayOfWeek: dow, startTime, endTime } = req.body || {};
    if (![0, 1, 2, 3, 4, 5, 6].includes(dow)) return res.status(400).json({ error: 'Día de la semana inválido (0 a 6)' });
    if (toMinutes(startTime) == null || toMinutes(endTime) == null || toMinutes(startTime) >= toMinutes(endTime)) {
      return res.status(400).json({ error: 'Horario inválido' });
    }
    const db = getDB();
    const block = { id: nanoid(), userId: req.user.id, dayOfWeek: dow, startTime, endTime, createdAt: Date.now() };
    db.mediatorAvailability.push(block);
    await commit();
    res.json(block);
  });

  router.delete('/availability/:id', requireAuth, async (req, res) => {
    const db = getDB();
    const block = db.mediatorAvailability.find((a) => a.id === req.params.id && a.userId === req.user.id);
    if (!block) return res.status(404).json({ error: 'No encontrado' });
    db.mediatorAvailability = db.mediatorAvailability.filter((a) => a.id !== block.id);
    await commit();
    res.json({ ok: true });
  });

  // ---------- bloqueos puntuales ----------
  router.get('/blocks', requireAuth, (req, res) => {
    const db = getDB();
    const list = db.mediatorScheduleBlocks.filter((b) => b.userId === req.user.id).sort((a, b) => a.date.localeCompare(b.date));
    res.json(list);
  });

  router.post('/blocks', requireAuth, async (req, res) => {
    const { date, startTime, endTime, reason } = req.body || {};
    if (!date || toMinutes(startTime) == null || toMinutes(endTime) == null || toMinutes(startTime) >= toMinutes(endTime)) {
      return res.status(400).json({ error: 'Fecha u horario inválido' });
    }
    const db = getDB();
    const block = { id: nanoid(), userId: req.user.id, date, startTime, endTime, reason: reason || null, createdAt: Date.now() };
    db.mediatorScheduleBlocks.push(block);
    await commit();
    res.json(block);
  });

  router.delete('/blocks/:id', requireAuth, async (req, res) => {
    const db = getDB();
    const block = db.mediatorScheduleBlocks.find((b) => b.id === req.params.id && b.userId === req.user.id);
    if (!block) return res.status(404).json({ error: 'No encontrado' });
    db.mediatorScheduleBlocks = db.mediatorScheduleBlocks.filter((b) => b.id !== block.id);
    await commit();
    res.json({ ok: true });
  });

  // ---------- vista de agenda (día/semana) ----------
  // agrega audiencias de TODAS las mediaciones a las que el usuario tiene
  // acceso (getMyMediations, sin duplicar ese cálculo) — nunca expone
  // bloqueos ni disponibilidad de otra persona, nunca mediaciones ajenas.
  router.get('/', requireAuth, (req, res) => {
    const db = getDB();
    const view = req.query.view === 'week' ? 'week' : 'day';
    const baseDate = req.query.date || formatCalendarDate(new Date());
    const rangeStart = view === 'week' ? startOfWeek(baseDate) : baseDate;
    const rangeEnd = view === 'week' ? addDays(rangeStart, 6) : baseDate;

    const myMediations = getMyMediations(db, req.user);
    const myMediationIds = new Set(myMediations.map((m) => m.id));
    const mediationById = Object.fromEntries(myMediations.map((m) => [m.id, m]));

    let hearings = db.hearings.filter((h) => myMediationIds.has(h.mediationId) && h.date >= rangeStart && h.date <= rangeEnd);

    if (req.query.mediador) hearings = hearings.filter((h) => mediationById[h.mediationId]?.mediatorUserId === req.query.mediador);
    if (req.query.estado) hearings = hearings.filter((h) => h.status === req.query.estado);
    if (req.query.modalidad) hearings = hearings.filter((h) => h.modality === req.query.modalidad);

    const enriched = hearings.map((h) => {
      const mediation = mediationById[h.mediationId];
      const owner = db.users.find((u) => u.id === mediation.mediatorUserId);
      const confirmations = db.hearingConfirmations.filter((c) => c.hearingId === h.id);
      const confirmedCount = confirmations.filter((c) => c.response === 'confirma').length;
      const pendingCount = confirmations.filter((c) => c.response === 'pendiente').length;
      let confirmationSummary = 'ninguna';
      if (confirmations.length > 0) {
        if (confirmedCount === confirmations.length) confirmationSummary = 'todas';
        else if (confirmedCount > 0) confirmationSummary = 'algunas';
        else if (pendingCount === confirmations.length) confirmationSummary = 'pendientes';
      }
      // reprogramada recientemente — el mismo criterio que ya deja
      // constancia el endpoint de resolución de reprogramación (Hardening):
      // evento HEARING_RESCHEDULED con este hearingId como entidad.
      const recentlyRescheduled = db.mediationEvents.some((e) => e.type === 'HEARING_RESCHEDULED' && e.entityId === h.id);

      return {
        id: h.id, mediationId: h.mediationId, mediationCode: mediation.code, mediationObject: mediation.object,
        date: h.date, startTime: h.startTime, endTime: h.endTime, modality: h.modality, location: h.location,
        meetingUrl: h.meetingUrl, status: h.status, mediatorUserId: mediation.mediatorUserId, mediatorName: owner ? owner.name : null,
        confirmationSummary, pendingConfirmations: pendingCount,
        alerts: { confirmationPending: pendingCount > 0, recentlyRescheduled },
      };
    });

    let filtered = enriched;
    if (req.query.confirmacionPendiente === '1') filtered = filtered.filter((h) => h.alerts.confirmationPending);

    res.json({ view, rangeStart, rangeEnd, hearings: filtered.sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || '')) });
  });

  // ---------- bandeja de solicitudes (Bloque 15 Parte 2 §6) ----------
  // agrega hearing_reschedule_requests de TODAS las mediaciones a las que
  // el usuario tiene acceso — mismo cálculo que la agenda, sin duplicarlo.
  router.get('/requests', requireAuth, (req, res) => {
    const db = getDB();
    const myMediations = getMyMediations(db, req.user);
    const myMediationIds = new Set(myMediations.map((m) => m.id));
    const mediationById = Object.fromEntries(myMediations.map((m) => [m.id, m]));

    let requests = db.hearingRescheduleRequests.filter((r) => myMediationIds.has(r.mediationId));

    if (req.query.estado === 'pendientes') requests = requests.filter((r) => r.status === 'pendiente');
    if (req.query.estado === 'resueltas') requests = requests.filter((r) => r.status !== 'pendiente');
    if (req.query.fecha) requests = requests.filter((r) => (r.proposedDate || '') === req.query.fecha);
    if (req.query.mediador) requests = requests.filter((r) => mediationById[r.mediationId]?.mediatorUserId === req.query.mediador);

    const enriched = requests.map((r) => {
      const mediation = mediationById[r.mediationId];
      const hearing = db.hearings.find((h) => h.id === r.hearingId);
      const party = db.parties.find((p) => p.id === r.requestedByPartyId);
      return {
        id: r.id, mediationId: r.mediationId, mediationCode: mediation.code, mediationObject: mediation.object,
        hearingId: r.hearingId, hearingDate: hearing ? hearing.date : null, hearingStartTime: hearing ? hearing.startTime : null,
        requestedByPartyName: party ? (party.legalName || `${party.firstName || ''} ${party.lastName || ''}`.trim()) : null,
        requestedByType: r.requestedByType, reason: r.reason, comment: r.comment,
        preferredDayText: r.preferredDayText, preferredTimeText: r.preferredTimeText,
        proposedDate: r.proposedDate, proposedStartTime: r.proposedStartTime,
        status: r.status, ageMs: Date.now() - r.createdAt, createdAt: r.createdAt,
      };
    });

    res.json(enriched.sort((a, b) => b.createdAt - a.createdAt));
  });

  // ---------- feed ICS (solo lectura) ----------
  // Suscripción de calendario (Google Calendar/Apple Calendar/Outlook) con
  // las audiencias del mediador — aditivo y de solo lectura: no cambia en
  // nada cómo se cargan o gestionan las audiencias, solo las expone en
  // otro formato. Nada de push nativo ni de integrarse con la API de
  // Google Calendar todavía — si en algún momento hay pedido real de algo
  // más "vivo", se evalúa esa API con más cuidado, con uso real de por
  // medio en vez de construirlo a ciegas.
  router.get('/feed-token', requireAuth, async (req, res) => {
    const db = getDB();
    const user = db.users.find((u) => u.id === req.user.id);
    if (!user.icsToken) {
      user.icsToken = nanoid(32);
      await commit();
    }
    res.json({ url: `/api/agenda/feed.ics?token=${user.icsToken}` });
  });

  // regenerar invalida la URL vieja — para cuando el link se compartió por
  // error o el mediador simplemente quiere cortar una suscripción activa.
  router.post('/feed-token/regenerate', requireAuth, async (req, res) => {
    const db = getDB();
    const user = db.users.find((u) => u.id === req.user.id);
    user.icsToken = nanoid(32);
    await commit();
    res.json({ url: `/api/agenda/feed.ics?token=${user.icsToken}` });
  });

  // SIN requireAuth a propósito — el token de 32 caracteres ES la
  // identidad acá, mismo espíritu que portalToken en party-portal.js/
  // lawyer-portal.js: un cliente de calendario no manda la cookie de
  // sesión cuando refresca la suscripción por su cuenta cada tanto.
  router.get('/feed.ics', feedLimiter, (req, res) => {
    const db = getDB();
    const token = req.query.token;
    const user = token ? db.users.find((u) => u.icsToken === token) : null;
    if (!user) return res.status(404).type('text/plain').send('Feed no encontrado.');

    const myMediations = getMyMediations(db, user);
    const myMediationIds = new Set(myMediations.map((m) => m.id));
    const mediationById = Object.fromEntries(myMediations.map((m) => [m.id, m]));
    const hearings = db.hearings
      .filter((h) => myMediationIds.has(h.mediationId))
      .map((h) => ({
        id: h.id, mediationCode: mediationById[h.mediationId].code, mediationObject: mediationById[h.mediationId].object,
        date: h.date, startTime: h.startTime, endTime: h.endTime, modality: h.modality,
        location: h.location, meetingUrl: h.meetingUrl, status: h.status,
      }));

    const ics = buildHearingsIcsFeed(hearings, { calendarName: `Mediador — ${user.name}` });
    res.type('text/calendar; charset=utf-8').send(ics);
  });

  return router;
};
