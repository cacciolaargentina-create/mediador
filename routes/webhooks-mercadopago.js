// routes/webhooks-mercadopago.js
// Bloque 29 §10 — único endpoint público para notificaciones de Mercado
// Pago. Sin login (no puede pedirlo: lo llama Mercado Pago, no un usuario).
// Mismo patrón que routes/whatsapp.js: rate limit + validación de firma +
// idempotencia + nunca confiar en el body, siempre volver a consultar el
// recurso real antes de procesar nada.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { getDB, commit } = require('../db');
const mercadoPago = require('../services/mercadoPago');
const billingService = require('../billingService');
const { logAudit } = require('../audit');

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
});

// Mercado Pago usa varios nombres de "type"/"topic" según la versión de la
// integración y qué se suscribió en el panel — se acepta cualquiera de los
// alias conocidos para cada categoría, en vez de fallar por un string que
// no coincide exacto (verificar contra el panel real antes de producción,
// ver docs/MERCADOPAGO_SETUP.md).
const SUBSCRIPTION_TYPES = ['subscription_preapproval', 'preapproval'];
const PAYMENT_TYPES = ['payment', 'subscription_authorized_payment'];

module.exports = function () {
  const router = express.Router();

  router.post('/', webhookLimiter, async (req, res) => {
    const db = getDB();
    const type = req.query.type || req.body?.type || req.body?.action || null;
    const dataId = req.query['data.id'] || req.body?.data?.id || req.body?.id || null;
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];

    // nada identificable para procesar — se responde 200 igual (evita que
    // Mercado Pago reintente algo que nunca vamos a poder resolver).
    if (!dataId) return res.status(200).json({ ok: true });

    const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
    const valid = mercadoPago.verifyWebhookSignature({ xSignature, xRequestId, dataId, secret });
    if (!valid) {
      console.warn('Firma de webhook de Mercado Pago inválida o ausente — notificación descartada.');
      return res.status(401).json({ error: 'Firma inválida' });
    }

    // idempotencia (§11): tipo+id del recurso, no x-request-id (Mercado
    // Pago puede reintentar la MISMA notificación con un x-request-id
    // distinto en cada intento de entrega).
    const eventId = `${type || 'unknown'}:${dataId}`;
    if (billingService.alreadyProcessed(db, 'mercadopago', eventId)) {
      return res.status(200).json({ ok: true, duplicate: true });
    }

    try {
      if (SUBSCRIPTION_TYPES.includes(type)) {
        const account = billingService.findAccountBySubscriptionId(db, dataId);
        if (account) {
          const before = account.status;
          await billingService.syncSubscription(db, dataId);
          logAudit(db, { actorId: null, action: 'subscription_authorized', channelCode: null, meta: { subscriptionId: dataId, before, after: account.status } });
        }
        billingService.recordEvent(db, { provider: 'mercadopago', eventId, eventType: type, subscriptionId: dataId, payload: req.body });
      } else if (PAYMENT_TYPES.includes(type)) {
        // nunca se confía en el body: se vuelve a pedir el pago real (§10).
        const mpPayment = await mercadoPago.getPayment(dataId);
        const subscriptionId = mpPayment.preapproval_id || null;
        const account = subscriptionId ? billingService.findAccountBySubscriptionId(db, subscriptionId) : null;
        if (account) {
          billingService.recordPayment(db, mpPayment, account);
          logAudit(db, { actorId: null, action: `payment_${mpPayment.status}`, channelCode: null, meta: { paymentId: dataId, subscriptionId, billingAccountId: account.id } });
        }
        billingService.recordEvent(db, { provider: 'mercadopago', eventId, eventType: type, paymentId: dataId, subscriptionId, payload: req.body });
      } else {
        billingService.recordEvent(db, { provider: 'mercadopago', eventId, eventType: type || 'unknown', payload: req.body, status: 'ignored' });
      }
      await commit();
      res.status(200).json({ ok: true });
    } catch (e) {
      // §22 — un fallo acá NUNCA se reintenta en loop contra nosotros: se
      // responde 200 igual, y la reconciliación periódica es el respaldo
      // ante justamente este caso (error temporal, caída, etc). No se marca
      // el evento como procesado — un reintento legítimo de Mercado Pago sí
      // vuelve a intentar esto.
      console.error('Error procesando webhook de Mercado Pago:', e.message);
      res.status(200).json({ ok: false });
    }
  });

  return router;
};
