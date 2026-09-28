// billingJobs.js
// Bloque 29 §22 — reconciliación periódica + mantenimiento de billing.
// Respaldo ante webhook perdido, error temporal o caída del servidor: sin
// esto, una suscripción cuyo webhook nunca llegó quedaría en 'pending' para
// siempre. No hace consultas innecesarias — solo revisa cuentas que
// realmente tienen una suscripción de Mercado Pago activa/pendiente.

const { getDB, commit } = require('./db');
const mercadoPago = require('./services/mercadoPago');
const billingService = require('./billingService');
const { logAudit } = require('./audit');

// solo reconciliar cuentas en estados donde el estado real puede haber
// cambiado sin que nos enteráramos — nunca cuentas ya terminales
// (cancelled/expired) ni FREE (planCode==='FREE' nunca tiene suscripción).
const RECONCILIABLE_STATUSES = ['pending', 'active', 'past_due', 'suspended'];

async function reconcileBillingSubscriptions() {
  if (!mercadoPago.configured()) return { checked: 0, updated: 0 }; // §27 — sin Mercado Pago configurado, nada que reconciliar
  const db = getDB();
  const candidates = db.billingAccounts.filter((a) => a.provider === 'mercadopago' && a.providerSubscriptionId && RECONCILIABLE_STATUSES.includes(a.status));
  let checked = 0, updated = 0;
  for (const account of candidates) {
    try {
      const before = account.status;
      await billingService.syncSubscription(db, account.providerSubscriptionId);
      checked++;
      if (account.status !== before) {
        updated++;
        logAudit(db, { actorId: null, action: 'subscription_updated', channelCode: null, meta: { subscriptionId: account.providerSubscriptionId, before, after: account.status, source: 'reconciliation' } });
      }
    } catch (e) {
      console.error(`Error reconciliando suscripción ${account.providerSubscriptionId}:`, e.message);
    }
  }
  if (updated > 0) await commit();
  return { checked, updated };
}

// §14/§15 — grace period → suspended, y cancelAtPeriodEnd vencido → expired.
// Puro en billingService.js; acá solo se dispara el efecto de red (cancelar
// de verdad en Mercado Pago cuando una cuenta recién quedó 'expired') y la
// auditoría — nunca al revés.
async function runBillingMaintenance() {
  const db = getDB();
  const { suspendedAccounts, expiredAccounts } = billingService.runBillingMaintenance(db);
  for (const account of suspendedAccounts) {
    logAudit(db, { actorId: null, action: 'billing_suspended', channelCode: null, meta: { billingAccountId: account.id, planCode: account.planCode } });
  }
  for (const account of expiredAccounts) {
    logAudit(db, { actorId: null, action: 'subscription_cancelled', channelCode: null, meta: { billingAccountId: account.id, planCode: account.planCode, reason: 'cancelAtPeriodEnd' } });
  }
  if (suspendedAccounts.length || expiredAccounts.length) await commit();
  return { suspended: suspendedAccounts.length, expired: expiredAccounts.length };
}

module.exports = { reconcileBillingSubscriptions, runBillingMaintenance };
