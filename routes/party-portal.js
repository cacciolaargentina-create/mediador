// routes/party-portal.js
// Bloque 7 de Mediador (B2B) — acceso de una PARTE a su mediación, sin
// cuenta, mediante el portalToken que el mediador genera desde el
// expediente. Nunca requireAuth/sesión — el token ES la identidad, mismo
// espíritu que routes/guest.js para coparentalidad, pero acotado a lo que
// le corresponde a esta parte puntual, nunca al resto de la mediación.
//
// NUNCA expone: notas privadas, mediation_events con visibility
// mediator_only, datos de otras partes, ni nada del mediador que no sea
// estrictamente necesario para que la parte sepa "qué pasa y qué tengo
// que hacer yo" — ver IMPLEMENTATION_PLAN.md §19-21 de la especificación
// original.

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');
const { logMediationEvent } = require('../mediationEvents');
const { postMessage } = require('../messaging');
const { serializeMessage } = require('../serializers');

// mismo throttle liviano que guest.js — el token de 24 caracteres no es
// adivinable por fuerza bruta, esto es más que nada contra loops del cliente.
const portalLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos — esperá unos minutos.' },
});

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads', 'mediations');
const ALLOWED_MIME_EXT = {
  'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};
const MAX_UPLOAD_BYTES = Number(process.env.MAX_DOCUMENT_SIZE_MB || 15) * 1024 * 1024;

module.exports = function (io) {
  const router = express.Router();

  // resuelve la parte a partir del token en TODOS los endpoints de acá —
  // un solo lugar donde "token inválido" se rechaza, en vez de repetir el
  // chequeo en cada ruta por separado.
  function resolveParty(req, res, next) {
    const db = getDB();
    const party = db.parties.find((p) => p.portalToken && p.portalToken === req.params.token);
    if (!party) return res.status(404).json({ error: 'Enlace inválido o vencido' });
    const mediation = db.mediations.find((m) => m.id === party.mediationId);
    if (!mediation) return res.status(404).json({ error: 'Mediación no encontrada' });
    req.party = party;
    req.mediation = mediation;
    next();
  }

  const uploadPortalDocument = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(UPLOADS_ROOT, req.mediation.id);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const ext = ALLOWED_MIME_EXT[file.mimetype] || '';
        cb(null, nanoid() + ext);
      },
    }),
    fileFilter: (req, file, cb) => {
      const expectedExt = ALLOWED_MIME_EXT[file.mimetype];
      if (!expectedExt) return cb(new Error('Tipo de archivo no permitido'));
      const originalExt = path.extname(file.originalname).toLowerCase();
      if (!Object.values(ALLOWED_MIME_EXT).includes(originalExt)) return cb(new Error('Extensión de archivo no permitida'));
      cb(null, true);
    },
    limits: { fileSize: MAX_UPLOAD_BYTES },
  });

  // ---------- vista principal del portal ----------
  router.get('/:token', portalLimiter, resolveParty, (req, res) => {
    const db = getDB();
    const { party, mediation } = req;

    const hearings = db.hearings
      .filter((h) => h.mediationId === mediation.id && ['programada', 'confirmada'].includes(h.status))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((h) => {
        const confirmation = db.hearingConfirmations.find((c) => c.hearingId === h.id && c.partyId === party.id);
        return {
          id: h.id, date: h.date, startTime: h.startTime, modality: h.modality,
          location: h.location, meetingUrl: h.meetingUrl,
          myResponse: confirmation ? confirmation.response : null,
        };
      });

    const commitments = db.commitments
      .filter((c) => c.mediationId === mediation.id && c.partyId === party.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => ({ id: c.id, description: c.description, dueDate: c.dueDate, status: c.status }));

    // documentos: los generales de la mediación (partyId null) + los
    // etiquetados específicamente como de esta parte — nunca los de otra
    // parte puntual.
    const documents = db.documents
      .filter((d) => d.mediationId === mediation.id && (d.partyId === null || d.partyId === party.id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((d) => ({ id: d.id, originalFilename: d.originalFilename, type: d.type, size: d.size, createdAt: d.createdAt }));

    // "Pendiente" — la especificación de UX pide un solo campo prominente
    // con lo que le corresponde a ESTA parte ahora, no que tenga que
    // deducirlo mirando listas separadas. Prioridad: confirmar una
    // audiencia primero (es lo más urgente), después un compromiso propio
    // sin cumplir, si no hay ninguna de las dos cosas, no hay nada pendiente.
    const hearingNeedingConfirmation = hearings.find((h) => h.myResponse === null || h.myResponse === 'pendiente');
    const commitmentPending = commitments.find((c) => c.status === 'pendiente' || c.status === 'vencido');
    let pendiente = null;
    if (hearingNeedingConfirmation) {
      pendiente = `Confirmar tu asistencia a la audiencia del ${hearingNeedingConfirmation.date}`;
    } else if (commitmentPending) {
      pendiente = `${commitmentPending.description}${commitmentPending.dueDate ? ' — vence ' + commitmentPending.dueDate : ''}`;
    }

    res.json({
      mediationCode: mediation.code, mediationObject: mediation.object, mediationStatus: mediation.status,
      partyName: party.legalName || `${party.firstName || ''} ${party.lastName || ''}`.trim(),
      pendiente,
      allowDocumentUpload: party.allowDocumentUpload !== false,
      hearings, commitments, documents,
    });
  });

  // ---------- comunicaciones con el mediador (lado de la parte) ----------
  router.get('/:token/messages', portalLimiter, resolveParty, (req, res) => {
    const db = getDB();
    const thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.partyId === req.party.id);
    if (!thread) return res.json([]);
    const messages = db.messages.filter((m) => m.channelId === thread.id).sort((a, b) => a.createdAt - b.createdAt);
    res.json(messages.map((m) => ({ id: m.id, senderId: m.senderId, text: m.text, createdAt: m.createdAt, mine: m.senderId === req.party.linkedUserId })));
  });

  router.post('/:token/messages', portalLimiter, resolveParty, async (req, res) => {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'Falta el texto del mensaje' });
    const db = getDB();
    const thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.partyId === req.party.id);
    if (!thread) return res.status(400).json({ error: 'Tu hilo todavía no está listo — pedile al mediador que te reenvíe la invitación' });
    const msg = await postMessage(io, thread, { senderId: req.party.linkedUserId, text: text.trim(), flagged: false });
    logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'MESSAGE_RECEIVED', actorId: null,
      visibility: 'mediator_only', entityType: 'message', entityId: msg.id,
      title: `Mensaje recibido de ${req.party.firstName || 'la parte'}`,
    });
    await commit();
    res.json({ id: msg.id, senderId: msg.sender?.id, text: msg.text, createdAt: msg.createdAt, mine: true });
  });

  // ---------- confirmar audiencia (la parte responde ella misma) ----------
  router.post('/:token/hearings/:hearingId/confirm', portalLimiter, resolveParty, async (req, res) => {
    const { response, reason, proposedDate, proposedStartTime } = req.body || {};
    if (!['confirma', 'no_puede', 'pide_cambio'].includes(response)) {
      return res.status(400).json({ error: 'Respuesta inválida' });
    }
    const db = getDB();
    const confirmation = db.hearingConfirmations.find(
      (c) => c.hearingId === req.params.hearingId && c.partyId === req.party.id
    );
    if (!confirmation) return res.status(404).json({ error: 'Confirmación no encontrada' });
    // el chequeo de que la audiencia pertenece a ESTA mediación pasa por
    // el propio partyId (una parte solo tiene confirmaciones de audiencias
    // de su propia mediación) — no hace falta un segundo chequeo cruzado.
    confirmation.response = response;
    confirmation.respondedAt = Date.now();
    const confirmEvent = logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'HEARING_CONFIRMED', actorId: null,
      visibility: 'public', entityType: 'hearing', entityId: confirmation.hearingId,
      title: `${req.party.firstName || 'La parte'} respondió: ${response}`,
    });
    // hardening — reprogramación estructurada: "pide_cambio" ahora además
    // genera la solicitud en sí (motivo/fecha propuesta), no solo queda
    // como una respuesta suelta. Nunca toca hearings.date directamente —
    // solo el mediador puede reprogramar de verdad (ver el endpoint de
    // resolución más abajo, en routes/mediations.js).
    let rescheduleRequest = null;
    if (response === 'pide_cambio') {
      rescheduleRequest = {
        id: nanoid(), hearingId: req.params.hearingId, mediationId: req.mediation.id,
        requestedByPartyId: req.party.id, requestedByType: 'party', requestedByLawyerId: null,
        reason: reason || null, proposedDate: proposedDate || null, proposedStartTime: proposedStartTime || null,
        status: 'pendiente', mediatorNote: null, resolvedBy: null, resolvedAt: null, createdAt: Date.now(),
      };
      db.hearingRescheduleRequests.push(rescheduleRequest);
      logMediationEvent(db, {
        mediationId: req.mediation.id, type: 'HEARING_RESCHEDULE_REQUESTED', actorId: null,
        entityType: 'hearing_reschedule_request', entityId: rescheduleRequest.id,
        title: `${req.party.firstName || 'La parte'} pidió cambiar la audiencia`,
        description: reason || null, causedByEventId: confirmEvent.id,
      });
    }
    await commit();
    res.json({ id: confirmation.id, response: confirmation.response, rescheduleRequestId: rescheduleRequest ? rescheduleRequest.id : null });
  });

  // ---------- subir un documento propio ----------
  router.post('/:token/documents', portalLimiter, resolveParty,
    (req, res, next) => {
      // el mediador puede desactivar esto por parte — se chequea ANTES de
      // aceptar cualquier archivo, no después de haberlo ya procesado.
      if (req.party.allowDocumentUpload === false) {
        return res.status(403).json({ error: 'El mediador no habilitó la carga de documentos para tu parte todavía' });
      }
      next();
    },
    (req, res, next) => {
      uploadPortalDocument.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'No se pudo subir el archivo' });
        next();
      });
    },
    async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Falta el archivo' });
      const db = getDB();
      const doc = {
        id: nanoid(), mediationId: req.mediation.id, uploadedBy: null, partyId: req.party.id,
        type: req.body.type || 'otro',
        originalFilename: req.file.originalname, storagePath: req.file.filename,
        mimeType: req.file.mimetype, size: req.file.size,
        status: 'recibido', version: 1, createdAt: Date.now(),
      };
      db.documents.push(doc);
      logMediationEvent(db, {
        mediationId: req.mediation.id, type: 'DOCUMENT_UPLOADED', actorId: null,
        entityType: 'document', entityId: doc.id,
        title: `Documento subido por ${req.party.firstName || 'la parte'}: ${doc.originalFilename}`,
      });
      await commit();
      res.json({ id: doc.id, originalFilename: doc.originalFilename, type: doc.type, size: doc.size, createdAt: doc.createdAt });
    }
  );

  // ---------- descargar un documento (propio o general) ----------
  router.get('/:token/documents/:docId/download', portalLimiter, resolveParty, (req, res) => {
    const db = getDB();
    const doc = db.documents.find((d) => d.id === req.params.docId && d.mediationId === req.mediation.id);
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });
    // una parte nunca puede bajar un documento etiquetado para OTRA parte puntual
    if (doc.partyId && doc.partyId !== req.party.id) {
      return res.status(403).json({ error: 'No tenés acceso a este documento' });
    }
    const filePath = path.join(UPLOADS_ROOT, req.mediation.id, doc.storagePath);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.originalFilename)}"`);
    res.setHeader('Content-Type', doc.mimeType);
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'El archivo no se encontró en el servidor' });
    });
  });

  return router;
};
