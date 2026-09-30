// scripts/regression-test-bloque43.js
// Bloque 43 — Motor de Plazos Legales y Notificación Fehaciente.
//
// Dos partes:
//  1) MOTOR PURO (sin servidor): businessCalendar.js, legalDeadlines.js,
//     jurisdictionRules.js y los detectores nuevos de automationEngine.js,
//     contra objetos `db` fabricados a mano — igual criterio que
//     regression-test-bloque32.js para canAddAssistant/canAddStudyMember.
//  2) HTTP contra un server real (jurisdicción, notificaciones, prórroga,
//     corrección manual, aislamiento, centro de atención, idempotencia del
//     job de recordatorios).
//
// Para la parte 2, servidor dedicado (NUNCA el de 3099 que usa el resto de
// la suite — mismo criterio que bloque32/bloque33-roles):
//   ADMIN_EMAILS=b43-admin@test.local SQLITE_PATH=/tmp/b43.sqlite ENABLE_FAKE_LOGIN=1 PORT=3097 node server.js &
//   node scripts/regression-test-bloque43.js http://localhost:3097
//
// Sin URL como argumento, corre SOLO la parte 1 (motor puro).

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('Bloque 43 (motor de plazos legales) — parte 1: motor puro\n');

const businessCalendar = require('../businessCalendar');
const { getJurisdictionRules, listJurisdictions } = require('../jurisdictionRules');
const { computeMediationDeadline, checkHearingNotice, computeActaDisponibilidad } = require('../legalDeadlines');
const automationEngine = require('../automationEngine');

function fakeDb() {
  return {
    legalHolidays: [], parties: [], partyNotifications: [], mediationDeadlineExtensions: [],
    hearings: [], mediations: [], tasks: [], commitments: [], documents: [], mediationEvents: [],
    attentionDismissals: [], channels: [], messages: [],
  };
}

// ---- 1. calendario de días hábiles ----
{
  const db = fakeDb();
  const added = businessCalendar.seedDefaultHolidays(db);
  check('1a. seedDefaultHolidays agrega feriados del año en curso y el siguiente', added > 0);
  check('1b. seedDefaultHolidays es idempotente (segunda corrida no duplica)', businessCalendar.seedDefaultHolidays(db) === 0);
  check('1c. 1° de enero es feriado', businessCalendar.isHoliday(db, `${new Date().getUTCFullYear()}-01-01`));
  check('1d. un sábado no es día hábil', !businessCalendar.isBusinessDay(db, '2026-02-07'));
  check('1e. un martes común es día hábil', businessCalendar.isBusinessDay(db, '2026-02-03'));
  check('1f. addBusinessDays salta fin de semana (viernes 2026-02-06 +1 → lunes 2026-02-09)', businessCalendar.addBusinessDays(db, '2026-02-06', 1) === '2026-02-09');
  // enero entero es feria judicial: +5 días hábiles desde el 2 de enero
  // tiene que aterrizar en febrero, no dentro de enero.
  const afterJan = businessCalendar.addBusinessDays(db, '2026-01-02', 5);
  check('1g. addBusinessDays salta TODA la feria judicial de enero', afterJan.startsWith('2026-02-'), afterJan);
  check('1h. businessDaysBetween es el inverso de addBusinessDays (ida y vuelta = mismo N)', businessCalendar.businessDaysBetween(db, '2026-02-02', businessCalendar.addBusinessDays(db, '2026-02-02', 60)) === 60);
  check('1i. businessDaysBetween da negativo si b es anterior a a', businessCalendar.businessDaysBetween(db, '2026-03-01', '2026-02-01') < 0);
  check('1j. yearHasHolidaysLoaded: año sin ninguna fila cargada da false', !businessCalendar.yearHasHolidaysLoaded(db, 2099));
  check('1k. yearHasHolidaysLoaded: año recién sembrado da true', businessCalendar.yearHasHolidaysLoaded(db, new Date().getUTCFullYear()));
}

