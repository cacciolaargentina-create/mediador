// entitlements.js
// Bloque 29 (Billing + Mercado Pago) — capa de capacidades COMERCIALES.
// Los permisos de ACCESO A DATOS (quién puede ver/editar qué mediación)
// siguen dependiendo 100% de mediationAccess.js/roles.js — esto NUNCA
// decide eso. Solo decide qué funcionalidades comerciales están
// habilitadas según el plan de la cuenta. Nunca usar user.plan==='PRO'
// como mecanismo de autorización: todo pasa por canUse()/las funciones
// específicas de acá, que a su vez leen SIEMPRE billing_accounts.status ya
// sincronizado — nunca un campo de Mercado Pago directo.

// Límites/capacidades por plan — reglas de PRODUCTO, por eso viven en
// código (los PRECIOS, que sí son configurables sin tocar código, viven en
// billing_plans / DB, ver billingService.js).
const PLAN_ENTITLEMENTS = {
  FREE: {
    maxActiveMediations: 3, maxStudyMembers: 1, maxAssistants: 0,
    advancedAgenda: false, videoMeetings: false, automations: true,
    exports: true, partyPortal: true, lawyerPortal: true,
  },
  PROFESIONAL: {
    maxActiveMediations: Infinity, maxStudyMembers: 1, maxAssistants: 1,
    advancedAgenda: true, videoMeetings: true, automations: true,
    exports: true, partyPortal: true, lawyerPortal: true,
  },
  ESTUDIO: {
    maxActiveMediations: Infinity, maxStudyMembers: Infinity, maxAssistants: Infinity,
    advancedAgenda: true, videoMeetings: true, automations: true,
    exports: true, partyPortal: true, lawyerPortal: true,
  },
};

// estados que dan acceso comercial pleno al plan contratado. pending/
// past_due están en gracia (§14 de la spec: "durante el período de gracia:
// acceso normal, mostrar aviso") — billingJobs.js es quien decide cuándo
// past_due pasa a suspended, nunca esta capa. suspended/cancelled/expired/
// inactive (o sin fila) caen a FREE — nunca se borra nada, solo se limita
// el acceso comercial (§14).
// 'pending' (suscripción creada, esperando que Mercado Pago confirme la
// autorización) NUNCA da acceso — es exactamente el caso que la spec pide
// evitar explícitamente (§8: "NO activar Premium simplemente porque el
// usuario volvió de Mercado Pago"). Solo 'active' da acceso pleno;
// 'past_due' lo mantiene durante el período de gracia (§14).
const ACCESS_GRANTING_STATUSES = ['trial', 'active', 'past_due'];

// cuenta de billing EFECTIVA de esta persona: si pertenece a un estudio y
// el ESTUDIO tiene una cuenta (plan ESTUDIO cubre a todo el equipo), esa
// gana; si no, se busca su cuenta personal. Sin ninguna fila = FREE
// implícito — así una base existente nunca necesita backfill (§4/§29).
function getBillingAccount(db, user) {
  if (!user) return null;
  if (user.studioId) {
    const studioAccount = db.billingAccounts.find((a) => a.studioId === user.studioId);
    if (studioAccount) return studioAccount;
  }
  return db.billingAccounts.find((a) => a.userId === user.id) || null;
}

function getEffectivePlanCode(db, user) {
  const account = getBillingAccount(db, user);
  if (!account) return 'FREE';
  if (!ACCESS_GRANTING_STATUSES.includes(account.status)) return 'FREE';
  return account.planCode || 'FREE';
}

function getEntitlements(db, user) {
  const planCode = getEffectivePlanCode(db, user);
  return PLAN_ENTITLEMENTS[planCode] || PLAN_ENTITLEMENTS.FREE;
}

function canUse(db, user, capability) {
  return !!getEntitlements(db, user)[capability];
}

// §17 — paywall contextual: estas funciones son las que las rutas llaman
// ANTES de la acción real, para poder devolver un mensaje claro en vez de
// dejar que la acción falle de otra forma.
function canCreateMediation(db, user) {
  const ent = getEntitlements(db, user);
  if (ent.maxActiveMediations === Infinity) return true;
  const activeCount = db.mediations.filter((m) => !m.closedAt && m.mediatorUserId === user.id).length;
  return activeCount < ent.maxActiveMediations;
}
function canUseVideoMeetings(db, user) { return canUse(db, user, 'videoMeetings'); }
function canUseAdvancedAgenda(db, user) { return canUse(db, user, 'advancedAgenda'); }
function canAddStudyMember(db, user, studioId) {
  const studioAccount = db.billingAccounts.find((a) => a.studioId === studioId);
  const planCode = studioAccount && ACCESS_GRANTING_STATUSES.includes(studioAccount.status) ? studioAccount.planCode : 'FREE';
  const ent = PLAN_ENTITLEMENTS[planCode] || PLAN_ENTITLEMENTS.FREE;
  if (ent.maxStudyMembers === Infinity) return true;
  const memberCount = db.users.filter((u) => u.studioId === studioId).length;
  return memberCount < ent.maxStudyMembers;
}

module.exports = {
  PLAN_ENTITLEMENTS, ACCESS_GRANTING_STATUSES,
  getBillingAccount, getEffectivePlanCode, getEntitlements,
  canUse, canCreateMediation, canUseVideoMeetings, canUseAdvancedAgenda, canAddStudyMember,
};
