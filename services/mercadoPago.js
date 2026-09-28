// services/mercadoPago.js
// Bloque 29 — único punto de contacto con la API de Mercado Pago en todo el
// proyecto (§6: "no distribuir llamadas directas... por todo el
// proyecto"). Fetch nativo, sin SDK nuevo — la superficie que necesitamos
// (preapproval_plan, preapproval, payments) es chica y estable, y así se
// puede simular en tests sin depender de un mock de SDK de terceros.
//
// Referencia verificada contra la documentación oficial vigente (Suscripciones
// con plan asociado, developers.mercadopago.com, revisado 2026-09-18):
// POST /preapproval_plan crea el plan (id de respuesta = preapproval_plan_id).
// POST /preapproval con preapproval_plan_id, SIN card_token_id y SIN
// status:"authorized" devuelve status "pending" + init_point — el pagador
// completa el medio de pago en la página HOSTEADA de Mercado Pago (nunca
// tocamos datos de tarjeta, §24). El acceso real NUNCA se activa por este
// redirect (§8) — solo lo confirma syncSubscription() en billingService.js,
// llamado desde el webhook o la reconciliación.
//
// NOTA DE RIESGO EXTERNO (dejar documentado, no ocultarlo): al momento de
// esta implementación hay un issue abierto en el SDK oficial (mercadopago/
// sdk-nodejs#480, reportado 2026-09-02) donde el init_point de una
// suscripción sin plan/pago pendiente agrega "&activation=true" y rompe en
// la web de Mercado Pago. Afecta el LADO DE MERCADO PAGO, no este código —
// hay que verificarlo contra el sandbox real antes de depender de este flujo
// en producción (ver docs/MERCADOPAGO_SETUP.md).

const crypto = require('crypto');

const BASE_URL = 'https://api.mercadopago.com';

function accessToken() {
  return process.env.MERCADOPAGO_ACCESS_TOKEN || null;
}

// §27 — FREE tiene que funcionar sin esto configurado. Todo el resto del
// módulo asume que quien llama ya chequeó configured() antes.
function configured() {
  return !!accessToken();
}

async function mpFetch(path, opts = {}) {
  if (!configured()) {
    throw new Error('Mercado Pago no está configurado (falta MERCADOPAGO_ACCESS_TOKEN)');
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken()}`,
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // nunca loguear el access token — el error solo lleva el body de MP.
    const err = new Error(body.message || `Mercado Pago respondió ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---------- planes (§2/§6) ----------
async function createPlan({ reason, price, currency, interval, backUrl, freeTrialDays }) {
  const frequency_type = interval === 'year' ? 'years' : 'months';
  const body = {
    reason,
    auto_recurring: {
      frequency: 1,
      frequency_type,
      transaction_amount: price,
      currency_id: currency || 'ARS',
      ...(freeTrialDays ? { free_trial: { frequency: freeTrialDays, frequency_type: 'days' } } : {}),
    },
    back_url: backUrl,
  };
  return mpFetch('/preapproval_plan', { method: 'POST', body: JSON.stringify(body) });
}
async function getPlan(id) {
  return mpFetch(`/preapproval_plan/${id}`);
}

// ---------- suscripciones (§6/§8) ----------
async function createSubscription({ preapprovalPlanId, payerEmail, externalReference, backUrl }) {
  const body = {
    preapproval_plan_id: preapprovalPlanId,
    reason: 'Suscripción Mediador',
    external_reference: externalReference,
    payer_email: payerEmail,
    back_url: backUrl,
    status: 'pending',
  };
  return mpFetch('/preapproval', { method: 'POST', body: JSON.stringify(body) });
}
async function getSubscription(id) {
  return mpFetch(`/preapproval/${id}`);
}
// cancela YA en Mercado Pago (corta cobros futuros de inmediato) — el
// acceso local sigue vivo hasta currentPeriodEnd vía cancelAtPeriodEnd, ver
// billingService.js. No existe en la API de MP un "cancelar al final del
// período" nativo para preapproval; se emula acá.
async function cancelSubscription(id) {
  return mpFetch(`/preapproval/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) });
}
async function updateSubscription(id, data) {
  return mpFetch(`/preapproval/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

// ---------- pagos (§13) ----------
async function getPayment(id) {
  return mpFetch(`/v1/payments/${id}`);
}

// ---------- webhook (§10/§11) ----------
// Validación oficial vigente: header "x-signature: ts=...,v1=..." — manifest
// "id:{dataId};request-id:{requestId};ts:{ts};" firmado HMAC-SHA256 con el
// secret del panel (MERCADOPAGO_WEBHOOK_SECRET). Esto SOLO confirma que la
// notificación es genuina — nunca decide nada por sí sola; la lógica real
// siempre vuelve a consultar el recurso (getSubscription/getPayment), nunca
// confía en el body del webhook (§10).
function verifyWebhookSignature({ xSignature, xRequestId, dataId, secret }) {
  if (!secret || !xSignature || !dataId) return false;
  const parts = {};
  for (const piece of xSignature.split(',')) {
    const [k, v] = piece.trim().split('=');
    if (k && v) parts[k] = v;
  }
  const { ts, v1 } = parts;
  if (!ts || !v1) return false;
  const manifest = `id:${dataId};request-id:${xRequestId || ''};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(v1, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false; // formato inesperado — nunca falla "abierto"
  }
}

module.exports = {
  configured, createPlan, getPlan, createSubscription, getSubscription,
  cancelSubscription, updateSubscription, getPayment, verifyWebhookSignature,
};
