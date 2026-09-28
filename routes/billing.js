// routes/billing.js
// Bloque 29 — endpoints de billing para el propio mediador ("Mi Plan").
// Todo se resuelve SIEMPRE desde req.user — nunca desde un userId/studioId/
// accountId que venga en el body o la query (§23.5/§23.6/§23.9/§23.14/
// §23.15: nadie puede tocar el billing de otra cuenta). Ningún endpoint
// acepta status/providerSubscriptionId/price desde el cliente (§23.1-4):
// esos campos SOLO los escribe billingService.js, nunca una request.

const express = require('express');
const { getDB, commit } = require('../db');
const billingService = require('../billingService');
const { getBillingAccount, getEffectivePlanCode, getEntitlements } = require('../entitlements');

function serializeAccount(db, account) {
  if (!account) return { planCode: 'FREE', status: 'inactive', currentPeriodEnd: null, cancelAtPeriodEnd: false };
  return {
    planCode: account.planCode, status: account.status,
    currentPeriodStart: account.currentPeriodStart || null, currentPeriodEnd: account.currentPeriodEnd || null,
    cancelAtPeriodEnd: !!account.cancelAtPeriodEnd, trialEndsAt: account.trialEndsAt || null,
    pastDueSince: account.pastDueSince || null,
  };
}
function serializePlan(p) {
  return { id: p.id, code: p.code, name: p.name, description: p.description, price: p.price, currency: p.currency, interval: p.interval };
}
function serializePayment(p) {
  return { id: p.id, amount: p.amount, currency: p.currency, status: p.status, approvedAt: p.approvedAt, createdAt: p.createdAt };
}

module.exports = function () {
  const router = express.Router();

  function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    next();
  }
  router.use(requireAuth);

  // ---------- planes disponibles (§2/§16) ----------
  router.get('/plans', (req, res) => {
    const db = getDB();
    res.json(db.billingPlans.filter((p) => p.active).map(serializePlan));
  });

  // ---------- mi cuenta de billing (§16) ----------
  router.get('/me', (req, res) => {
    const db = getDB();
    const account = getBillingAccount(db, req.user);
    const planCode = getEffectivePlanCode(db, req.user);
    const entitlements = getEntitlements(db, req.user);
    res.json({
      account: serializeAccount(db, account),
      effectivePlanCode: planCode,
      entitlements,
      mercadoPagoConfigured: require('../services/mercadoPago').configured(),
    });
  });

  // ---------- iniciar suscripción (§8) ----------
  router.post('/subscribe', async (req, res) => {
    const { planCode } = req.body || {};
    if (!planCode) return res.status(400).json({ error: 'Falta el plan elegido' });
    const db = getDB();
    try {
      const { initPoint } = await billingService.startSubscription(db, req.user, planCode);
      await commit();
      res.json({ initPoint });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'No se pudo iniciar la suscripción' });
    }
  });

  // ---------- cancelar (al final del período, §15) ----------
  router.post('/cancel', async (req, res) => {
    const db = getDB();
    const account = getBillingAccount(db, req.user);
    if (!account || account.planCode === 'FREE') {
      return res.status(400).json({ error: 'No tenés una suscripción activa para cancelar' });
    }
    try {
      await billingService.requestCancellation(db, account);
      await commit();
      res.json(serializeAccount(db, account));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'No se pudo cancelar la suscripción' });
    }
  });

  // ---------- reactivar antes del vencimiento (§15) ----------
  router.post('/reactivate', async (req, res) => {
    const db = getDB();
    const account = getBillingAccount(db, req.user);
    if (!account || !account.cancelAtPeriodEnd) {
      return res.status(400).json({ error: 'Esta cuenta no tiene una cancelación pendiente' });
    }
    billingService.reactivate(db, account);
    await commit();
    res.json(serializeAccount(db, account));
  });

  // ---------- historial de pagos (§19) ----------
  router.get('/payments', (req, res) => {
    const db = getDB();
    const account = getBillingAccount(db, req.user);
    if (!account) return res.json([]);
    const payments = db.billingPayments
      .filter((p) => p.billingAccountId === account.id)
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json(payments.map(serializePayment));
  });

  return router;
};
