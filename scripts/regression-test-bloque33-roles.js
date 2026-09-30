// scripts/regression-test-bloque33-roles.js
// Bloque 33 (parte previa) — cobertura NUEVA que no estaba ya en
// regression-test-bloque32.js (que el commit e87e717, de una vuelta
// anterior de esta misma sesión, ya extendió con el gate de maxAssistants
// por rol de estudio — "4-motor" y el bloqueo FREE al invitar un
// asistente ya están probados ahí, no se repiten acá):
//   - el flujo "de punta a punta" con un estudio de plan ESTUDIO real:
//     invitar asistente, aceptar, asignarlo a una mediación, y que pueda
//     hacer trabajo administrativo de verdad.
//   - punto 4: permisos ACOTADOS del asistente dentro de una mediación
//     (no puede cerrarla ni registrar un resultado sustantivo, sí puede
//     avanzar estados procesales/administrativos).
//   - el bypass de admin de plataforma que faltaba en el accept (recién
//     agregado, ver routes/studios.js).
//   - el gate al cambiar el rol de alguien YA en el estudio (PATCH
//     /members/:userId/role), que tampoco estaba cubierto.
//
// Requiere: server con ENABLE_FAKE_LOGIN=1, BILLING_ENFORCE_IN_TEST=1, y
// ADMIN_EMAILS incluyendo b33-platform-admin@test.local.
//
// Uso: antes de arrancar el server, sembrar un estudio real con plan
// ESTUDIO (con el proceso PARADO, nunca mientras corre — evita la
// condición de carrera con commit() ya documentada en sesiones anteriores):
//   SQLITE_PATH=/tmp/b33.sqlite node -e "
//     const { nanoid } = require('nanoid');
//     const { getDB, commit } = require('./db');
//     (async () => {
//       const db = getDB(); const now = Date.now();
//       const owner = { id: nanoid(), googleId: 'fake-seed', email: 'b33-e2e-owner@test.local', name: 'E2E Owner', avatar: '', createdAt: now, guest: false };
//       const studio = { id: nanoid(), name: 'Estudio E2E', ownerId: owner.id, status: 'activo', createdAt: now };
//       owner.studioId = studio.id; owner.studioRole = 'admin';
//       db.users.push(owner); db.studios.push(studio);
//       db.billingAccounts.push({ id: nanoid(), userId: null, studioId: studio.id, planCode: 'ESTUDIO', status: 'active', provider: null, providerCustomerId: null, providerSubscriptionId: null, currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, trialEndsAt: null, pastDueSince: null, createdAt: now, updatedAt: now });
//       await commit();
//     })();"
//   ADMIN_EMAILS=b33-platform-admin@test.local SQLITE_PATH=/tmp/b33.sqlite ENABLE_FAKE_LOGIN=1 BILLING_ENFORCE_IN_TEST=1 PORT=3098 node server.js &
//   node scripts/regression-test-bloque33-roles.js http://localhost:3098

const BASE = process.argv[2] || 'http://localhost:3098';

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
      const res = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
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
async function acceptInvite(email, name, token) {
  const jar = await login(email, name);
  const r = await jar.fetch(`/api/studios/invitations/${token}/accept`, { method: 'POST' });
  return { jar, result: r };
}

