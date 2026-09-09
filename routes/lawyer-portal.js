// routes/lawyer-portal.js
// Portal de Abogados — acceso de un abogado, sin cuenta, mediante el
// portalToken que el mediador genera desde el expediente. Mismo espíritu
// que routes/party-portal.js (token → identidad → alcance acotado), pero
// un abogado puede estar vinculado a MÁS de una mediación (mismo token
// reusado por email — ver el endpoint de invitación en routes/mediations.js),
// así que acá "MIS MEDIACIONES" es plural desde el arranque.
//
// Regla de acceso, la misma en cada endpoint sin excepción:
//   token → lawyer(s) → partyId → mediationId
// Nunca se confía en que el frontend no muestre algo — cada ruta vuelve a
// resolver esta cadena.

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');
const { logMediationEvent } = require('../mediationEvents');

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

module.exports = function () {
  const router = express.Router();

  // resuelve TODAS las filas de lawyers que comparten este token (puede
  // ser una sola mediación, o varias si el mismo abogado está vinculado a
  // más de una) — nunca expone nada todavía, solo arma la lista de acceso.
  function resolveLawyer(req, res, next) {
    const db = getDB();
    const lawyerRows = db.lawyers.filter((l) => l.portalToken && l.portalToken === req.params.token);
    if (!lawyerRows.length) return res.status(404).json({ error: 'Enlace inválido o vencido' });
    req.lawyerRows = lawyerRows;
    next();
  }

  // para rutas con :mediationId — además de resolver el token, verifica
  // que ESE mediationId puntual sea uno de los que este abogado puede
  // tocar, y deja la fila de lawyer + la party + la mediation ya resueltas.
  function resolveLawyerMediation(req, res, next) {
    const db = getDB();
    const lawyerRow = req.lawyerRows.find((l) => l.mediationId === req.params.mediationId);
    if (!lawyerRow) return res.status(403).json({ error: 'No representás a ninguna parte en esta mediación' });
    const mediation = db.mediations.find((m) => m.id === lawyerRow.mediationId);
    const party = db.parties.find((p) => p.id === lawyerRow.partyId);
    if (!mediation || !party) return res.status(404).json({ error: 'Mediación no encontrada' });
    req.lawyer = lawyerRow;
    req.mediation = mediation;
    req.party = party;
    next();
  }

  const uploadLawyerDocument = multer({
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

  function partyDisplayName(db, partyId) {
    const p = db.parties.find((x) => x.id === partyId);
    if (!p) return null;
    return p.legalName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || null;
  }

  // ---------- MIS MEDIACIONES — la pantalla principal ----------
  router.get('/:token', portalLimiter, resolveLawyer, (req, res) => {
    const db = getDB();
    const list = req.lawyerRows.map((lawyerRow) => {
      const mediation = db.mediations.find((m) => m.id === lawyerRow.mediationId);
      if (!mediation) return null;
      const party = db.parties.find((p) => p.id === lawyerRow.partyId);
      const hearings = db.hearings.filter((h) => h.mediationId === mediation.id && ['programada', 'confirmada'].includes(h.status));
      const nextHearing = hearings.sort((a, b) => a.date.localeCompare(b.date))[0] || null;
      const pendingCommitments = db.commitments.filter((c) => c.mediationId === mediation.id && c.partyId === lawyerRow.partyId && ['pendiente', 'vencido'].includes(c.status));
      return {
        mediationId: mediation.id, mediationCode: mediation.code, mediationObject: mediation.object,
        mediationStatus: mediation.status, partyName: partyDisplayName(db, lawyerRow.partyId) || (party?.role || ''),
        nextHearingDate: nextHearing ? nextHearing.date : null,
        pendingCommitmentsCount: pendingCommitments.length,
      };
    }).filter(Boolean);
    res.json({ lawyerName: req.lawyerRows[0].name, mediations: list });
  });

  // ---------- detalle de UNA mediación ----------
  router.get('/:token/mediations/:mediationId', portalLimiter, resolveLawyer, resolveLawyerMediation, (req, res) => {
    const db = getDB();
    const { mediation, party } = req;

    const hearings = db.hearings
      .filter((h) => h.mediationId === mediation.id && ['programada', 'confirmada'].includes(h.status))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((h) => {
        const confirmation = db.hearingConfirmations.find((c) => c.hearingId === h.id && c.partyId === party.id);
        return {
          id: h.id, date: h.date, startTime: h.startTime, modality: h.modality,
          location: h.location, meetingUrl: h.meetingUrl, status: h.status,
          myResponse: confirmation ? confirmation.response : null,
        };
      });

    const commitments = db.commitments
      .filter((c) => c.mediationId === mediation.id && c.partyId === party.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => ({ id: c.id, description: c.description, dueDate: c.dueDate, status: c.status }));

    // mismas reglas de documentos que el Portal de Partes: generales
    // (partyId null) + los de la parte representada, nunca los de otra.
    const documents = db.documents
      .filter((d) => d.mediationId === mediation.id && (d.partyId === null || d.partyId === party.id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((d) => ({ id: d.id, originalFilename: d.originalFilename, type: d.type, size: d.size, createdAt: d.createdAt }));

    // timeline filtrado — acá es donde más cuidado hace falta. visibility
    // 'public' NO alcanza solo: un evento puede ser público para el
    // mediador y las partes en general, pero seguir nombrando a OTRA
    // parte específica (ej. "Parte agregada: María", o el documento que
    // subió otra parte) — eso el abogado de Juan nunca lo puede ver.
    // Filtro explícito por tipo, no un blocklist: si no sé con certeza que
    // un tipo de evento es seguro para este abogado, lo excluyo.
    const MEDIATION_WIDE_SAFE_TYPES = new Set([
      'MEDIATION_CREATED', 'MEDIATION_STATUS_CHANGED', 'MEDIATION_CLOSED',
      'HEARING_SCHEDULED', 'HEARING_CONFIRMATION_MISSING', 'HEARING_REMINDER',
    ]);
    const rawTimeline = db.mediationEvents.filter((e) => e.mediationId === mediation.id && e.visibility === 'public');
    const timeline = rawTimeline.filter((e) => {
      if (MEDIATION_WIDE_SAFE_TYPES.has(e.type)) return true;
      // tareas internas del mediador: nunca, sin excepción, sin importar de qué mediación
      if (e.type.startsWith('TASK_')) return false;
      // partes/abogados: solo si el evento es sobre la PROPIA parte/abogado
      if (e.type === 'PARTY_ADDED' || e.type === 'PARTY_INVITED') return e.entityId === party.id;
      if (e.type === 'LAWYER_ADDED' || e.type === 'LAWYER_INVITED') return e.entityId === req.lawyer.id;
      // documentos: solo si es un documento que el abogado también puede ver (general o de su parte)
      if (e.type === 'DOCUMENT_UPLOADED' || e.type === 'DOCUMENT_REVIEWED') {
        const doc = db.documents.find((d) => d.id === e.entityId);
        return doc && (doc.partyId === null || doc.partyId === party.id);
      }
      // compromisos: solo los de la parte representada
      if (e.type.startsWith('COMMITMENT_')) {
        const commitment = db.commitments.find((c) => c.id === e.entityId);
        return commitment && commitment.partyId === party.id;
      }
      // audiencias con nombre de parte en el título (confirmaciones): el
      // texto del evento puede nombrar a OTRA parte puntual, y hoy no hay
      // forma barata de verificar de cuál parte es sin guardar el partyId
      // en el propio evento — se excluye por seguridad en vez de arriesgar
      // filtrar la respuesta de otra parte. Ver "pendientes" en el reporte.
      if (e.type === 'HEARING_CONFIRMED') return false;
      // cualquier tipo no contemplado explícitamente: se excluye por
      // defecto, no se arriesga.
      return false;
    }).sort((a, b) => b.createdAt - a.createdAt)
      .map((e) => ({ id: e.id, type: e.type, title: e.title, description: e.description, createdAt: e.createdAt }));

    res.json({
      mediationCode: mediation.code, mediationObject: mediation.object, mediationStatus: mediation.status,
      partyName: partyDisplayName(db, party.id), allowDocumentUpload: party.allowDocumentUpload !== false,
      hearings, commitments, documents, timeline,
    });
  });

  // ---------- confirmar / pedir cambio de audiencia ----------
  router.post('/:token/mediations/:mediationId/hearings/:hearingId/confirm', portalLimiter, resolveLawyer, resolveLawyerMediation, async (req, res) => {
    const { response, reason, proposedDate, proposedStartTime } = req.body || {};
    if (!['confirma', 'no_puede', 'pide_cambio'].includes(response)) {
      return res.status(400).json({ error: 'Respuesta inválida' });
    }
    const db = getDB();
    // la confirmación es de la PARTE (misma fila que ya usa el Portal de
    // Partes) — el abogado actúa en su representación, no crea un
    // registro paralelo.
    const confirmation = db.hearingConfirmations.find(
      (c) => c.hearingId === req.params.hearingId && c.partyId === req.party.id
    );
    if (!confirmation) return res.status(404).json({ error: 'Confirmación no encontrada' });
    confirmation.response = response;
    confirmation.respondedAt = Date.now();
    const confirmEvent = logMediationEvent(db, {
      mediationId: req.mediation.id, type: 'HEARING_CONFIRMED', actorId: null,
      visibility: 'public', entityType: 'hearing', entityId: confirmation.hearingId,
      title: `${req.lawyer.name} (representando a ${partyDisplayName(db, req.party.id)}) respondió: ${response}`,
    });
    let rescheduleRequest = null;
    if (response === 'pide_cambio') {
      rescheduleRequest = {
        id: nanoid(), hearingId: req.params.hearingId, mediationId: req.mediation.id,
        requestedByPartyId: req.party.id, requestedByType: 'lawyer', requestedByLawyerId: req.lawyer.id,
        reason: reason || null, proposedDate: proposedDate || null, proposedStartTime: proposedStartTime || null,
        status: 'pendiente', mediatorNote: null, resolvedBy: null, resolvedAt: null, createdAt: Date.now(),
      };
      db.hearingRescheduleRequests.push(rescheduleRequest);
      logMediationEvent(db, {
        mediationId: req.mediation.id, type: 'HEARING_RESCHEDULE_REQUESTED', actorId: null,
        entityType: 'hearing_reschedule_request', entityId: rescheduleRequest.id,
        title: `${req.lawyer.name} pidió cambiar la audiencia`,
        description: reason || null, causedByEventId: confirmEvent.id,
      });
    }
    await commit();
    res.json({ id: confirmation.id, response: confirmation.response, rescheduleRequestId: rescheduleRequest ? rescheduleRequest.id : null });
  });

  // ---------- documentos ----------
  router.post('/:token/mediations/:mediationId/documents', portalLimiter, resolveLawyer, resolveLawyerMediation,
    (req, res, next) => {
      if (req.party.allowDocumentUpload === false) {
        return res.status(403).json({ error: 'El mediador no habilitó la carga de documentos para esta parte todavía' });
      }
      next();
    },
    (req, res, next) => {
      uploadLawyerDocument.single('file')(req, res, (err) => {
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
        title: `Documento subido por ${req.lawyer.name} (en representación de ${partyDisplayName(db, req.party.id)}): ${doc.originalFilename}`,
      });
      await commit();
      res.json({ id: doc.id, originalFilename: doc.originalFilename, type: doc.type, size: doc.size, createdAt: doc.createdAt });
    }
  );

  router.get('/:token/mediations/:mediationId/documents/:docId/download', portalLimiter, resolveLawyer, resolveLawyerMediation, (req, res) => {
    const db = getDB();
    const doc = db.documents.find((d) => d.id === req.params.docId && d.mediationId === req.mediation.id);
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });
    // documento -> mediación -> parte -> abogado autorizado, en ese orden
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

  // ---------- comunicaciones — solo lectura del hilo de la parte que representa ----------
  router.get('/:token/mediations/:mediationId/messages', portalLimiter, resolveLawyer, resolveLawyerMediation, (req, res) => {
    const db = getDB();
    const thread = db.channels.find((c) => c.mediationId === req.mediation.id && c.partyId === req.party.id);
    if (!thread) return res.json([]);
    const messages = db.messages.filter((m) => m.channelId === thread.id).sort((a, b) => a.createdAt - b.createdAt);
    res.json(messages.map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt, fromParty: m.senderId === req.party.linkedUserId })));
  });

  return router;
};
