// billingService.js
// Bloque 29 — orquestación comercial. El webhook (routes/webhooks.js) y los
// jobs (billingJobs.js) llaman a estas funciones; NUNCA contienen la lógica
// comercial ellos mismos (§12: "el webhook NO debe contener toda la lógica
// comercial"). Todo lo que decide "¿esta cuenta tiene acceso ahora?" pasa
// por acá, nunca por un status crudo de Mercado Pago.

const crypto = require('crypto');
const { nanoid } = require('nanoid');
const mercadoPago = require('./services/mercadoPago');
const { logAudit } = require('./audit');
const { getBillingAccount: getEffectiveBillingAccount } = require('./entitlements');

const GRACE_PERIOD_DAYS = Number(process.env.BILLING_GRACE_PERIOD_DAYS) || 7;

// §5 — traduce el estado EXTERNO de la suscripción (Mercado Pago) al estado
// INTERNO de Mediador. Nunca se copian los estados de MP directo a
// billing_accounts.status — todo pasa por acá.
function mapMercadoPagoSubscriptionStatus(mpStatus) {
  switch (mpStatus) {
    case 'pending': return 'pending';
    case 'authorized': return 'active';
    case 'paused': return 'suspended';
    case 'cancelled': return 'cancelled';
    default: return 'inactive';
  }
}

function externalReferenceFor(user) {
  return user.studioId ? `MEDIADOR-STUDIO-${user.studioId}` : `MEDIADOR-USER-${user.id}`;
}

function findAccountBySubscriptionId(db, subscriptionId) {
  return db.billingAccounts.find((a) => a.providerSubscriptionId === subscriptionId) || null;
}

// §9 — arma una cuenta local nueva o reusa la existente del usuario/estudio.
function getOrCreateAccount(db, user) {
  let account = getEffectiveBillingAccount(db, user);
  if (account) return account;
  const now = Date.now();
  account = {
    id: nanoid(), userId: user.studioId ? null : user.id, studioId: user.studioId || null,
    planCode: 'FREE', status: 'inactive', provider: null, providerCustomerId: null,
    providerSubscriptionId: null, currentPeriodStart: null, currentPeriodEnd: null,
    cancelAtPeriodEnd: false, trialEndsAt: null, pastDueSince: null, createdAt: now, updatedAt: now,
  };
  db.billingAccounts.push(account);
  return account;
}

// §8 — inicia el flujo de suscripción. NUNCA activa el plan acá: la cuenta
// queda en 'pending' hasta que el webhook (o la reconciliación) confirme el
// estado real vía syncSubscription().
async function startSubscription(db, user, planCode) {
  if (planCode === 'FREE') {
    const err = new Error('El plan gratuito no requiere suscripción');
    err.status = 400;
    throw err;
  }
  const plan = db.billingPlans.find((p) => p.code === planCode && p.active);
  if (!plan) {
    const err = new Error('Plan inválido');
    err.status = 400;
    throw err;
  }
  if (!mercadoPago.configured()) {
    const err = new Error('Mercado Pago no está configurado todavía');
    err.status = 503;
    throw err;
  }

  // CORRECCIÓN (ver la nota en services/mercadoPago.js): acá antes se creaba
  // un /preapproval_plan y se cacheaba su id en plan.providerPlanId para
  // reusarlo. Ese era el modelo "CON plan asociado", que la doc oficial de
  // Mercado Pago exige crear con card_token_id + status:"authorized" —
  // incompatible con el checkout 100% hosteado que busca este bloque. Ahora
  // es "SIN plan asociado, con pago pendiente": el auto_recurring completo
  // va inline en cada llamada a createSubscription, nunca un plan aparte.
  // billing_plans sigue siendo el catálogo interno de precios/entitlements
  // tal cual — providerPlanId queda en el schema sin usarse (nunca se
  // escribe), no se migró la columna por no justificar el riesgo de una
  // migración para un campo que simplemente queda en null.
  const externalReference = externalReferenceFor(user);
  const mpSub = await mercadoPago.createSubscription({
    reason: plan.name, price: plan.price, currency: plan.currency, interval: plan.interval,
    payerEmail: user.email, externalReference, backUrl: process.env.MERCADOPAGO_RETURN_URL,
  });

  const account = getOrCreateAccount(db, user);
  const now = Date.now();
  account.planCode = planCode;
  account.status = 'pending';
  account.provider = 'mercadopago';
  account.providerSubscriptionId = mpSub.id;
  account.cancelAtPeriodEnd = false;
  account.updatedAt = now;

  logAudit(db, { actorId: user.id, action: 'billing_subscription_created', channelCode: null, meta: { planCode, providerSubscriptionId: mpSub.id, externalReference } });
  return { account, initPoint: mpSub.init_point || null, externalReference };
}

