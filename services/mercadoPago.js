// services/mercadoPago.js
// Bloque 29 — único punto de contacto con la API de Mercado Pago en todo el
// proyecto (§6: "no distribuir llamadas directas... por todo el
// proyecto"). Fetch nativo, sin SDK nuevo — la superficie que necesitamos
// (preapproval, payments) es chica y estable, y así se puede simular en
// tests sin depender de un mock de SDK de terceros.
//
// Modelo: "Suscripción SIN plan asociado, con pago pendiente"
// (developers.mercadopago.com/es/docs/subscriptions/integration-configuration/
// subscription-no-associated-plan/pending-payments, verificado 2026-09-28).
//
// CORRECCIÓN respecto al diseño original del Bloque 29 (dejar el rastro,
// no solo el resultado): la primera versión creaba un plan por API
// (/preapproval_plan) y después una suscripción referenciándolo — eso es
// el modelo "CON plan asociado", y la documentación oficial es explícita:
// "Una Suscripción con plan asociado siempre deberá ser creada con su
// card_token_id y en status Authorized". Eso implica tokenizar la tarjeta
// del lado del cliente (Checkout Bricks/MP.js) — lo opuesto al checkout
// 100% hosteado por Mercado Pago que se buscaba (nunca tocar datos de
// tarjeta, §24). Mezclar "con plan asociado" con status:"pending" sin
// card_token_id no es ninguno de los dos flujos que Mercado Pago
// documenta, y es la explicación más probable del bug externo conocido
// (mercadopago/sdk-nodejs#480: init_point con "&activation=true" roto)
// que estaba anotado acá — con el modelo correcto ("sin plan asociado,
// pago pendiente") esa combinación de parámetros nunca se da, así que la
// nota de riesgo se sacó (ver docs/MERCADOPAGO_SETUP.md para el detalle
// completo de la corrección).
//
// POST /preapproval SIN preapproval_plan_id, SIN card_token_id, con
// status:"pending" y el auto_recurring completo inline devuelve
// status:"pending" + init_point — el pagador completa el medio de pago en
// la página HOSTEADA de Mercado Pago (nunca tocamos datos de tarjeta,
// §24). El acceso real NUNCA se activa por este redirect (§8) — solo lo
// confirma syncSubscription() en billingService.js, llamado desde el
// webhook o la reconciliación.

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

// ---------- suscripciones (§6/§8) ----------
// "Sin plan asociado, con pago pendiente" — el auto_recurring completo va
// inline en cada suscripción (nunca un /preapproval_plan separado, ver la
// nota de corrección arriba). Nunca manda card_token_id ni status
// "authorized": el pagador define su medio de pago él mismo en la página
// hosteada de Mercado Pago, y la suscripción queda "pending" hasta que
// syncSubscription() (webhook o reconciliación) confirme el estado real.
async function createSubscription({ reason, price, currency, interval, freeTrialDays, payerEmail, externalReference, backUrl }) {
  const frequency_type = interval === 'year' ? 'years' : 'months';
  const body = {
    reason,
    external_reference: externalReference,
    payer_email: payerEmail,
    back_url: backUrl,
    status: 'pending',
    auto_recurring: {
      frequency: 1,
      frequency_type,
      transaction_amount: price,
      currency_id: currency || 'ARS',
      ...(freeTrialDays ? { free_trial: { frequency: freeTrialDays, frequency_type: 'days' } } : {}),
    },
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
  configured, createSubscription, getSubscription,
  cancelSubscription, updateSubscription, getPayment, verifyWebhookSignature,
};
