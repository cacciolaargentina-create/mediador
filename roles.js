// roles.js
// Quién es "admin de la plataforma" — compartido entre routes/admin.js y
// cualquier otra ruta que necesite ese chequeo (ej. notas privadas de caso
// en routes/channels.js). Separado en su propio módulo para no crear un
// require circular entre admin.js y channels.js.

const { getDB } = require('./db');
const { logAudit } = require('./audit');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isAdminUser(user) {
  return !!user && !!user.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
}

// admin de ESTUDIO (gestiona SU estudio) — concepto totalmente distinto de
// isAdminUser (admin de PLATAFORMA, por ADMIN_EMAILS). Nunca confundir uno
// con otro: un admin de estudio jamás debe poder entrar al Admin Console
// de plataforma, y viceversa un admin de plataforma no "hereda" nada de
// esto (ya tiene acceso propio, más amplio, vía isAdminUser).
function isStudyAdmin(user) {
  return !!user && !!user.studioId && user.studioRole === 'admin';
}

// Bloque 29 (Admin Console 2.0) §2 — middleware centralizado para TODAS las
// rutas de plataforma (antes cada router se armaba su propio requireAdmin
// local). "La autorización debe estar centralizada" (spec): un solo lugar
// que decide quién es admin de plataforma, nunca el frontend, nunca
// duplicado ruta por ruta.
function requirePlatformAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  if (!isAdminUser(req.user)) {
    // Log de Seguridad (Bloque 29 §16) — alguien autenticado intentó entrar
    // al centro de control de plataforma sin ser admin. No es un error de
    // la app, es justo el tipo de evento que ese log tiene que mostrar.
    try { logAudit(getDB(), { actorId: req.user.id, action: 'admin_platform_access_denied', meta: { path: req.originalUrl } }); } catch (e) { /* nunca romper el 403 real por esto */ }
    return res.status(403).json({ error: 'No tenés acceso al centro de control de Mediador' });
  }
  next();
}

// roles de acceso profesional (solo lectura) que una parte puede invitar a
// su canal, o que un admin puede aprobar por autoregistro — compartido para
// no repetir el mismo mapa en channels.js, admin.js y professionals.js.
const PROFESSIONAL_ROLE_LABELS = { mediador: 'mediador/a', estudio: 'estudio jurídico', psicologo: 'psicólogo/a o terapeuta' };

module.exports = { isAdminUser, isStudyAdmin, requirePlatformAdmin, PROFESSIONAL_ROLE_LABELS };
