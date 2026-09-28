// scripts/regression-test-bloque29.js
// Bloque 29 (Admin Console 2.0) — batería HTTP contra la app real: rol
// platform_admin centralizado (requirePlatformAdmin), soporte (tickets +
// acceso excepcional), impersonación, seguridad/auditoría, feature flags,
// métricas, y el backdoor que este bloque cierra: un admin de plataforma
// YA NO puede leer mensajes de una mediación ajena sin un acceso de
// soporte activo.
//
// Requiere: server con ENABLE_FAKE_LOGIN=1 y ADMIN_EMAILS incluyendo
// b29-admin@test.local.
// Uso: node scripts/regression-test-bloque29.js [http://localhost:PORT]

const BASE = process.argv[2] || 'http://localhost:3099';

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

function cookieJar() {
  let cookie = null;
  return {
    async fetch(path, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + path, { ...opts, headers });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let body = null;
      try { body = await res.json(); } catch (e) {}
      return { status: res.status, body };
    },
  };
}
async function login(email, name) {
  const jar = cookieJar();
  const r = await jar.fetch('/auth/fake-login', { method: 'POST', body: JSON.stringify({ email, name }) });
  if (r.status !== 200) throw new Error(`No se pudo loguear ${email}: ${JSON.stringify(r.body)}`);
  jar.userId = r.body.user.id;
  return jar;
}

