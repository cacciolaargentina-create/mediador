// roles.js
// Quién es "admin de la plataforma" — compartido entre routes/admin.js y
// cualquier otra ruta que necesite ese chequeo (ej. notas privadas de caso
// en routes/channels.js). Separado en su propio módulo para no crear un
// require circular entre admin.js y channels.js.

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isAdminUser(user) {
  return !!user && !!user.email && ADMIN_EMAILS.includes(user.email.toLowerCase());
}

// roles de acceso profesional (solo lectura) que una parte puede invitar a
// su canal, o que un admin puede aprobar por autoregistro — compartido para
// no repetir el mismo mapa en channels.js, admin.js y professionals.js.
const PROFESSIONAL_ROLE_LABELS = { mediador: 'mediador/a', estudio: 'estudio jurídico', psicologo: 'psicólogo/a o terapeuta' };

module.exports = { isAdminUser, PROFESSIONAL_ROLE_LABELS };
