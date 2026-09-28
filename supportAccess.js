// supportAccess.js
// Bloque 29 (Admin Console 2.0) §8 — "acceso excepcional de soporte":
// el mecanismo EXPLÍCITO, TEMPORAL y AUDITADO que un admin de plataforma
// necesita para poder leer contenido privado (mensajes) de una mediación
// que no es suya. Sin una fila activa acá, isAdminUser NO alcanza para
// leer eso — ver el uso de hasActiveSupportAccess en routes/mediations.js.
// Separado en su propio módulo (mismo patrón que entitlements.js) para que
// tanto routes/admin-mediador.js (crear/listar/terminar grants) como
// routes/mediations.js (chequear si hay uno activo) lo importen sin
// depender uno del otro.

function hasActiveSupportAccess(db, adminUserId, mediationId) {
  const now = Date.now();
  return db.supportAccessGrants.some((g) =>
    g.adminUserId === adminUserId && g.mediationId === mediationId && !g.endedAt && g.expiresAt > now
  );
}

// registra QUÉ se consultó durante un grant activo (spec §8: "registrar qué
// recurso fue consultado") — no crea una fila nueva, solo anota sobre el
// grant vigente. Si no hay un grant activo (no debería llamarse en ese
// caso, pero por las dudas) no hace nada.
function recordSupportAccessUsage(db, adminUserId, mediationId, resource) {
  const now = Date.now();
  const grant = db.supportAccessGrants.find((g) =>
    g.adminUserId === adminUserId && g.mediationId === mediationId && !g.endedAt && g.expiresAt > now
  );
  if (!grant) return;
  grant.resourcesAccessed = grant.resourcesAccessed || [];
  if (!grant.resourcesAccessed.includes(resource)) grant.resourcesAccessed.push(resource);
}

module.exports = { hasActiveSupportAccess, recordSupportAccessUsage };
