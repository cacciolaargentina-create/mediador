// scripts/regression-test-bloque29-engine.js
// Bloque 29 (Billing + Mercado Pago) — tests directos de entitlements.js/
// billingService.js/services/mercadoPago.js, SIN pegarle nunca a la API
// real de Mercado Pago. services/mercadoPago.js se "monkey-patchea" en este
// mismo proceso (mismo módulo cacheado que usa billingService.js) para
// simular respuestas realistas — igual criterio que el fixture HTTP local
// del radar (Bloque 25): probar la lógica real, fingir solo el límite de
// red externo.
//
// Corre standalone contra una DB descartable propia (mismo patrón que
// regression-test-bloque22-automation-engine.js).

const path = require('path');
process.env.SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'test-b29-engine.sqlite');
process.env.BILLING_GRACE_PERIOD_DAYS = '7';

const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');
const entitlements = require('../entitlements');
const billingService = require('../billingService');
const mercadoPago = require('../services/mercadoPago');

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

function makeUser(db, overrides = {}) {
  const now = Date.now();
  const user = { id: nanoid(), googleId: 'g-' + nanoid(), email: `${nanoid(6)}@test.local`, name: 'Test User', avatar: '', createdAt: now, ...overrides };
  db.users.push(user);
  return user;
}
function makeMediation(db, mediatorUserId, closedAt = null) {
  const now = Date.now();
  const m = { id: nanoid(), code: `TEST-${nanoid(6)}`, mediatorUserId, channelId: null, type: null, object: 'Test', description: null, status: closedAt ? 'cerrada' : 'iniciada', nextActionText: null, nextActionResponsibleType: null, nextActionResponsibleId: null, nextActionDueDate: null, closedAt, closedResult: null, closedNotes: null, createdAt: now };
  db.mediations.push(m);
  return m;
}

