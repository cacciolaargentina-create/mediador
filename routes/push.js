// routes/push.js
const express = require('express');
const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');
const { pushConfigured } = require('../push');

module.exports = function () {
  const router = express.Router();

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    next();
  }

  // el frontend necesita esto para llamar pushManager.subscribe() — la
  // clave pública no es secreta, se puede servir sin problema.
  router.get('/vapid-public-key', (req, res) => {
    if (!pushConfigured() || !process.env.VAPID_PUBLIC_KEY) {
      return res.status(503).json({ error: 'Push todavía no está configurado en el servidor' });
    }
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
  });

  router.post('/subscribe', requireAuth, async (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Suscripción incompleta' });
    }
    const db = getDB();
    const existing = db.pushSubscriptions.find((s) => s.endpoint === endpoint);
    if (existing) {
      // el mismo endpoint puede volver a suscribirse (por ejemplo, el
      // navegador rota la clave) — se actualiza en vez de duplicar.
      existing.userId = req.user.id;
      existing.keys = keys;
    } else {
      db.pushSubscriptions.push({ id: nanoid(), userId: req.user.id, endpoint, keys, createdAt: Date.now() });
    }
    await commit();
    res.json({ ok: true });
  });

  router.post('/unsubscribe', requireAuth, async (req, res) => {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'Falta el endpoint' });
    const db = getDB();
    const idx = db.pushSubscriptions.findIndex((s) => s.endpoint === endpoint && s.userId === req.user.id);
    if (idx >= 0) { db.pushSubscriptions.splice(idx, 1); await commit(); }
    res.json({ ok: true });
  });

  return router;
};