(async function main() {
  console.log(`Bloque 29 (Admin Console 2.0) — tests contra ${BASE}\n`);
  const health = await fetch(BASE + '/api/health').catch(() => null);
  if (!health || health.status >= 500) { console.error('Server no responde. Abortando.'); process.exit(1); }

  const ADMIN = await login('b29-admin@test.local', 'Admin Plataforma');
  const MED_A = await login('b29-mediador-a@test.local', 'Mediador A');
  const NORMAL = await login('b29-mediador-b@test.local', 'Mediador B');

  // ---- setup: mediación de A con un mensaje real a una parte ----
  const med = (await MED_A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object: 'Bloque 29 test' }) })).body;
  const party = (await MED_A.fetch(`/api/mediations/${med.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'Test', lastName: 'Parte29' }) })).body;
  await MED_A.fetch(`/api/mediations/${med.id}/parties/${party.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'mensaje privado de A' }) });

  // ==== 1/2/3. platform admin access / study admin denied / mediator denied ====
  const adminDash = await ADMIN.fetch('/api/admin-mediador/dashboard');
  check('1. platform admin: GET /admin-mediador/dashboard -> 200', adminDash.status === 200);
  const normalDash = await NORMAL.fetch('/api/admin-mediador/dashboard');
  check('2/3. mediador normal: GET /admin-mediador/dashboard -> 403', normalDash.status === 403);
  const anonDash = await fetch(BASE + '/api/admin-mediador/dashboard');
  check('16. sin sesión: GET /admin-mediador/dashboard -> 401', anonDash.status === 401);

  // ==== 4/5/6. users/studies/mediations (ya existían, reverificar que siguen andando) ====
  check('4. GET /admin-mediador/users -> 200', (await ADMIN.fetch('/api/admin-mediador/users')).status === 200);
  check('5. GET /admin-mediador/studios -> 200', (await ADMIN.fetch('/api/admin-mediador/studios')).status === 200);
  const medsRes = await ADMIN.fetch('/api/admin-mediador/mediations');
  check('6. GET /admin-mediador/mediations -> 200 e incluye la mediación de A', medsRes.status === 200 && medsRes.body.items.some((m) => m.id === med.id));
  check('6(b). la vista global NO expone texto de mensajes', !JSON.stringify(medsRes.body).includes('mensaje privado de A'));

  // ==== 7. billing (ya existía) ====
  const billingRes = await ADMIN.fetch('/api/admin-mediador/billing');
  check('7. GET /admin-mediador/billing -> 200', billingRes.status === 200);

  // ==== 8. activity (ya existía) ====
  check('8. GET /admin-mediador/activity -> 200', (await ADMIN.fetch('/api/admin-mediador/activity')).status === 200);

  // ==== 9. errors / 10. system health (ya existían) ====
  check('9. GET /admin-mediador/system -> 200', (await ADMIN.fetch('/api/admin-mediador/system')).status === 200);
  check('10. GET /admin-mediador/system/health -> 200', (await ADMIN.fetch('/api/admin-mediador/system/health')).status === 200);

  // ==== 11. security (nuevo) ====
  const secBefore = await ADMIN.fetch('/api/admin-mediador/security');
  check('11. GET /admin-mediador/security -> 200', secBefore.status === 200);
  check('11(b). el intento denegado de B (test 2/3) quedó registrado como admin_platform_access_denied', secBefore.body.items.some((e) => e.action === 'admin_platform_access_denied'));

  // ==== 12. support (tickets, nuevo) ====
  const ticket = await ADMIN.fetch('/api/admin-mediador/support', { method: 'POST', body: JSON.stringify({ category: 'mediation', priority: 'alta', description: 'Test ticket bloque 29' }) });
  check('12. crear ticket de soporte -> 200', ticket.status === 200 && !!ticket.body.id);
  const ticketUpd = await ADMIN.fetch(`/api/admin-mediador/support/${ticket.body.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
  check('12(b). actualizar estado del ticket -> resolved', ticketUpd.status === 200 && ticketUpd.body.status === 'resolved' && !!ticketUpd.body.resolvedAt);
  const supportList = await ADMIN.fetch('/api/admin-mediador/support');
  check('12(c). el ticket aparece en la lista', supportList.body.items.some((t) => t.id === ticket.body.id));

  // ==== 7 (§6 del bloque de mensajes) — backdoor cerrado ====
  const beforeAccess = await ADMIN.fetch(`/api/mediations/${med.id}/parties/${party.id}/messages`);
  check('7(admin no puede leer chats privados sin acceso). admin SIN grant -> 403 SUPPORT_ACCESS_REQUIRED', beforeAccess.status === 403 && beforeAccess.body.code === 'SUPPORT_ACCESS_REQUIRED');

  // ==== 13. support access — motivo obligatorio ====
  const noReason = await ADMIN.fetch('/api/admin-mediador/support-access', { method: 'POST', body: JSON.stringify({ mediationId: med.id, reason: '' }) });
  check('13. support access sin motivo -> 400', noReason.status === 400);

  // ==== crear grant real y confirmar que ahora SÍ puede leer ====
  const grant = await ADMIN.fetch('/api/admin-mediador/support-access', { method: 'POST', body: JSON.stringify({ mediationId: med.id, reason: 'El usuario reporta que no puede ver un mensaje', durationMinutes: 15 }) });
  check('grant de soporte creado -> 200 con expiresAt futuro', grant.status === 200 && grant.body.expiresAt > Date.now());
  const afterAccess = await ADMIN.fetch(`/api/mediations/${med.id}/parties/${party.id}/messages`);
  check('con grant activo, admin SÍ puede leer los mensajes', afterAccess.status === 200 && Array.isArray(afterAccess.body));
  const grantsList = await ADMIN.fetch(`/api/admin-mediador/support-access?mediationId=${med.id}`);
  check('el grant registró qué recurso se consultó (resourcesAccessed)', grantsList.body.items.some((g) => g.id === grant.body.id && g.resourcesAccessed && g.resourcesAccessed.length > 0));

  // ==== 14. support access expira ====
  const endRes = await ADMIN.fetch(`/api/admin-mediador/support-access/${grant.body.id}/end`, { method: 'POST' });
  check('14. terminar el acceso de soporte manualmente -> 200', endRes.status === 200 && !!endRes.body.endedAt);
  const afterEnd = await ADMIN.fetch(`/api/mediations/${med.id}/parties/${party.id}/messages`);
  check('14(b). después de terminado, vuelve a estar bloqueado (403)', afterEnd.status === 403);

  // ==== NORMAL (mediador dueño de su propia mediación) sigue viendo sus mensajes sin ningún grant ====
  const ownerRead = await MED_A.fetch(`/api/mediations/${med.id}/parties/${party.id}/messages`);
  check('el dueño de la mediación sigue leyendo sus propios mensajes sin necesitar acceso de soporte', ownerRead.status === 200);

  // ==== 18. support access requiere motivo también al crear (ya probado) — cross-check: otro admin no puede terminar el grant de otro ====
  const ADMIN2 = await login('b29-admin2@test.local', 'Admin Plataforma 2');
  const grant2 = await ADMIN.fetch('/api/admin-mediador/support-access', { method: 'POST', body: JSON.stringify({ mediationId: med.id, reason: 'segundo intento', durationMinutes: 5 }) });
  const crossEnd = await ADMIN2.fetch(`/api/admin-mediador/support-access/${grant2.body.id}/end`, { method: 'POST' });
  check('otro admin no puede terminar un grant que no pidió él (403)', crossEnd.status === 403);
  await ADMIN.fetch(`/api/admin-mediador/support-access/${grant2.body.id}/end`, { method: 'POST' }); // limpieza

  // ==== 19. impersonación ====
  const impNoReason = await ADMIN.fetch('/api/admin-mediador/impersonation', { method: 'POST', body: JSON.stringify({ targetUserId: MED_A.userId, reason: '' }) });
  check('19. impersonación sin motivo -> 400', impNoReason.status === 400);
  const imp = await ADMIN.fetch('/api/admin-mediador/impersonation', { method: 'POST', body: JSON.stringify({ targetUserId: MED_A.userId, reason: 'problema visual reportado', durationMinutes: 15 }) });
  check('19(b). iniciar impersonación -> 200, expira en el futuro', imp.status === 200 && imp.body.expiresAt > Date.now());
  const impSelf = await ADMIN.fetch('/api/admin-mediador/impersonation', { method: 'POST', body: JSON.stringify({ targetUserId: ADMIN.userId, reason: 'x' }) });
  check('no se puede "ver como" a otro admin de plataforma', impSelf.status === 400);
  const impEnd = await ADMIN.fetch(`/api/admin-mediador/impersonation/${imp.body.id}/end`, { method: 'POST' });
  check('19(c). terminar impersonación -> 200', impEnd.status === 200 && !!impEnd.body.endedAt);
  const impCrossEnd = await ADMIN2.fetch(`/api/admin-mediador/impersonation/${imp.body.id}/end`, { method: 'POST' });
  check('otro admin no puede terminar una sesión de impersonación ajena (403)', impCrossEnd.status === 403);

  // ==== auditoría registró todo lo anterior ====
  const auditRes = await ADMIN.fetch('/api/admin-mediador/audit');
  const auditActions = auditRes.body.items.map((e) => e.action);
  check('auditoría: admin_support_access_started quedó registrado', auditActions.includes('admin_support_access_started'));
  check('auditoría: admin_support_access_ended quedó registrado', auditActions.includes('admin_support_access_ended'));
  check('auditoría: admin_impersonation_started quedó registrado', auditActions.includes('admin_impersonation_started'));
  check('auditoría: admin_impersonation_ended quedó registrado', auditActions.includes('admin_impersonation_ended'));
  check('auditoría: admin_support_ticket_created quedó registrado', auditActions.includes('admin_support_ticket_created'));

  // ==== feature flags ====
  const flags = await ADMIN.fetch('/api/admin-mediador/feature-flags');
  check('feature flags: se siembran solos y responden 200', flags.status === 200 && flags.body.length > 0);
  const flagKey = flags.body[0].key;
  const before = flags.body[0].enabled;
  const toggled = await ADMIN.fetch(`/api/admin-mediador/feature-flags/${flagKey}/toggle`, { method: 'POST' });
  check('feature flags: toggle invierte el estado', toggled.status === 200 && toggled.body.enabled === !before);

  // ==== métricas ====
  const metrics = await ADMIN.fetch('/api/admin-mediador/metrics?range=30d');
  check('métricas: GET /admin-mediador/metrics -> 200 con adopcion', metrics.status === 200 && typeof metrics.body.adopcion === 'object');
  check('métricas: no hace predicciones (no hay campo forecast/prediccion)', !('forecast' in metrics.body) && !('prediccion' in metrics.body));

  // ==== radar (ya existía) ====
  check('radar: GET /admin-mediador/radar-summary -> 200', (await ADMIN.fetch('/api/admin-mediador/radar-summary')).status === 200);

  // ==== 20. manipular userId/mediationId no da acceso ====
  const fakeIdRes = await NORMAL.fetch('/api/mediations/no-existe-este-id');
  check('20. manipular mediationId inexistente -> 404, nunca 200', fakeIdRes.status === 404);

  // ==== coparentalidad no se tocó ====
  const chRes = await MED_A.fetch('/api/channels', { method: 'POST', body: JSON.stringify({}) });
  check('coparentalidad: crear canal sigue funcionando (Bloque 29 no tocó routes/channels.js)', chRes.status === 200 || chRes.status === 201);

  console.log(`\n${passed} OK, ${failed} FAIL`);
  if (failed) { console.log('\nFallaron:'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