(async function main() {
  console.log('Bloque 29 (Billing + Mercado Pago) — tests directos, sin red externa\n');
  const db = getDB();

  // ==== new DB / existing DB — seed de planes idempotente ====
  const seed1 = billingService.ensureBillingPlansSeeded(db);
  const seed2 = billingService.ensureBillingPlansSeeded(db);
  check('new DB: ensureBillingPlansSeeded crea los 3 planes la primera vez', seed1.created === 3, JSON.stringify(seed1));
  check('existing DB: correrlo de nuevo no duplica nada', seed2.created === 0 && db.billingPlans.length === 3, `billingPlans.length=${db.billingPlans.length}`);
  const freePlan = db.billingPlans.find((p) => p.code === 'FREE');
  const proPlan = db.billingPlans.find((p) => p.code === 'PROFESIONAL');
  check('el plan FREE tiene precio 0', freePlan.price === 0);
  await commit();

  // ==== 1. FREE account (sin fila en billing_accounts) ====
  const freeUser = makeUser(db);
  check('1. FREE: sin fila en billing_accounts, getEffectivePlanCode da FREE', entitlements.getEffectivePlanCode(db, freeUser) === 'FREE');
  check('1(b). FREE: entitlements da los límites del plan gratuito', entitlements.getEntitlements(db, freeUser).maxActiveMediations === 3);

  // ==== 19/20. entitlement enforcement — límite de mediaciones activas ====
  const m1 = makeMediation(db, freeUser.id);
  makeMediation(db, freeUser.id);
  makeMediation(db, freeUser.id);
  check('20. FREE con 3 mediaciones activas: canCreateMediation da false (límite)', entitlements.canCreateMediation(db, freeUser) === false);
  m1.closedAt = Date.now(); // cerrar una de las 3 — el activo count baja a 2
  check('20(b). una mediación CERRADA no cuenta contra el límite', entitlements.canCreateMediation(db, freeUser) === true, 'con solo 2 activas (una se cerró), debería volver a permitir crear');
  m1.closedAt = null; // restaurar para el resto de los tests de este usuario
  check('20(c). FREE nunca puede usar videoconferencias integradas', entitlements.canUseVideoMeetings(db, freeUser) === false);

  // ==== monkey-patch de services/mercadoPago.js — mismo módulo cacheado
  // que usa billingService.js, así que esto SÍ afecta las llamadas reales
  // de la lógica bajo test, sin tocar la red. ====
  // Bloque 29 (corrección) — createSubscription ya no manda
  // preapproval_plan_id: arma el auto_recurring inline en cada llamada
  // ("sin plan asociado, pago pendiente"). El fake de acá refleja la firma
  // real (reason/price/currency/interval/payerEmail/externalReference/
  // backUrl), sin card_token_id, con status:"pending" — mismo contrato
  // que services/mercadoPago.js#createSubscription.
  let createSubscriptionCalls = 0, cancelSubscriptionCalls = 0;
  const createSubscriptionArgs = []; // para poder auditar QUÉ se manda, no solo cuántas veces
  const FAKE_SUBSCRIPTIONS = {};
  mercadoPago.configured = () => true;
  mercadoPago.createSubscription = async (args) => {
    createSubscriptionCalls++;
    createSubscriptionArgs.push(args);
    const { currency, interval, payerEmail, externalReference } = args;
    const id = `fake-sub-${nanoid(6)}`;
    FAKE_SUBSCRIPTIONS[id] = { status: 'pending', date_created: new Date().toISOString(), next_payment_date: null };
    return { id, status: 'pending', init_point: `https://mercadopago.com/fake/${id}`, external_reference: externalReference };
  };
  mercadoPago.getSubscription = async (id) => FAKE_SUBSCRIPTIONS[id] || (() => { throw Object.assign(new Error('not found'), { status: 404 }); })();
  mercadoPago.cancelSubscription = async (id) => { cancelSubscriptionCalls++; if (FAKE_SUBSCRIPTIONS[id]) FAKE_SUBSCRIPTIONS[id].status = 'cancelled'; return { id, status: 'cancelled' }; };

  // ==== 2. create subscription ====
  const proUser = makeUser(db);
  makeMediation(db, proUser.id); // para poder probar más abajo que suspender/expirar NUNCA borra esto
  const sub1 = await billingService.startSubscription(db, proUser, 'PROFESIONAL');
  check('2. create subscription: cuenta local queda en "pending"', sub1.account.status === 'pending');
  check('2(b). create subscription: guarda el providerSubscriptionId', !!sub1.account.providerSubscriptionId);
  check('2(c). create subscription: devuelve el init_point de Mercado Pago', sub1.initPoint && sub1.initPoint.includes('mercadopago.com'));
  check('8. el acceso NO se activa solo por crear la suscripción — "pending" sigue dando FREE hasta que se confirme', entitlements.getEffectivePlanCode(db, proUser) === 'FREE');

  // Bloque 29 (corrección) — "sin plan asociado, con pago pendiente":
  // nunca se llama a un /preapproval_plan (esa función ni existe más en
  // services/mercadoPago.js), y cada suscripción manda su propio
  // auto_recurring completo, nunca un card_token_id ni un
  // preapproval_plan_id (eso es lo que exige el modelo "CON plan
  // asociado", que fue justo el que se descartó).
  const call1 = createSubscriptionArgs[0];
  check('createSubscription manda auto_recurring inline con los datos del plan', call1.price === 15000 && call1.currency === 'ARS' && call1.interval === 'month', JSON.stringify(call1));
  check('createSubscription NUNCA manda card_token_id', !('card_token_id' in call1) && !('cardTokenId' in call1));
  check('createSubscription NUNCA manda preapproval_plan_id / preapprovalPlanId', !('preapproval_plan_id' in call1) && !('preapprovalPlanId' in call1));
  check('mercadoPago.createPlan ya no existe (se sacó del módulo, no solo se dejó de llamar)', mercadoPago.createPlan === undefined);
  check('mercadoPago.getPlan ya no existe', mercadoPago.getPlan === undefined);

  // segunda suscripción (otro usuario) — cada una arma su propio
  // auto_recurring, no hay ningún plan que "reusar" del lado de MP.
  const proUser2 = makeUser(db);
  await billingService.startSubscription(db, proUser2, 'PROFESIONAL');
  check('createSubscription se llama una vez por cada suscripción nueva', createSubscriptionCalls === 2);
  check('la segunda llamada también arma su auto_recurring propio (no depende de un plan cacheado)', createSubscriptionArgs[1].price === 15000);

  // ==== 3. subscription authorized (sync) ====
  const subId1 = sub1.account.providerSubscriptionId;
  FAKE_SUBSCRIPTIONS[subId1] = { status: 'authorized', date_created: new Date().toISOString(), next_payment_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() };
  await billingService.syncSubscription(db, subId1);
  check('3. subscription authorized: la cuenta pasa a "active"', sub1.account.status === 'active');
  check('3(b). subscription authorized: se guarda currentPeriodEnd', !!sub1.account.currentPeriodEnd);
  check('9(implícito tras 3). con la suscripción activa, canUseVideoMeetings da true', entitlements.canUseVideoMeetings(db, proUser) === true);

  // ==== 18. invalid subscription — sync de un id que no es de ninguna cuenta nuestra ====
  FAKE_SUBSCRIPTIONS['huerfana-999'] = { status: 'authorized' };
  const orphanSync = await billingService.syncSubscription(db, 'huerfana-999');
  check('18. sync de una suscripción sin cuenta local asociada devuelve null, no rompe', orphanSync === null);

  // ==== 7. webhook duplicate — idempotencia ====
  check('setup: el evento todavía no fue procesado', billingService.alreadyProcessed(db, 'mercadopago', 'payment:pay-1') === false);
  billingService.recordEvent(db, { provider: 'mercadopago', eventId: 'payment:pay-1', eventType: 'payment', paymentId: 'pay-1', payload: { foo: 'bar' } });
  check('7. webhook duplicate: el mismo provider+eventId ya cuenta como procesado', billingService.alreadyProcessed(db, 'mercadopago', 'payment:pay-1') === true);
  check('7(b). un eventId DISTINTO no está afectado por el anterior', billingService.alreadyProcessed(db, 'mercadopago', 'payment:pay-2') === false);

  // ==== 6. payment pending — no cambia el estado comercial ====
  const pendingPayment = { id: 'pay-pending-1', transaction_amount: 15000, currency_id: 'ARS', status: 'pending', date_approved: null, preapproval_id: subId1 };
  billingService.recordPayment(db, pendingPayment, sub1.account);
  check('6. payment pending: se registra el pago', db.billingPayments.some((p) => p.providerPaymentId === 'pay-pending-1' && p.status === 'pending'));
  check('6(b). payment pending: el estado comercial de la cuenta NO cambia (sigue active)', sub1.account.status === 'active');

  // ==== 7(bis)/9. payment rejected → past_due ====
  const rejectedPayment = { id: 'pay-rejected-1', transaction_amount: 15000, currency_id: 'ARS', status: 'rejected', date_approved: null, preapproval_id: subId1 };
  billingService.recordPayment(db, rejectedPayment, sub1.account);
  check('payment rejected: la cuenta pasa a past_due', sub1.account.status === 'past_due');
  check('payment rejected: se guarda pastDueSince', !!sub1.account.pastDueSince);
  check('durante past_due (gracia), sigue teniendo acceso comercial pleno (§14)', entitlements.getEffectivePlanCode(db, proUser) === 'PROFESIONAL');

  // pago aprobado saca de la gracia
  const approvedPayment = { id: 'pay-approved-1', transaction_amount: 15000, currency_id: 'ARS', status: 'approved', date_approved: new Date().toISOString(), preapproval_id: subId1 };
  billingService.recordPayment(db, approvedPayment, sub1.account);
  check('payment approved tras un rechazo: la cuenta vuelve a active', sub1.account.status === 'active');
  check('payment approved: se limpia pastDueSince', sub1.account.pastDueSince === null);

  // ==== 8. grace period → suspended ====
  const gracePayment = { id: 'pay-rejected-2', transaction_amount: 15000, currency_id: 'ARS', status: 'rejected', preapproval_id: subId1 };
  billingService.recordPayment(db, gracePayment, sub1.account);
  sub1.account.pastDueSince = Date.now() - 8 * 24 * 60 * 60 * 1000; // hace 8 días — supera BILLING_GRACE_PERIOD_DAYS=7
  const maint1 = billingService.runBillingMaintenance(db);
  check('8. grace period vencido: la cuenta pasa a suspended', sub1.account.status === 'suspended');
  check('9. suspension: nunca se borra la mediación de esta cuenta', db.mediations.some((m) => m.mediatorUserId === proUser.id));
  check('suspended: el plan efectivo cae a FREE (acceso comercial limitado, no borrado)', entitlements.getEffectivePlanCode(db, proUser) === 'FREE');

  // reactivar el estado para seguir probando cancelación con una cuenta sana
  sub1.account.status = 'active';
  sub1.account.pastDueSince = null;

  // ==== 10. cancellation ====
  await billingService.requestCancellation(db, sub1.account);
  check('10. cancellation: cancelAtPeriodEnd queda en true', sub1.account.cancelAtPeriodEnd === true);
  check('10(b). cancellation: se cancela YA en Mercado Pago (corta cobros futuros)', cancelSubscriptionCalls === 1);
  check('10(c). cancellation: el acceso SIGUE activo hasta currentPeriodEnd (no corta de inmediato)', sub1.account.status === 'active');

  // ==== 12. reactivation (antes del vencimiento) ====
  billingService.reactivate(db, sub1.account);
  check('12. reactivation: se saca la marca de cancelación', sub1.account.cancelAtPeriodEnd === false);
  const maintAfterReactivate = billingService.runBillingMaintenance(db);
  check('12(b). tras reactivar, el mantenimiento NO la expira aunque el período ya haya pasado', sub1.account.status === 'active');

  // ==== 11. cancellation at period end (currentPeriodEnd ya pasó) ====
  await billingService.requestCancellation(db, sub1.account);
  sub1.account.currentPeriodEnd = Date.now() - 1000; // ya pasó
  const maint2 = billingService.runBillingMaintenance(db);
  check('11. cancellation at period end: al pasar currentPeriodEnd, la cuenta pasa a expired', sub1.account.status === 'expired');
  check('11(b). expired: nunca se borran mediaciones/usuarios', db.mediations.some((m) => m.mediatorUserId === proUser.id) && db.users.some((u) => u.id === proUser.id));

  // ==== 13. plan change ====
  const changeUser = makeUser(db);
  const changeSub = await billingService.startSubscription(db, changeUser, 'PROFESIONAL');
  FAKE_SUBSCRIPTIONS[changeSub.account.providerSubscriptionId] = { status: 'authorized', date_created: new Date().toISOString() };
  await billingService.syncSubscription(db, changeSub.account.providerSubscriptionId);
  check('setup plan change: cuenta activa en PROFESIONAL', changeSub.account.status === 'active' && changeSub.account.planCode === 'PROFESIONAL');
  await billingService.startSubscription(db, changeUser, 'ESTUDIO');
  check('13. plan change: la MISMA cuenta cambia de planCode (no se duplica)', db.billingAccounts.filter((a) => a.userId === changeUser.id).length === 1 && entitlements.getBillingAccount(db, changeUser).planCode === 'ESTUDIO');

  // ==== 4/5. canAddStudyMember respeta el plan del ESTUDIO, no del usuario ====
  const studioOwner = makeUser(db, { studioId: 'studio-test-1', studioRole: 'admin' });
  db.studios.push({ id: 'studio-test-1', name: 'Estudio Test', ownerId: studioOwner.id, status: 'activo', createdAt: Date.now() });
  check('estudio sin billing_accounts: se trata como FREE (maxStudyMembers=1)', entitlements.canAddStudyMember(db, studioOwner, 'studio-test-1') === false, 'ya hay 1 miembro (el owner), FREE permite 1 → false para sumar otro');
  // sin provider/providerSubscriptionId a propósito: esta cuenta es solo
  // para probar canAddStudyMember, no participa de la reconciliación (esa
  // solo mira cuentas con provider==='mercadopago').
  db.billingAccounts.push({ id: nanoid(), userId: null, studioId: 'studio-test-1', planCode: 'ESTUDIO', status: 'active', provider: null, providerSubscriptionId: null, currentPeriodStart: Date.now(), currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000, cancelAtPeriodEnd: false, trialEndsAt: null, pastDueSince: null, createdAt: Date.now(), updatedAt: Date.now() });
  check('con el estudio en plan ESTUDIO (miembros ilimitados), sí se puede sumar otro miembro', entitlements.canAddStudyMember(db, studioOwner, 'studio-test-1') === true);
  const memberOfStudio = makeUser(db, { studioId: 'studio-test-1', studioRole: 'mediador' });
  check('un miembro del estudio hereda el plan ESTUDIO vía la cuenta del estudio (no la propia)', entitlements.getEffectivePlanCode(db, memberOfStudio) === 'ESTUDIO');

  await commit();

  // ==== 14. reconciliation ====
  mercadoPago.configured = () => false;
  const billingJobs = require('../billingJobs');
  const reconcileNoConfig = await billingJobs.reconcileBillingSubscriptions();
  check('27/reconciliation: sin Mercado Pago configurado, no intenta nada (checked=0)', reconcileNoConfig.checked === 0);
  mercadoPago.configured = () => true;
  const reconcileUser = makeUser(db);
  const reconcileSub = await billingService.startSubscription(db, reconcileUser, 'PROFESIONAL');
  await commit();
  FAKE_SUBSCRIPTIONS[reconcileSub.account.providerSubscriptionId] = { status: 'authorized', date_created: new Date().toISOString(), next_payment_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() };
  const reconcileResult = await billingJobs.reconcileBillingSubscriptions();
  check('14. reconciliation: encuentra y sincroniza la cuenta pending → active', reconcileResult.checked >= 1 && reconcileResult.updated >= 1, JSON.stringify(reconcileResult));
  check('14(b). reconciliation: la cuenta reconciliada queda active de verdad', reconcileSub.account.status === 'active');

  // ==== 15. forged webhook — verifyWebhookSignature (crypto puro, sin red) ====
  const crypto = require('crypto');
  const secret = 'test-webhook-secret';
  const dataId = '123456789';
  const ts = Math.floor(Date.now() / 1000);
  const requestId = 'req-abc';
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const validV1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const validHeader = `ts=${ts},v1=${validV1}`;
  check('firma válida: verifyWebhookSignature da true', mercadoPago.verifyWebhookSignature({ xSignature: validHeader, xRequestId: requestId, dataId, secret }) === true);
  check('15. forged webhook: firma con otro secret da false', mercadoPago.verifyWebhookSignature({ xSignature: validHeader, xRequestId: requestId, dataId, secret: 'otro-secret' }) === false);
  check('15(b). forged webhook: sin header x-signature da false', mercadoPago.verifyWebhookSignature({ xSignature: null, xRequestId: requestId, dataId, secret }) === false);
  check('15(c). forged webhook: dataId distinto al firmado da false', mercadoPago.verifyWebhookSignature({ xSignature: validHeader, xRequestId: requestId, dataId: '999999999', secret }) === false);
  check('15(d). forged webhook: sin secret configurado nunca "falla abierto" (da false)', mercadoPago.verifyWebhookSignature({ xSignature: validHeader, xRequestId: requestId, dataId, secret: null }) === false);

  // ==== mapMercadoPagoSubscriptionStatus ====
  check('mapeo de estados: pending→pending', billingService.mapMercadoPagoSubscriptionStatus('pending') === 'pending');
  check('mapeo de estados: authorized→active', billingService.mapMercadoPagoSubscriptionStatus('authorized') === 'active');
  check('mapeo de estados: paused→suspended', billingService.mapMercadoPagoSubscriptionStatus('paused') === 'suspended');
  check('mapeo de estados: cancelled→cancelled', billingService.mapMercadoPagoSubscriptionStatus('cancelled') === 'cancelled');
  check('mapeo de estados: algo desconocido→inactive (nunca copia el string crudo)', billingService.mapMercadoPagoSubscriptionStatus('algo-random') === 'inactive');

  console.log(`\n${passed} OK, ${failed} FAIL de ${passed + failed}`);
  if (failed) { console.log('\nFallos:', failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
