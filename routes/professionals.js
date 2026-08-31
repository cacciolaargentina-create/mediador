// routes/professionals.js
// Autoregistro de mediador/a o estudio jurídico: a diferencia de la
// invitación que genera una parte desde su canal (routes/channels.js), acá
// es el profesional el que llega primero, sin ningún caso todavía, pide
// sumarse, y un admin de la plataforma lo aprueba o rechaza a mano desde
// /admin.html. Aprobar NO lo mete en ningún canal — solo lo marca como
// "profesional verificado" (user.verifiedProfessional), que hoy sirve para
// mostrarlo con esa marca y, más adelante, para un directorio público.

const express = require('express');
const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');
const { PROFESSIONAL_ROLE_LABELS } = require('../roles');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  next();
}

function serializeApplication(a) {
  return {
    id: a.id, role: a.role, roleLabel: PROFESSIONAL_ROLE_LABELS[a.role] || a.role,
    orgName: a.orgName, status: a.status, createdAt: a.createdAt, decidedAt: a.decidedAt || null,
  };
}

// estado de la propia solicitud (o null si nunca pidió) — para que el
// frontend sepa qué pantalla mostrar (form / "en revisión" / aprobado)
router.get('/me', requireAuth, (req, res) => {
  const db = getDB();
  const mine = db.professionalApplications
    .filter((a) => a.userId === req.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  res.json({
    verifiedProfessional: !!req.user.verifiedProfessional,
    verifiedProfessionalRole: req.user.verifiedProfessionalRole || null,
    verifiedProfessionalOrg: req.user.verifiedProfessionalOrg || null,
    application: mine ? serializeApplication(mine) : null,
  });
});

router.post('/apply', requireAuth, async (req, res) => {
  const { role, orgName } = req.body || {};
  if (!PROFESSIONAL_ROLE_LABELS[role]) return res.status(400).json({ error: 'Rol inválido' });
  if (!orgName || !orgName.trim()) return res.status(400).json({ error: 'Falta el nombre del estudio u organización' });

  const db = getDB();
  const existingPending = db.professionalApplications.find((a) => a.userId === req.user.id && a.status === 'pending');
  if (existingPending) return res.status(409).json({ error: 'Ya tenés una solicitud pendiente de revisión.' });

  const application = {
    id: nanoid(), userId: req.user.id, role, orgName: orgName.trim(),
    status: 'pending', createdAt: Date.now(), decidedAt: null, decidedBy: null,
  };
  db.professionalApplications.push(application);
  await commit();
  res.json(serializeApplication(application));
});

module.exports = router;