// ---- 2. jurisdicción ----
{
  check('2a. jurisdicción "nacion" tiene reglas cargadas', !!getJurisdictionRules('nacion'));
  check('2b. jurisdicción inexistente devuelve null (nunca inventa)', getJurisdictionRules('provincia_inexistente') === null);
  check('2c. jurisdicción null/undefined devuelve null', getJurisdictionRules(null) === null && getJurisdictionRules(undefined) === null);
  check('2d. listJurisdictions incluye nacion', listJurisdictions().some((j) => j.code === 'nacion'));
}

// ---- 3. regla de 60 días (plazo de la mediación) ----
function makeMediation(overrides = {}) {
  return { id: 'med1', jurisdiction: 'nacion', deadlineStartOverride: null, deadlineStartOverrideReason: null, ...overrides };
}
{
  const db = fakeDb();
  businessCalendar.seedDefaultHolidays(db);
  const mediationSinJurisdiccion = makeMediation({ jurisdiction: null });
  const r1 = computeMediationDeadline(db, mediationSinJurisdiccion);
  check('3a. sin jurisdicción cargada → no calculable, nunca inventa', r1.calculable === false);

  const mediation = makeMediation();
  const r2 = computeMediationDeadline(db, mediation);
  check('3b. con jurisdicción pero sin partes requeridas → no calculable', r2.calculable === false);

  db.parties.push({ id: 'p1', mediationId: 'med1', role: 'requerido', status: 'activa', firstName: 'Juan', lastName: 'Pérez' });
  const r3 = computeMediationDeadline(db, mediation);
  check('3c. requerido cargado pero sin notificación → calculable, pero NO iniciado ("no iniciado")', r3.calculable === true && r3.started === false);

  db.partyNotifications.push({ id: 'n1', mediationId: 'med1', partyId: 'p1', medium: 'carta_documento', status: 'enviada', sentDate: '2026-02-01', createdAt: 1 });
  const r4 = computeMediationDeadline(db, mediation);
  check('3d. notificación solo "enviada" (sin recepción) → sigue sin iniciar el cómputo', r4.started === false);

  db.partyNotifications.push({ id: 'n2', mediationId: 'med1', partyId: 'p1', medium: 'carta_documento', status: 'recibida', sentDate: '2026-02-01', receivedDate: '2026-02-03', createdAt: 2 });
  const r5 = computeMediationDeadline(db, mediation);
  check('3e. notificación "recibida" con fecha → el cómputo arranca en la fecha de RECEPCIÓN, no de envío', r5.started === true && r5.computationStart === '2026-02-03');
  check('3f. deadlineDate = 60 días hábiles desde la recepción', r5.deadlineDate === businessCalendar.addBusinessDays(db, '2026-02-03', 60));
  check('3g. explicación incluye la fecha de origen', r5.explanation.some((l) => l.includes('2026-02-03')));

  // múltiples requeridos: rige la ÚLTIMA notificación
  db.parties.push({ id: 'p2', mediationId: 'med1', role: 'requerido', status: 'activa', firstName: 'Ana', lastName: 'Gómez' });
  db.partyNotifications.push({ id: 'n3', mediationId: 'med1', partyId: 'p2', medium: 'cedula', status: 'recibida', sentDate: '2026-02-05', receivedDate: '2026-02-10', createdAt: 3 });
  const r6 = computeMediationDeadline(db, mediation);
  check('3h. con dos requeridos, rige la notificación MÁS TARDÍA entre ambos', r6.computationStart === '2026-02-10');
  check('3i. deadlineDate recalculado desde la fecha más tardía', r6.deadlineDate === businessCalendar.addBusinessDays(db, '2026-02-10', 60));

  // una parte sin notificación bloquea el inicio aunque la otra sí tenga
  db.parties.push({ id: 'p3', mediationId: 'med1', role: 'requerido', status: 'activa', firstName: 'Luis', lastName: 'Ruiz' });
  const r7 = computeMediationDeadline(db, mediation);
  check('3j. si falta la notificación de UN requerido, el plazo total no arranca aunque los demás sí estén notificados', r7.started === false && r7.pendingPartyIds.includes('p3'));
  db.parties.pop(); // saco a p3 para los tests siguientes

  // rechazada/no_localizado NO cuentan como notificación efectiva
  const dbRej = fakeDb();
  businessCalendar.seedDefaultHolidays(dbRej);
  dbRej.parties.push({ id: 'p1', mediationId: 'med1', role: 'requerido', status: 'activa', firstName: 'Juan' });
  dbRej.partyNotifications.push({ id: 'n1', mediationId: 'med1', partyId: 'p1', medium: 'carta_documento', status: 'rechazada', sentDate: '2026-02-01', createdAt: 1 });
  const r8 = computeMediationDeadline(dbRej, makeMediation());
  check('3k. notificación "rechazada" NO inicia el cómputo por sí sola (lectura conservadora, ver comentario en legalDeadlines.js)', r8.started === false);
}

