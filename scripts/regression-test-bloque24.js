// scripts/regression-test-bloque24.js
// Bloque 24 (Asistente de carga guiada) — parte HTTP de los 9 tests
// obligatorios de la spec (§7). El wizard en sí es una decisión del
// FRONTEND (public/mediador.js) basada en datos que sí vienen del server
// (parties.length, mediation.onboardingDismissedAt) — este script verifica
// esos datos y el endpoint de descarte, más regresión/seguridad/aislamiento.
// Los tests 1/2/5/6 también se verificaron a mano en el browser (ver informe
// final) porque involucran la UI del wizard, no solo el servidor.

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

(async function main() {
  console.log(`Bloque 24 (asistente de carga guiada) — pruebas contra ${BASE}\n`);
  const health = await fetch(BASE + '/api/health');
  if (health.status !== 200) { console.error('Server no responde. Abortando.'); process.exit(1); }

  const A = await login('b24-mediador-a@test.local', 'Mediador A');
  const B = await login('b24-mediador-b@test.local', 'Mediador B');

  // ==== 1. mediación recién creada sin partes: condición de mostrar OK ====
  const med1 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ object: 'Test 1 - alta sin partes' }) })).body;
  check('1. mediación nueva: onboardingDismissedAt es null', med1.onboardingDismissedAt === null, JSON.stringify(med1.onboardingDismissedAt));
  const parties1 = (await A.fetch(`/api/mediations/${med1.id}/parties`)).body;
  check('1. mediación nueva: parties.length === 0 (condición de mostrar el wizard)', parties1.length === 0);

  // ==== 2. con al menos una parte cargada: condición de "nunca mostrar" ====
  const med2 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ object: 'Test 2 - con parte' }) })).body;
  await A.fetch(`/api/mediations/${med2.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'Juan', lastName: 'Pérez' }) });
  const med2Reload = (await A.fetch(`/api/mediations/${med2.id}`)).body;
  const parties2 = (await A.fetch(`/api/mediations/${med2.id}/parties`)).body;
  check('2. con parte cargada: parties.length > 0 (condición de NO mostrar)', parties2.length > 0);
  check('2. con parte cargada: onboardingDismissedAt sigue null (nunca se tocó)', med2Reload.onboardingDismissedAt === null);

  // ==== 3. completar paso 1 (parte requirente) crea la parte de verdad ====
  const med3 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ object: 'Test 3 - paso 1' }) })).body;
  const party3 = (await A.fetch(`/api/mediations/${med3.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'Ana', lastName: 'Gómez' }) })).body;
  const parties3 = (await A.fetch(`/api/mediations/${med3.id}/parties`)).body;
  check('3. paso 1: la parte queda creada de verdad (GET la devuelve)', parties3.some((p) => p.id === party3.id));

  // ==== 4. saltar pasos 2/3/4 no crea nada de esos pasos ====
  const med4 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ object: 'Test 4 - saltar pasos' }) })).body;
  await A.fetch(`/api/mediations/${med4.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'Solo', lastName: 'Requirente' }) });
  // simulamos "saltar 2, 3 y 4": no se llama a POST lawyers/hearings
  const parties4 = (await A.fetch(`/api/mediations/${med4.id}/parties`)).body;
  const lawyers4 = (await A.fetch(`/api/mediations/${med4.id}/lawyers`)).body;
  const hearings4 = (await A.fetch(`/api/mediations/${med4.id}/hearings`)).body;
  check('4. saltar pasos: solo 1 parte (la del paso 1), sin más', parties4.length === 1);
  check('4. saltar pasos: no se creó ningún abogado', lawyers4.length === 0);
  check('4. saltar pasos: no se creó ninguna audiencia', hearings4.length === 0);

  // ==== 5. descartar el wizard: onboardingDismissedAt queda seteado y persiste ====
  const med5 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ object: 'Test 5 - descartar' }) })).body;
  const dismissRes = await A.fetch(`/api/mediations/${med5.id}`, { method: 'PATCH', body: JSON.stringify({ dismissOnboarding: true }) });
  check('5. descartar: PATCH devuelve 200', dismissRes.status === 200, JSON.stringify(dismissRes.body));
  check('5. descartar: onboardingDismissedAt queda seteado', typeof dismissRes.body.onboardingDismissedAt === 'number' && dismissRes.body.onboardingDismissedAt > 0);
  const med5Reload = (await A.fetch(`/api/mediations/${med5.id}`)).body;
  check('5. descartar: al volver a pedir la mediación, sigue seteado (persiste)', med5Reload.onboardingDismissedAt === dismissRes.body.onboardingDismissedAt);
  const parties5 = (await A.fetch(`/api/mediations/${med5.id}/parties`)).body;
  check('5. descartar: la mediación sigue sin partes (parties.length===0) — con dismissed=true el wizard igual NO debe reaparecer', parties5.length === 0);

  // ==== 6. cerrar/recargar después de guardar el paso 1: nada se pierde ====
  const med6 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ object: 'Test 6 - persistencia' }) })).body;
  const party6 = (await A.fetch(`/api/mediations/${med6.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'Persiste', lastName: 'Test' }) })).body;
  // "recargar" = simplemente volver a pedir todo desde cero, como haría un GET fresco tras F5
  const med6Reload = (await A.fetch(`/api/mediations/${med6.id}`)).body;
  const parties6Reload = (await A.fetch(`/api/mediations/${med6.id}/parties`)).body;
  check('6. recarga: la parte del paso 1 sigue existiendo', parties6Reload.some((p) => p.id === party6.id));
  check('6. recarga: la mediación no quedó dismissed solo por recargar', med6Reload.onboardingDismissedAt === null);

  // ==== 7. usuario sin acceso de edición no puede completar ningún paso ====
  // Nota de arquitectura: en esta app (routes/mediations.js), TODO rol de
  // mediation_access otorgable vía API (mediador/admin/asistente) tiene
  // acceso de edición — un abogado interactúa por el portal separado
  // (portal.html), nunca contra esta API. Por eso "sin acceso de edición"
  // y "sin acceso" dan exactamente el mismo 403 acá — se verifica con B
  // totalmente ajeno a la mediación, exactamente el mismo 403 que ya
  // devolvía cada endpoint reutilizado ANTES de este bloque (no es una
  // regla nueva del wizard).
  const med7 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ object: 'Test 7 - sin acceso de edicion' }) })).body;
  const party7Attempt = await B.fetch(`/api/mediations/${med7.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'No', lastName: 'Debería' }) });
  check('7. usuario sin acceso no puede crear parte (paso 1) — 403', party7Attempt.status === 403, JSON.stringify(party7Attempt.body));
  const dismiss7Attempt = await B.fetch(`/api/mediations/${med7.id}`, { method: 'PATCH', body: JSON.stringify({ dismissOnboarding: true }) });
  check('7. usuario sin acceso no puede descartar el wizard — 403', dismiss7Attempt.status === 403, JSON.stringify(dismiss7Attempt.body));
  const lawyer7Attempt = await B.fetch(`/api/mediations/${med7.id}/lawyers`, { method: 'POST', body: JSON.stringify({ name: 'No debería' }) });
  check('7. usuario sin acceso no puede crear abogado (paso 3) — 403', lawyer7Attempt.status === 403);
  const hearing7Attempt = await B.fetch(`/api/mediations/${med7.id}/hearings`, { method: 'POST', body: JSON.stringify({ date: '2027-01-01' }) });
  check('7. usuario sin acceso no puede crear audiencia (paso 4) — 403', hearing7Attempt.status === 403);

  // ==== 8. aislamiento: B no puede ver ni tocar una mediación ajena sin acceso ====
  const med8 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ object: 'Test 8 - aislamiento' }) })).body;
  const get8 = await B.fetch(`/api/mediations/${med8.id}`);
  check('8. mediación ajena (sin acceso): GET devuelve 403', get8.status === 403, JSON.stringify(get8.body));
  const parties8Attempt = await B.fetch(`/api/mediations/${med8.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'Intruso', lastName: 'X' }) });
  check('8. mediación ajena: no puede crear parte — 403', parties8Attempt.status === 403);
  const dismiss8Attempt = await B.fetch(`/api/mediations/${med8.id}`, { method: 'PATCH', body: JSON.stringify({ dismissOnboarding: true }) });
  check('8. mediación ajena: no puede descartar su wizard — 403', dismiss8Attempt.status === 403);

  // ==== 9. regresión: partes/abogados/audiencias funcionan igual que antes ====
  const med9 = (await A.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ object: 'Test 9 - regresion' }) })).body;
  const party9 = (await A.fetch(`/api/mediations/${med9.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requirente', firstName: 'Reg', lastName: 'Uno' }) })).body;
  const party9b = (await A.fetch(`/api/mediations/${med9.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requerido', firstName: 'Reg', lastName: 'Dos' }) })).body;
  const lawyer9 = (await A.fetch(`/api/mediations/${med9.id}/lawyers`, { method: 'POST', body: JSON.stringify({ name: 'Dr. Reg', partyId: party9.id }) })).body;
  const hearing9 = (await A.fetch(`/api/mediations/${med9.id}/hearings`, { method: 'POST', body: JSON.stringify({ date: '2027-05-05', startTime: '11:00', modality: 'presencial', location: 'Sala reg' }) })).body;
  check('9. regresión: crear parte requirente sigue funcionando', !!party9.id);
  check('9. regresión: crear parte requerida sigue funcionando', !!party9b.id);
  check('9. regresión: crear abogado vinculado a una parte sigue funcionando', lawyer9.partyId === party9.id);
  check('9. regresión: agendar audiencia sigue funcionando (con confirmaciones generadas)', !!hearing9.id && hearing9.confirmations.length === 2);
  // mediación ya con 4 pasos completos: el wizard no debe interferir en nada de lo de siempre
  const med9Detail = (await A.fetch(`/api/mediations/${med9.id}`)).body;
  check('9. regresión: serializeMediation sigue trayendo todos los campos de siempre', med9Detail.status === 'borrador' && med9Detail.code);

  // sanity check final — coparentalidad (canales sin mediationId) no se tocó
  const C = await login('b24-coparent-c@test.local', 'Coparent C');
  const D = await login('b24-coparent-d@test.local', 'Coparent D');
  const coChannel = await C.fetch('/api/channels', { method: 'POST', body: JSON.stringify({}) });
  check('sanity: coparentalidad — el canal se sigue creando normalmente', coChannel.status === 200, JSON.stringify(coChannel.body));
  if (coChannel.status === 200) {
    const joinRes = await D.fetch('/api/channels/join', { method: 'POST', body: JSON.stringify({ code: coChannel.body.code }) });
    check('sanity: coparentalidad — el segundo integrante se sigue pudiendo unir', joinRes.status === 200);
  }

  console.log(`\n${passed} OK, ${failed} FAIL de ${passed + failed}`);
  if (failed) { console.log('\nFallos:', failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
