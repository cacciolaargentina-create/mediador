// quota.js
// Límite mensual de usos gratis de IA por usuario — sacado de adentro de
// routes/channels.js para que también lo pueda usar routes/draft.js (mismo
// patrón que ya se usó para sacar messaging.js). Sin sistema de pagos real
// todavía: hasActiveSubscription() siempre da false hoy — es el único lugar
// que hay que tocar el día que haya suscripciones pagas de verdad.

const { commit } = require('./db');

const FREE_TIER_MONTHLY_LIMIT = Number(process.env.FREE_TIER_MONTHLY_LIMIT) || 30;

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

function hasActiveSubscription(user) {
  return false;
}

// middleware: requiere req.user ya seteado (va después de requireAuth).
// Consume un uso del período gratis mensual antes de dejar pasar — mismo
// costo de IA sin importar si el análisis vino de un canal o de un borrador
// sin canal, así que tiene que contar contra el mismo límite en los dos casos.
async function requireQuotaOrSubscription(req, res, next) {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  if (hasActiveSubscription(user)) return next();

  const month = currentMonth();
  if (!user.aiUsage || user.aiUsage.month !== month) {
    user.aiUsage = { month, count: 0 };
  }
  if (user.aiUsage.count >= FREE_TIER_MONTHLY_LIMIT) {
    return res.status(429).json({
      error: `Llegaste al límite gratuito de ${FREE_TIER_MONTHLY_LIMIT} análisis de IA este mes — se reinicia el mes que viene.`,
      limitReached: true,
    });
  }
  user.aiUsage.count += 1;
  await commit();
  next();
}

module.exports = { requireQuotaOrSubscription, FREE_TIER_MONTHLY_LIMIT, currentMonth, hasActiveSubscription };