// ---- 4. prórrogas ----
{
  const db = fakeDb();
  businessCalendar.seedDefaultHolidays(db);
  const mediation = makeMediation();
  db.parties.push({ id: 'p1', mediationId: 'med1', role: 'requerido', status: 'activa', firstName: 'Juan' });
  db.partyNotifications.push({ id: 'n1', mediationId: 'med1', partyId: 'p1', medium: 'carta_documento', status: 'recibida', receivedDate: '2026-02-03', createdAt: 1 });
  const base = computeMediationDeadline(db, mediation);

  db.mediationDeadlineExtensions.push({ id: 'e1', mediationId: 'med1', days: 20, reason: 'acuerdo de partes', agreedDate: '2026-04-01', createdAt: 10 });
  const withDaysExt = computeMediationDeadline(db, mediation);
  check('4a. prórroga en días hábiles corre la fecha límite hacia adelante', withDaysExt.deadlineDate === businessCalendar.addBusinessDays(db, base.deadlineDate, 20));

  db.mediationDeadlineExtensions.length = 0;
  db.mediationDeadlineExtensions.push({ id: 'e2', mediationId: 'med1', newDeadlineDate: '2026-12-31', reason: 'acuerdo con fecha fija', agreedDate: '2026-04-01', createdAt: 10 });
  const withFixedExt = computeMediationDeadline(db, mediation);
  check('4b. prórroga con fecha límite directa reemplaza la fecha calculada', withFixedExt.deadlineDate === '2026-12-31');
}

// ---- 5. corrección manual de la fecha base ----
{
  const db = fakeDb();
  businessCalendar.seedDefaultHolidays(db);
  const mediation = makeMediation({ deadlineStartOverride: '2026-05-01', deadlineStartOverrideReason: 'corrección de prueba' });
  db.parties.push({ id: 'p1', mediationId: 'med1', role: 'requerido', status: 'activa', firstName: 'Juan' });
  // ni siquiera hay notificación cargada — la corrección manual debe regir igual
  const r = computeMediationDeadline(db, mediation);
  check('5a. con corrección manual, el cómputo arranca en esa fecha aunque no haya notificación registrada', r.started === true && r.computationStart === '2026-05-01');
  check('5b. queda marcado como corregido manualmente', r.computationStartManuallyOverridden === true);
}

// ---- 6. aviso de audiencia (3 días hábiles) ----
{
  const db = fakeDb();
  businessCalendar.seedDefaultHolidays(db);
  const mediation = makeMediation();
  const okCheck = checkHearingNotice(db, mediation, '2026-03-20', new Date('2026-03-01T12:00:00Z').getTime());
  check('6a. programar con suficiente anticipación cumple el mínimo', okCheck.meetsMinimum === true);
  const badCheck = checkHearingNotice(db, mediation, '2026-03-04', new Date('2026-03-02T12:00:00Z').getTime());
  check('6b. programar sobre la fecha (pocos días hábiles) NO cumple el mínimo', badCheck.meetsMinimum === false);
}