// §12 — función central de sincronización. Consulta Mercado Pago, interpreta
// el estado, actualiza billing_accounts/período/cancelación. NO pisa un
// past_due DERIVADO DE UN PAGO rechazado (§13: suscripción != pago) con un
// "active" que Mercado Pago sigue informando para la suscripción en sí —
// el pago es lo que manda mientras la suscripción siga autorizada.
//
// Revisado tras la corrección del modelo (createSubscription ya no manda
// preapproval_plan_id): esto NO necesitó ningún cambio. GET /preapproval/:id
// devuelve el mismo `status` (pending/authorized/paused/cancelled) esté o
// no asociada a un plan — el paso pending→authorized cuando el pagador
// completa el medio de pago en la página hosteada llega igual por acá,
// disparado por el webhook (subscription_preapproval) o la reconciliación.
async function syncSubscription(db, subscriptionId) {
  const mpSub = await mercadoPago.getSubscription(subscriptionId);
  const account = findAccountBySubscriptionId(db, subscriptionId);
  if (!account) return null; // no es una suscripción nuestra — el caller decide qué hacer
  const mappedStatus = mapMercadoPagoSubscriptionStatus(mpSub.status);
  const wasPastDue = account.status === 'past_due';
  if (!(wasPastDue && mappedStatus === 'active')) {
    account.status = mappedStatus;
  }
  if (mpSub.date_created) account.currentPeriodStart = new Date(mpSub.date_created).getTime();
  if (mpSub.next_payment_date) account.currentPeriodEnd = new Date(mpSub.next_payment_date).getTime();
  account.updatedAt = Date.now();
  return account;
}

// §13 — registra un pago y aplica las reglas de negocio de pago (nunca de
// suscripción): aprobado saca de gracia, rechazado ENTRA en gracia (nunca
// corta el acceso de inmediato — eso lo decide runBillingMaintenance
// después de BILLING_GRACE_PERIOD_DAYS, §14). Idempotente por
// providerPaymentId (además de la idempotencia de billing_events por
// provider+eventId, que ya evita llegar acá dos veces para el mismo evento).
function recordPayment(db, mpPayment, billingAccount) {
  const now = Date.now();
  let payment = db.billingPayments.find((p) => p.providerPaymentId === String(mpPayment.id));
  if (!payment) {
    payment = {
      id: nanoid(), billingAccountId: billingAccount.id, provider: 'mercadopago',
      providerPaymentId: String(mpPayment.id), subscriptionId: mpPayment.preapproval_id || billingAccount.providerSubscriptionId || null,
      amount: mpPayment.transaction_amount, currency: mpPayment.currency_id, status: mpPayment.status,
      approvedAt: mpPayment.date_approved ? new Date(mpPayment.date_approved).getTime() : null,
      paidAt: mpPayment.status === 'approved' ? now : null, createdAt: now, updatedAt: now,
    };
    db.billingPayments.push(payment);
  } else {
    payment.status = mpPayment.status;
    payment.approvedAt = mpPayment.date_approved ? new Date(mpPayment.date_approved).getTime() : payment.approvedAt;
    payment.updatedAt = now;
  }

  if (mpPayment.status === 'approved' && billingAccount.status === 'past_due') {
    billingAccount.status = 'active';
    billingAccount.pastDueSince = null;
  } else if (mpPayment.status === 'rejected' && billingAccount.status === 'active') {
    billingAccount.status = 'past_due';
    billingAccount.pastDueSince = now;
  }
  billingAccount.updatedAt = now;
  return payment;
}

