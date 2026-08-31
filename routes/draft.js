// routes/draft.js
// Análisis de mensajes SIN canal — la pieza que baja la fricción de entrada:
// alguien puede probar el valor real (la reformulación) sin convencer a
// nadie más de sumarse todavía. Nada de esto se guarda en db.js — es
// explícitamente no persistente, un borrador de paso, no un mensaje de canal.
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { analyzeMessage } = require('../moderation');
const { requireQuotaOrSubscription } = require('../quota');

// mismo motivo que el rate limit de /:code/analyze: pega contra la API de
// Anthropic y cuesta plata por llamada. Acá SÍ corresponde limitar por IP en
// vez de por usuario — /demo no tiene sesión, no hay otro identificador.
// ipKeyGenerator normaliza IPv6 (si no, alguien podría rotar de dirección
// dentro del mismo /64 y saltarse el límite sin siquiera notarlo).
const demoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'Probaste demasiadas veces la demo — esperá un rato o iniciá sesión para seguir usándolo sin ese límite.' },
});

module.exports = function () {
  const router = express.Router();

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    next();
  }

  // Tarea A — modo borrador privado: requiere login (para que cuente
  // contra la cuota de ESE usuario, no la de cualquiera), pero no requiere
  // canal ni membresía. Mismo shape de respuesta que /:code/analyze.
  router.post('/analyze', requireAuth, requireQuotaOrSubscription, async (req, res) => {
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

  // Tarea B — demo pública para la landing: sin login, sin cuota de
  // usuario (no hay usuario), protegida solo por el rate limit de IP.
  router.post('/demo', demoLimiter, async (req, res) => {
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

  return router;
};