// ---- 7. acta de cierre — 20 días corridos ----
{
  const db = fakeDb();
  const mediationSinCerrar = makeMediation();
  check('7a. mediación sin cerrar → sin cómputo de acta', computeActaDisponibilidad(db, mediationSinCerrar) === null);
  const closedAt = new Date('2026-06-01T00:00:00Z').getTime();
  const mediationCerrada = makeMediation({ closedAt });
  const acta = computeActaDisponibilidad(db, mediationCerrada);
  check('7b. reanudación = 20 días CORRIDOS desde el cierre (no hábiles)', acta.resumeDate === '2026-06-21');
  check('7c. "reached" es false antes de esa fecha (asumiendo que corre hoy antes de 2026-06-21 si ya estamos ahí, este check solo valida la fecha, no el reloj real)', typeof acta.reached === 'boolean');
}

// ---- 8. detectores de automationEngine.js ----
{
  const db = fakeDb();
  businessCalendar.seedDefaultHolidays(db);
  const mediation = { id: 'med1', code: 'MED-1', jurisdiction: 'nacion', status: 'en_mediacion', closedAt: null, deadlineStartOverride: null };
  db.mediations.push(mediation);
  db.parties.push({ id: 'p1', mediationId: 'med1', role: 'requerido', status: 'activa', firstName: 'Juan' });

  const { alert: alertSinNotificar } = automationEngine.getLegalDeadlineAttentionState(db, mediation);
  check('8a. sin notificación registrada → sin alerta de plazo (todavía no calculable como "por vencer")', alertSinNotificar === null);
  check('8b. detector "requerido sin notificación" SÍ dispara', automationEngine.getRequeridosSinNotificacion(db, mediation).length === 1);

  db.partyNotifications.push({ id: 'n1', mediationId: 'med1', partyId: 'p1', medium: 'carta_documento', status: 'no_localizado', sentDate: '2026-02-01', createdAt: 1 });
  check('8c. detector "requerido sin notificación" ya NO dispara (hay una fila, aunque no sea efectiva)', automationEngine.getRequeridosSinNotificacion(db, mediation).length === 0);
  check('8d. detector "notificación sin seguimiento" SÍ dispara con estado no_localizado', automationEngine.getNotificacionesSinSeguimiento(db, mediation).length === 1);

  // reemplazo por un intento nuevo = "seguimiento" ya tomado
  db.partyNotifications.push({ id: 'n2', mediationId: 'med1', partyId: 'p1', medium: 'cedula', status: 'recibida', receivedDate: '2026-02-20', createdAt: 2 });
  check('8e. con un intento MÁS NUEVO ya recibido, "sin seguimiento" deja de disparar', automationEngine.getNotificacionesSinSeguimiento(db, mediation).length === 0);

  // plazo vencido: fuerzo con una recepción muy vieja
  const dbVencido = fakeDb();
  businessCalendar.seedDefaultHolidays(dbVencido);
  const medVencido = { id: 'med2', code: 'MED-2', jurisdiction: 'nacion', status: 'en_mediacion', closedAt: null, deadlineStartOverride: null };
  dbVencido.parties.push({ id: 'p1', mediationId: 'med2', role: 'requerido', status: 'activa', firstName: 'Juan' });
  dbVencido.partyNotifications.push({ id: 'n1', mediationId: 'med2', partyId: 'p1', medium: 'carta_documento', status: 'recibida', receivedDate: '2020-01-10', createdAt: 1 });
  const { alert: alertVencido } = automationEngine.getLegalDeadlineAttentionState(dbVencido, medVencido);
  check('8f. plazo vencido hace tiempo → alerta "vencido"', alertVencido === 'vencido');

  // audiencia sin aviso mínimo
  const dbHearing = fakeDb();
  businessCalendar.seedDefaultHolidays(dbHearing);
  const medHearing = { id: 'med3', jurisdiction: 'nacion', status: 'en_mediacion', closedAt: null };
  const now = new Date('2026-03-02T12:00:00Z').getTime();
  dbHearing.hearings.push({ id: 'h1', mediationId: 'med3', date: '2026-03-04', status: 'programada', createdAt: now });
  const sinAviso = automationEngine.getHearingsWithoutMinimumNotice(dbHearing, medHearing, now);
  check('8g. audiencia programada sin cumplir el mínimo de 3 días hábiles → detector dispara', sinAviso.length === 1);
  const dbHearingOk = fakeDb();
  businessCalendar.seedDefaultHolidays(dbHearingOk);
  dbHearingOk.hearings.push({ id: 'h2', mediationId: 'med3', date: '2026-03-20', status: 'programada', createdAt: now });
  const conAviso = automationEngine.getHearingsWithoutMinimumNotice(dbHearingOk, medHearing, now);
  check('8h. audiencia con suficiente anticipación → detector NO dispara', conAviso.length === 0);
}