// §15 — cancelar YA en Mercado Pago (corta cobros futuros de inmediato),
// pero el acceso local sigue hasta currentPeriodEnd — runBillingMaintenance
// es quien pasa la cuenta a 'expired' cuando ese período realmente termina.
// Esto es también lo que permite reactivar antes del vencimiento sin crear
// una suscripción nueva de cero: si todavía no se llegó a currentPeriodEnd,
// alcanza con sacar cancelAtPeriodEnd.
async function requestCancellation(db, account) {
  if (account.provider === 'mercadopago' && account.providerSubscriptionId && mercadoPago.configured()) {
    await mercadoPago.cancelSubscription(account.providerSubscriptionId);
  }
  account.cancelAtPeriodEnd = true;
  account.updatedAt = Date.now();
  return account;
}
function reactivate(db, account) {
  account.cancelAtPeriodEnd = false;
  account.updatedAt = Date.now();
  return account;
}

// §14/§15 — mantenimiento periódico, puro y testeable (sin red): past_due
// que superó el período de gracia pasa a suspended; cuentas marcadas para
// cancelar cuyo período ya terminó pasan a expired. NUNCA borra datos —
// solo cambia el estado de acceso comercial.
function runBillingMaintenance(db, now = Date.now()) {
  const suspendedAccounts = [];
  const expiredAccounts = [];
  for (const account of db.billingAccounts) {
    if (account.status === 'past_due' && account.pastDueSince && now - account.pastDueSince > GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000) {
      account.status = 'suspended';
      account.updatedAt = now;
      suspendedAccounts.push(account);
    }
    if (account.cancelAtPeriodEnd && account.currentPeriodEnd && account.currentPeriodEnd < now && !['cancelled', 'expired'].includes(account.status)) {
      account.status = 'expired';
      account.updatedAt = now;
      expiredAccounts.push(account);
    }
  }
  return { suspendedAccounts, expiredAccounts };
}

// §11 — idempotencia. provider+eventId también es UNIQUE en SQLite (defensa
// en profundidad ante dos webhooks casi simultáneos), pero este chequeo
// evita siquiera intentar reprocesar antes de tocar nada más.
function alreadyProcessed(db, provider, eventId) {
  return db.billingEvents.some((e) => e.provider === provider && e.eventId === eventId);
}
function recordEvent(db, { provider, eventId, eventType, subscriptionId, paymentId, payload, status }) {
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
  const event = {
    id: nanoid(), provider, eventId, eventType,
    subscriptionId: subscriptionId || null, paymentId: paymentId || null,
    payloadHash, status: status || 'processed', processedAt: Date.now(), createdAt: Date.now(),
  };
  db.billingEvents.push(event);
  return event;
}

// §2 — carga inicial de planes, idempotente (nunca duplica si ya existen).
// Los PRECIOS salen de env vars para no hardcodearlos ni en el frontend ni
// acá mismo — quien despliega los ajusta sin tocar código. Se llama una vez
// al arrancar el server (ver server.js), funciona igual en una base nueva o
// existente.
function ensureBillingPlansSeeded(db) {
  const now = Date.now();
  const DEFAULTS = [
    { code: 'FREE', name: 'Gratuito', description: 'Para empezar — hasta 3 mediaciones activas.', price: 0 },
    { code: 'PROFESIONAL', name: 'Profesional', description: 'Mediaciones ilimitadas, agenda avanzada, videoconferencias.', price: Number(process.env.BILLING_PRICE_PROFESIONAL) || 15000 },
    { code: 'ESTUDIO', name: 'Estudio', description: 'Todo lo de Profesional, para equipos sin límite de miembros.', price: Number(process.env.BILLING_PRICE_ESTUDIO) || 35000 },
  ];
  let created = 0;
  for (const d of DEFAULTS) {
    if (db.billingPlans.some((p) => p.code === d.code)) continue;
    db.billingPlans.push({
      id: nanoid(), code: d.code, name: d.name, description: d.description,
      price: d.price, currency: 'ARS', interval: 'month', active: true,
      providerPlanId: null, createdAt: now, updatedAt: now,
    });
    created++;
  }
  return { created };
}

module.exports = {
  GRACE_PERIOD_DAYS,
  ensureBillingPlansSeeded,
  mapMercadoPagoSubscriptionStatus, externalReferenceFor, findAccountBySubscriptionId,
  getOrCreateAccount, startSubscription, syncSubscription, recordPayment,
  requestCancellation, reactivate, runBillingMaintenance,
  alreadyProcessed, recordEvent,
};
