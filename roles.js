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

module.exports = { isAdminUser };