console.log(`\nParte 1 (motor puro): ${passed} OK, ${failed} FAIL hasta acá.\n`);

// ================= parte 2: HTTP contra un servidor real =================
const BASE = process.argv[2];
if (!BASE) {
  console.log('Sin URL de servidor como argumento — se omite la parte 2 (HTTP). Ver encabezado del archivo para correrla.');
  finish();
} else {
  runHttpPart(BASE).then(finish).catch((e) => { console.error('ERROR en la parte HTTP:', e); process.exit(1); });
}

function finish() {
  console.log(`\nTOTAL: ${passed} OK, ${failed} FAIL`);
  if (failed) { console.log('\nFallaron:'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
}

async function runHttpPart(BASE) {
  console.log(`\nBloque 43 — parte 2: HTTP contra ${BASE}\n`);

  function cookieJar() {
    let cookie = null;
    return {
      async fetch(path, opts = {}) {
        const headers = { ...(opts.headers || {}) };
        headers['Content-Type'] = 'application/json';
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

  const health = await fetch(BASE + '/api/health').catch(() => null);
  if (!health || health.status >= 500) { console.error('Server no responde. Abortando parte HTTP.'); process.exit(1); }

  const mediador = await login('b43-mediador@test.local', 'Mediador B43');
  const med = (await mediador.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object: 'Prueba Bloque 43' }) })).body;

  // jurisdicción
  const plazos0 = await mediador.fetch(`/api/mediations/${med.id}/legal-tools/plazos`);
  check('H1. sin jurisdicción, el endpoint responde 200 con calculable:false (nunca inventa)', plazos0.status === 200 && plazos0.body.deadline.calculable === false);
  const badJur = await mediador.fetch(`/api/mediations/${med.id}/jurisdiction`, { method: 'PATCH', body: JSON.stringify({ jurisdiction: 'marte' }) });
  check('H2. jurisdicción inválida es rechazada (400)', badJur.status === 400);
  const setJur = await mediador.fetch(`/api/mediations/${med.id}/jurisdiction`, { method: 'PATCH', body: JSON.stringify({ jurisdiction: 'nacion' }) });
  check('H3. jurisdicción válida se guarda', setJur.status === 200 && setJur.body.jurisdiction === 'nacion');

  // parte requerida + notificación
  const party = (await mediador.fetch(`/api/mediations/${med.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requerido', firstName: 'Carlos', lastName: 'Notificado' }) })).body;
  const plazos1 = await mediador.fetch(`/api/mediations/${med.id}/legal-tools/plazos`);
  check('H4. con jurisdicción y requerido pero sin notificación, el plazo figura como no iniciado', plazos1.body.deadline.calculable === true && plazos1.body.deadline.started === false);

  const badNotif = await mediador.fetch(`/api/mediations/${med.id}/party-notifications`, { method: 'POST', body: JSON.stringify({ partyId: party.id, medium: 'carta_documento', status: 'recibida' }) });
  check('H5. registrar como "recibida" sin fecha de recepción es rechazado (400)', badNotif.status === 400);
  const notif = await mediador.fetch(`/api/mediations/${med.id}/party-notifications`, { method: 'POST', body: JSON.stringify({ partyId: party.id, medium: 'carta_documento', status: 'recibida', receivedDate: '2026-02-03' }) });
  check('H6. registrar notificación válida funciona', notif.status === 200);
  const plazos2 = await mediador.fetch(`/api/mediations/${med.id}/legal-tools/plazos`);
  check('H7. después de la notificación, el plazo arranca con la fecha de recepción', plazos2.body.deadline.started === true && plazos2.body.deadline.computationStart === '2026-02-03');

  // prórroga y corrección manual — mediador SÍ puede
  const ext = await mediador.fetch(`/api/mediations/${med.id}/deadline-extensions`, { method: 'POST', body: JSON.stringify({ days: 15, reason: 'acuerdo de prueba', agreedDate: '2026-04-01' }) });
  check('H8. el mediador puede registrar una prórroga', ext.status === 200);
  const override = await mediador.fetch(`/api/mediations/${med.id}/deadline-start-override`, { method: 'PATCH', body: JSON.stringify({ date: '2026-03-01', reason: 'corrección de prueba' }) });
  check('H9. el mediador puede corregir la fecha base manualmente', override.status === 200);
  const auditEvents = await mediador.fetch(`/api/mediations/${med.id}/timeline`);
  const hasOverrideEvent = Array.isArray(auditEvents.body) && auditEvents.body.some((e) => e.type === 'MEDIATION_DEADLINE_START_OVERRIDE_SET');
  check('H10. la corrección manual queda auditada en el timeline (quién/cuándo, vía mediationEvents)', hasOverrideEvent);

  // aislamiento: otro mediador, otra mediación, no ve nada de esto
  const otroMediador = await login('b43-otro@test.local', 'Otro Mediador');
  const accesoAjeno = await otroMediador.fetch(`/api/mediations/${med.id}/legal-tools/plazos`);
  check('H11. aislamiento — otro mediador sin acceso a la mediación recibe 403', accesoAjeno.status === 403);
  const notifAjena = await otroMediador.fetch(`/api/mediations/${med.id}/party-notifications`, { method: 'POST', body: JSON.stringify({ partyId: party.id, medium: 'cedula', status: 'enviada' }) });
  check('H12. aislamiento — no puede registrar una notificación en una mediación ajena', notifAjena.status === 403);

  // centro de atención: requerido sin notificación en una mediación nueva
  const med2 = (await mediador.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object: 'Prueba Bloque 43 — atención' }) })).body;
  // las mediaciones nuevas arrancan en 'borrador' y el centro de atención
  // las ignora a propósito (mismo criterio que sinProximaAccion, ya
  // existente) — hay que sacarla de borrador para que mis detectores
  // puedan dispararse.
  await mediador.fetch(`/api/mediations/${med2.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'iniciada' }) });
  await mediador.fetch(`/api/mediations/${med2.id}/jurisdiction`, { method: 'PATCH', body: JSON.stringify({ jurisdiction: 'nacion' }) });
  const party2 = (await mediador.fetch(`/api/mediations/${med2.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requerido', firstName: 'Sin', lastName: 'Notificar' }) })).body;
  const attention1 = await mediador.fetch(`/api/mediations/${med2.id}/attention`);
  check('H13. centro de atención muestra "requerido sin notificación" para la mediación nueva', attention1.body.some((i) => i.type === 'requeridoSinNotificacion' && i.refId === party2.id));
  await mediador.fetch(`/api/mediations/${med2.id}/party-notifications`, { method: 'POST', body: JSON.stringify({ partyId: party2.id, medium: 'carta_documento', status: 'recibida', receivedDate: '2026-02-03' }) });
  const attention2 = await mediador.fetch(`/api/mediations/${med2.id}/attention`);
  check('H14. una vez notificado, el ítem "requerido sin notificación" desaparece del centro de atención', !attention2.body.some((i) => i.type === 'requeridoSinNotificacion' && i.refId === party2.id));

  // permisos acotados del asistente (mismo criterio que Bloque 33): puede
  // hacer trabajo administrativo (registrar una notificación) pero NO
  // puede tocar el cómputo legal del plazo (prórroga/corrección manual) —
  // reservado al mediador, igual que cerrar la mediación o registrar su
  // resultado. Paywall apagado en este server de prueba (sin
  // BILLING_ENFORCE_IN_TEST), así que invitar un asistente funciona en
  // cualquier plan — no hace falta sembrar un estudio ESTUDIO acá.
  const medAsist = (await mediador.fetch('/api/mediations', { method: 'POST', body: JSON.stringify({ type: 'civil', object: 'Prueba Bloque 43 — permisos asistente' }) })).body;
  await mediador.fetch(`/api/mediations/${medAsist.id}/jurisdiction`, { method: 'PATCH', body: JSON.stringify({ jurisdiction: 'nacion' }) });
  const partyAsist = (await mediador.fetch(`/api/mediations/${medAsist.id}/parties`, { method: 'POST', body: JSON.stringify({ role: 'requerido', firstName: 'Con', lastName: 'Asistente' }) })).body;
  // invitar requiere ser admin de un estudio — este mediador todavía no
  // tenía uno (lo venía usando "independiente" para el resto de los tests).
  const createStudio = await mediador.fetch('/api/studios', { method: 'POST', body: JSON.stringify({ name: 'Estudio B43' }) });
  check('H15b. (setup) el mediador puede crear su estudio para poder invitar un asistente', createStudio.status === 200, JSON.stringify(createStudio.body));
  const invite = await mediador.fetch('/api/studios/invitations', { method: 'POST', body: JSON.stringify({ email: 'b43-asistente@test.local', role: 'asistente' }) });
  const asistente = await login('b43-asistente@test.local', 'Asistente B43');
  await asistente.fetch(`/api/studios/invitations/${invite.body.token}/accept`, { method: 'POST' });
  await mediador.fetch(`/api/mediations/${medAsist.id}/access`, { method: 'POST', body: JSON.stringify({ userId: asistente.userId, role: 'asistente' }) });
  const notifByAsist = await asistente.fetch(`/api/mediations/${medAsist.id}/party-notifications`, { method: 'POST', body: JSON.stringify({ partyId: partyAsist.id, medium: 'carta_documento', status: 'enviada' }) });
  check('H16. el asistente SÍ puede registrar una notificación (trabajo administrativo delegable)', notifByAsist.status === 200);
  const extByAsist = await asistente.fetch(`/api/mediations/${medAsist.id}/deadline-extensions`, { method: 'POST', body: JSON.stringify({ days: 10, reason: 'x', agreedDate: '2026-01-01' }) });
  check('H17. el asistente NO puede registrar una prórroga (403, reservado al mediador)', extByAsist.status === 403);
  const overrideByAsist = await asistente.fetch(`/api/mediations/${medAsist.id}/deadline-start-override`, { method: 'PATCH', body: JSON.stringify({ date: '2026-01-01', reason: 'x' }) });
  check('H18. el asistente NO puede corregir la fecha base manualmente (403, reservado al mediador)', overrideByAsist.status === 403);

  // salud del sistema — feriados del año en curso (necesita admin de plataforma)
  const admin = await login('b43-admin@test.local', 'Admin Plataforma B43');
  const health2 = await admin.fetch('/api/admin-mediador/system/health');
  check('H15. /system/health incluye el chequeo de feriados del año en curso (admin)', health2.status === 200 && !!health2.body.plazosLegales);
}