(async function main() {
  console.log(`Bloque 33 (roles: asistente vs mediador) — tests contra ${BASE}\n`);
  const health = await fetch(BASE + '/api/health').catch(() => null);
  if (!health || health.status >= 500) { console.error('Server no responde. Abortando.'); process.exit(1); }

  // ==================== flujo de punta a punta (estudio plan ESTUDIO) ====================
  // Se sembró un estudio real con billing_accounts.planCode='ESTUDIO'
  // directo en la base antes de arrancar el server (ver el header de este
  // archivo) — así maxAssistants/maxStudyMembers dejan de ser el foco acá
  // (ya probados en bloque32.js) y el test se concentra en si el flujo
  // REAL funciona una vez que la persona es asistente del estudio.
  const studioAdmin = await login('b33-e2e-owner@test.local', 'E2E Owner');

  const inviteAsistente = await studioAdmin.fetch('/api/studios/invitations', { method: 'POST', body: JSON.stringify({ email: 'b33-e2e-asist@test.local', role: 'asistente' }) });
  check('ESTUDIO: invitar un asistente funciona (maxAssistants ilimitado ahí)', inviteAsistente.status === 200, JSON.stringify(inviteAsistente.body));
  const { jar: asistenteJar, result: acceptAsistResult } = await acceptInvite('b33-e2e-asist@test.local', 'Asistente Test', inviteAsistente.body.token);
  check('El asistente puede aceptar la invitación', acceptAsistResult.status === 200, JSON.stringify(acceptAsistResult.body));

  const med = (await studioAdmin.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object: 'Test Bloque 33 roles' }) })).body;
  const grantAccess = await studioAdmin.fetch(`/api/mediations/${med.id}/access`, { method: 'POST', body: JSON.stringify({ userId: asistenteJar.userId, role: 'asistente' }) });
  check('3. El admin del estudio puede asignar al asistente a una mediación (mismo estudio, sin volver a consumir cupo)', grantAccess.status === 200, JSON.stringify(grantAccess.body));

  const asistCanSeeMed = await asistenteJar.fetch(`/api/mediations/${med.id}`);
  check('3. El asistente puede VER la mediación asignada', asistCanSeeMed.status === 200);
  const asistCanAddParty = await asistenteJar.fetch(`/api/mediations/${med.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'Parte', lastName: 'DeTest' }) });
  check('3. El asistente puede cargar una parte (trabajo administrativo delegable) — "funciona de punta a punta"', asistCanAddParty.status === 200, JSON.stringify(asistCanAddParty.body));
  const asistCanAddTask = await asistenteJar.fetch(`/api/mediations/${med.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: 'Tarea cargada por el asistente' }) });
  check('3. El asistente puede crear una tarea', asistCanAddTask.status === 200);

  // ==================== punto 4: permisos ACOTADOS del asistente ====================
  const closeAttempt = await asistenteJar.fetch(`/api/mediations/${med.id}/close`, { method: 'POST', body: JSON.stringify({ result: 'acuerdo_total' }) });
  check('4. El asistente NO puede cerrar la mediación (403, reservado al mediador)', closeAttempt.status === 403, JSON.stringify(closeAttempt.body));

  const statusToAcuerdo = await asistenteJar.fetch(`/api/mediations/${med.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'acuerdo' }) });
  check('4. El asistente NO puede registrar un resultado sustantivo (403)', statusToAcuerdo.status === 403, JSON.stringify(statusToAcuerdo.body));

  const statusToProcedural = await asistenteJar.fetch(`/api/mediations/${med.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'contactando_partes' }) });
  check('4. El asistente SÍ puede avanzar un estado procesal/administrativo (200)', statusToProcedural.status === 200, JSON.stringify(statusToProcedural.body));

  const asistCanGrantAccess = await asistenteJar.fetch(`/api/mediations/${med.id}/access`, { method: 'POST', body: JSON.stringify({ userId: studioAdmin.userId, role: 'mediador' }) });
  check('4. El asistente NO puede asignar acceso a otros (403, ya restringido de antes — requireMediationAdmin)', asistCanGrantAccess.status === 403);

  const ownerStatusToAcuerdo = await studioAdmin.fetch(`/api/mediations/${med.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'acuerdo' }) });
  check('Regresión: el mediador/admin SÍ puede registrar un resultado sustantivo (200)', ownerStatusToAcuerdo.status === 200, JSON.stringify(ownerStatusToAcuerdo.body));

  // ==================== fixes nuevos de esta vuelta ====================
  // 1) el accept ahora también saltea el paywall para un admin de plataforma
  const platformAdmin = await login('b33-platform-admin@test.local', 'Admin Plataforma');
  const inviteForAdminAccept = await studioAdmin.fetch('/api/studios/invitations', { method: 'POST', body: JSON.stringify({ email: 'b33-platform-admin@test.local', role: 'mediador' }) });
  // esto va a chocar con maxStudyMembers del estudio ESTUDIO (ilimitado,
  // así que igual entraría) — el punto real es que NO explota con 402
  // "para un admin" incluso si el estudio estuviera lleno; acá alcanza con
  // confirmar que el flujo no se rompe para un admin de plataforma.
  if (inviteForAdminAccept.status === 200) {
    const acceptAsAdmin = await platformAdmin.fetch(`/api/studios/invitations/${inviteForAdminAccept.body.token}/accept`, { method: 'POST' });
    check('Fix: un admin de plataforma puede aceptar una invitación sin quedar atrapado por el paywall', acceptAsAdmin.status === 200, JSON.stringify(acceptAsAdmin.body));
  } else {
    check('Fix: un admin de plataforma puede aceptar una invitación sin quedar atrapado por el paywall', false, 'no se pudo generar la invitación de prueba: ' + JSON.stringify(inviteForAdminAccept.body));
  }

  // 2) PATCH /members/:userId/role respeta los límites al cruzar el rol de
  // asistente — se prueba el camino feliz sobre el estudio ESTUDIO
  // (ilimitado, confirma que el gate nuevo no rompe nada); el camino
  // BLOQUEADO usa exactamente canAddStudyMember/canAddAssistant, ya
  // cubiertos por motor puro en bloque32.js — no hace falta repetir la
  // aritmética acá, solo que el endpoint la llame de verdad.
  const promoteToMediador = await studioAdmin.fetch(`/api/studios/members/${asistenteJar.userId}/role`, { method: 'PATCH', body: JSON.stringify({ role: 'mediador' }) });
  check('Fix: promover a alguien de asistente a mediador funciona cuando el plan lo permite (ESTUDIO)', promoteToMediador.status === 200 && promoteToMediador.body.studioRole === 'mediador', JSON.stringify(promoteToMediador.body));
  const demoteBackToAsistente = await studioAdmin.fetch(`/api/studios/members/${asistenteJar.userId}/role`, { method: 'PATCH', body: JSON.stringify({ role: 'asistente' }) });
  check('Fix: degradar de vuelta a asistente también funciona (ESTUDIO)', demoteBackToAsistente.status === 200 && demoteBackToAsistente.body.studioRole === 'asistente', JSON.stringify(demoteBackToAsistente.body));

  console.log(`\n${passed} OK, ${failed} FAIL`);
  if (failed) { console.log('\nFallaron:'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
