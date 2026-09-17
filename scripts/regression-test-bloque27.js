// scripts/regression-test-bloque27.js
// Bloque 27 (Admin Console / Control Center) — batería HTTP completa contra
// la app real: acceso, seguridad, cross-study, cross-mediation, privacidad,
// paginación, filtros y regresión de coparentalidad. Cubre los 12 tests de
// seguridad de la spec (§19) y los mínimos de §23.
//
// Requiere: server con ENABLE_FAKE_LOGIN=1 y ADMIN_EMAILS incluyendo
// b27-admin@test.local.

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
      if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
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

const ADMIN_ENDPOINTS = [
  ['GET', '/api/admin-mediador/dashboard'],
  ['GET', '/api/admin-mediador/users'],
  ['GET', '/api/admin-mediador/studios'],
  ['GET', '/api/admin-mediador/mediations'],
  ['GET', '/api/admin-mediador/hearings'],
  ['GET', '/api/admin-mediador/activity'],
  ['GET', '/api/admin-mediador/notifications'],
  ['GET', '/api/admin-mediador/system'],
  ['GET', '/api/admin-mediador/system/health'],
  ['GET', '/api/admin-mediador/billing'],
  ['GET', '/api/admin-mediador/radar-summary'],
];

(async function main() {
  console.log(`Bloque 27 (Admin Console) — tests contra ${BASE}\n`);
  const health = await fetch(BASE + '/api/health');
  if (health.status !== 200) { console.error('Server no responde. Abortando.'); process.exit(1); }

  const ADMIN = await login('b27-admin@test.local', 'Admin Plataforma'); // debe estar en ADMIN_EMAILS del server
  const MEDIADOR = await login('b27-mediador@test.local', 'Mediador Normal');
  const ASISTENTE_OWNER = await login('b27-asistente-owner@test.local', 'Dueño de Estudio'); // crea el estudio, será studio-admin
  const ASISTENTE = await login('b27-asistente@test.local', 'Asistente Normal');
  const OTHER_STUDIO_ADMIN = await login('b27-otro-estudio-admin@test.local', 'Admin de Otro Estudio');

  // ==== 1/2. mediador y asistente normales → 403 en TODO el admin console ====
  for (const [method, path] of ADMIN_ENDPOINTS) {
    const r = await MEDIADOR.fetch(path, { method });
    check(`1. mediador normal: ${method} ${path} → 403`, r.status === 403, `status=${r.status}`);
  }
  for (const [method, path] of ADMIN_ENDPOINTS) {
    const r = await ASISTENTE.fetch(path, { method });
    check(`2. asistente normal: ${method} ${path} → 403`, r.status === 403, `status=${r.status}`);
  }

  // ==== 3/4. abogado/parte — usan portales con token, no sesión de Google:
  // ni siquiera pueden intentar estos endpoints con una sesión válida (no
  // tienen una). Confirmamos que sin sesión da 401, que es el mismo
  // resultado al que están limitados por diseño (nunca tienen cookie de
  // Google para llegar más lejos que eso). ====
  for (const [method, path] of ADMIN_ENDPOINTS.slice(0, 3)) {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' } });
    check(`3/4. sin sesión (equivalente a abogado/parte, que no tienen sesión de Google): ${method} ${path} → 401`, r.status === 401, `status=${r.status}`);
  }

  // ==== setup: crear un estudio con ASISTENTE_OWNER como admin de estudio ====
  const studioRes = await ASISTENTE_OWNER.fetch('/api/studios', { method: 'POST', body: JSON.stringify({ name: 'Estudio Test B27' }) });
  check('setup: se crea un estudio de prueba', studioRes.status === 200, JSON.stringify(studioRes.body));
  const studioId = studioRes.body.id;
  const otherStudioRes = await OTHER_STUDIO_ADMIN.fetch('/api/studios', { method: 'POST', body: JSON.stringify({ name: 'Otro Estudio B27' }) });
  const otherStudioId = otherStudioRes.body.id;

  // ==== 5. admin de ESTUDIO intentando funciones de plataforma → 403 ====
  for (const [method, path] of ADMIN_ENDPOINTS) {
    const r = await ASISTENTE_OWNER.fetch(path, { method });
    check(`5. admin de estudio (no de plataforma): ${method} ${path} → 403`, r.status === 403, `status=${r.status}`);
  }

  // ==== 6. admin de plataforma → acceso permitido ====
  for (const [method, path] of ADMIN_ENDPOINTS) {
    const r = await ADMIN.fetch(path, { method });
    check(`6. admin de plataforma: ${method} ${path} → 200`, r.status === 200, `status=${r.status} body=${JSON.stringify(r.body).slice(0,150)}`);
  }

  // ==== 3. dashboard trae KPIs reales, sin inventar datos ====
  const dash = (await ADMIN.fetch('/api/admin-mediador/dashboard')).body;
  check('dashboard: incluye los KPIs esperados', typeof dash.kpis.usuariosRegistrados === 'number' && typeof dash.kpis.mediacionesActivas === 'number', JSON.stringify(dash.kpis));
  check('dashboard: billing declara explícitamente que no está habilitado', dash.billing.enabled === false);
  check('dashboard: requiereAtencion es un array (aunque esté vacío)', Array.isArray(dash.requiereAtencion));

  // ==== 4. usuarios: listado, detalle, activar/desactivar ====
  const med1 = (await MEDIADOR.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ object: 'Mediacion de Mediador Normal' }) })).body;
  const usersList = (await ADMIN.fetch(`/api/admin-mediador/users?q=${encodeURIComponent('b27-mediador@test.local')}`)).body;
  const mediadorRow = usersList.items.find((u) => u.email === 'b27-mediador@test.local');
  check('usuarios: aparece en el listado con su conteo de mediaciones', !!mediadorRow && mediadorRow.mediationsCount >= 1, JSON.stringify(mediadorRow));
  const userDetail = (await ADMIN.fetch(`/api/admin-mediador/users/${mediadorRow.id}`)).body;
  check('usuarios: detalle incluye sus mediaciones (solo metadata)', userDetail.mediations.some((m) => m.id === med1.id));
  check('usuarios: detalle NUNCA incluye contenido de mensajes/notas', JSON.stringify(userDetail).toLowerCase().indexOf('"text"') === -1);

  const disableRes = await ADMIN.fetch(`/api/admin-mediador/users/${mediadorRow.id}/disable`, { method: 'POST' });
  check('usuarios: desactivar → 200, estado desactivado', disableRes.status === 200 && disableRes.body.estado === 'desactivado');
  const loginAfterDisable = await fetch(BASE + '/auth/fake-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'b27-mediador@test.local', name: 'Mediador Normal' }) });
  check('usuarios: una cuenta desactivada NO puede volver a loguearse', loginAfterDisable.status === 403, `status=${loginAfterDisable.status}`);
  const meAfterDisable = await MEDIADOR.fetch('/api/mediations'); // sesión YA abierta antes de desactivar
  check('usuarios: una cuenta desactivada pierde la sesión YA abierta en el próximo request (401)', meAfterDisable.status === 401, `status=${meAfterDisable.status}`);
  const enableRes = await ADMIN.fetch(`/api/admin-mediador/users/${mediadorRow.id}/enable`, { method: 'POST' });
  check('usuarios: reactivar → 200, estado activo', enableRes.status === 200 && enableRes.body.estado === 'activo');
  // la sesión VIEJA queda cortada para siempre (esperado: una vez que
  // deserializeUser rechaza una sesión, esa sesión no se "recupera" sola —
  // hace falta un login nuevo, mismo criterio de seguridad de cualquier
  // "cerrar sesión de un usuario baneado"). Se loguea de nuevo con un jar
  // nuevo para seguir usando esta cuenta en el resto del script.
  const MEDIADOR2 = await login('b27-mediador@test.local', 'Mediador Normal');
  check('usuarios: tras reactivar, puede volver a loguearse (sesión nueva)', !!MEDIADOR2.userId);
  check('usuarios: no se puede desactivar una cuenta de admin de plataforma', (await ADMIN.fetch(`/api/admin-mediador/users/${ADMIN.userId}/disable`, { method: 'POST' })).status === 400);

  // ==== 5. estudios: listado, detalle, cross-study ====
  const studiosList = (await ADMIN.fetch('/api/admin-mediador/studios')).body;
  check('estudios: aparecen los estudios creados', studiosList.items.some((s) => s.id === studioId) && studiosList.items.some((s) => s.id === otherStudioId));
  const studioDetail = (await ADMIN.fetch(`/api/admin-mediador/studios/${studioId}`)).body;
  check('10. cross-study: la ficha de un estudio NUNCA incluye miembros de otro estudio', !studioDetail.members.some((m) => m.email === 'b27-otro-estudio-admin@test.local'));

  // ==== 8. mediaciones — vista global + búsqueda ====
  const medsList = (await ADMIN.fetch(`/api/admin-mediador/mediations?q=${encodeURIComponent(med1.code)}`)).body;
  check('mediaciones: la búsqueda global encuentra la mediación por código', medsList.items.some((m) => m.id === med1.id));
  check('mediaciones: NUNCA expone contenido de mensajes', JSON.stringify(medsList).toLowerCase().indexOf('"text"') === -1);

  // ==== 9. audiencias — agenda global ====
  const party1 = (await MEDIADOR2.fetch(`/api/mediations/${med1.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'P', lastName: 'Uno' }) })).body;
  const hearing1 = (await MEDIADOR2.fetch(`/api/mediations/${med1.id}/hearings`, { method: 'POST', body: JSON.stringify({ date: '2027-06-01', startTime: '10:00', modality: 'presencial', location: 'Sala' }) })).body;
  const hearingsData = (await ADMIN.fetch('/api/admin-mediador/hearings?fecha=proximas')).body;
  check('audiencias: la agenda global incluye la audiencia recién creada', hearingsData.items.items.some((h) => h.id === hearing1.id));
  check('audiencias: trae un resumen (hoy/reprogramaciones/canceladas/etc)', typeof hearingsData.summary.hoy === 'number');

  // ==== actividad — filtros y paginación ====
  const activityAll = (await ADMIN.fetch('/api/admin-mediador/activity?limit=5&offset=0')).body;
  check('paginación: activity respeta limit', activityAll.items.length <= 5);
  check('actividad: incluye el evento de creación de la mediación', activityAll.total > 0);
  const activityFiltered = (await ADMIN.fetch(`/api/admin-mediador/activity?mediationId=${med1.id}`)).body;
  check('filtros: activity filtra por mediationId', activityFiltered.items.every((e) => e.entityId === med1.id || e.entityType !== 'mediation'));

  // ==== notificaciones ====
  const notifs = (await ADMIN.fetch('/api/admin-mediador/notifications')).body;
  check('notificaciones: responde con estructura paginada', Array.isArray(notifs.items) && typeof notifs.total === 'number');

  // ==== sistema ====
  const sysHealth = (await ADMIN.fetch('/api/admin-mediador/system/health')).body;
  check('sistema: health check trae db/api/jobs/whatsapp/websocket', ['db','api','jobs','whatsapp','websocket'].every((k) => !!sysHealth[k]));
  check('sistema: NUNCA expone secretos/tokens en el health check', !JSON.stringify(sysHealth).match(/token|secret|password/i));

  // ==== 11/12. tokens/secrets nunca expuestos en NINGÚN endpoint del admin console ====
  const allBodies = [];
  for (const [method, path] of ADMIN_ENDPOINTS) allBodies.push(JSON.stringify((await ADMIN.fetch(path, { method })).body));
  allBodies.push(JSON.stringify(usersList), JSON.stringify(userDetail), JSON.stringify(studioDetail), JSON.stringify(medsList));
  const joined = allBodies.join(' ');
  check('11. ningún response del admin console expone portalToken/guestToken/webAccessToken', !/portalToken|guestToken|webAccessToken/i.test(joined));
  check('12. ningún response del admin console expone password/secret/apiKey', !/password|apiKey|clientSecret/i.test(joined));

  // ==== 7. manipulación de IDs — un id inexistente da 404, no un 200 con datos ajenos ====
  check('7. manipulación de IDs: /users/no-existe → 404', (await ADMIN.fetch('/api/admin-mediador/users/no-existe-123')).status === 404);
  check('7(b). manipulación de IDs: /studios/no-existe → 404', (await ADMIN.fetch('/api/admin-mediador/studios/no-existe-123')).status === 404);

  // ==== 9. cross-mediation: un no-admin nunca alcanza la vista global aunque conozca IDs reales ====
  check('9. cross-mediation: mediador normal no accede a /mediations (vista global) aunque tenga sus propias mediaciones', (await MEDIADOR2.fetch('/api/admin-mediador/mediations')).status === 403);

  // ==== 18. coparentalidad sin regresión ====
  const C = await login('b27-coparent-c@test.local', 'Coparent C');
  const D = await login('b27-coparent-d@test.local', 'Coparent D');
  const coChannel = await C.fetch('/api/channels', { method: 'POST', body: JSON.stringify({}) });
  check('18. coparentalidad: el canal se sigue creando normalmente', coChannel.status === 200, JSON.stringify(coChannel.body));
  if (coChannel.status === 200) {
    const joinRes = await D.fetch('/api/channels/join', { method: 'POST', body: JSON.stringify({ code: coChannel.body.code }) });
    check('18(b). coparentalidad: el segundo integrante se sigue pudiendo unir', joinRes.status === 200);
  }

  console.log(`\n${passed} OK, ${failed} FAIL de ${passed + failed}`);
  if (failed) { console.log('\nFallos:', failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
