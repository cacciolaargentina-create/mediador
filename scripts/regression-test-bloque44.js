// scripts/regression-test-bloque44.js
// Bloque 44 (sincronización de audiencias con Google Calendar) — tests
// directos de calendarSync.js, SIN pegarle nunca a la API real de Google.
// Mismo criterio que regression-test-bloque29-engine.js: se "monkey-patchea"
// videoProviders/googleMeetProvider.js (mismo módulo cacheado que usa
// calendarSync.js) para simular cuenta conectada/desconectada y respuestas
// de Calendar, sin tocar red externa.
//
// Corre standalone contra una DB descartable propia.

const path = require('path');
process.env.SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'test-b44.sqlite');

const { nanoid } = require('nanoid');
const { getDB, commit } = require('../db');
const googleMeet = require('../videoProviders/googleMeetProvider');
const calendarSync = require('../calendarSync');

let passed = 0, failed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log(`  OK   ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}

function makeMediation(db, overrides = {}) {
  const now = Date.now();
  const m = { id: nanoid(), code: `TEST-${nanoid(6)}`, mediatorUserId: nanoid(), channelId: null, type: null, object: 'Test', description: null, status: 'iniciada', nextActionText: null, nextActionResponsibleType: null, nextActionResponsibleId: null, nextActionDueDate: null, closedAt: null, closedResult: null, closedNotes: null, createdAt: now, ...overrides };
  db.mediations.push(m);
  return m;
}
function makeHearing(overrides = {}) {
  return {
    id: nanoid(), date: '2027-03-10', startTime: '10:00', endTime: null, modality: 'presencial',
    location: null, meetingUrl: null, videoProvider: null, meetingId: null,
    calendarSyncEventId: null, calendarSyncStatus: null, calendarSyncUpdatedAt: null,
    ...overrides,
  };
}

(async function main() {
  console.log('Bloque 44 (sincronización con Google Calendar) — tests directos, sin red externa\n');
  const db = getDB();

  // ==== schema: las columnas nuevas existen y arrancan en null ====
  const h0 = makeHearing();
  check('hearing nuevo arranca con calendarSync* en null', h0.calendarSyncEventId === null && h0.calendarSyncStatus === null, JSON.stringify(h0));

  // ==== mediador SIN cuenta de Google conectada: nunca bloquea, nunca llama a la API ====
  const originalGetAccount = googleMeet.getAccount;
  const originalCreateSyncEvent = googleMeet.createSyncEvent;
  const originalUpdateSyncEvent = googleMeet.updateSyncEvent;
  const originalDeleteSyncEvent = googleMeet.deleteSyncEvent;
  let calls = [];
  googleMeet.getAccount = () => null; // nadie conectó Google
  googleMeet.createSyncEvent = async () => { calls.push('create'); return { eventId: 'should-not-happen' }; };

  const mNoAccount = makeMediation(db);
  const hNoAccount = makeHearing();
  const r1 = await calendarSync.syncHearingToCalendar(db, { hearing: hNoAccount, mediation: mNoAccount, actorId: nanoid() });
  check('sin cuenta conectada: syncHearingToCalendar no falla, se salta', r1.ok === true && r1.skipped === true);
  check('sin cuenta conectada: nunca llama a createSyncEvent', calls.length === 0);
  check('sin cuenta conectada: calendarSyncEventId sigue null', hNoAccount.calendarSyncEventId === null);

  // ==== hearing con videoProvider google_meet: se salta siempre (ya tiene su propio evento de Calendar vía meetingId) ====
  calls = [];
  googleMeet.getAccount = () => ({ status: 'conectado' }); // ahora SÍ hay cuenta — igual debe saltarse por el provider
  const mGMeet = makeMediation(db);
  const hGMeet = makeHearing({ videoProvider: 'google_meet', meetingId: 'evt-meet-123' });
  const r2 = await calendarSync.syncHearingToCalendar(db, { hearing: hGMeet, mediation: mGMeet, actorId: nanoid() });
  check('videoProvider=google_meet: se salta (evita duplicar el evento)', r2.ok === true && r2.skipped === true);
  check('videoProvider=google_meet: nunca llama a createSyncEvent', calls.length === 0);

  // ==== creación real: cuenta conectada + hearing sin google_meet + sin calendarSyncEventId -> crea ====
  googleMeet.createSyncEvent = async (_db, { hearing, mediation }) => {
    calls.push({ fn: 'create', mediationCode: mediation.code, hearingId: hearing.id });
    return { eventId: 'evt-created-1' };
  };
  const mCreate = makeMediation(db);
  const hCreate = makeHearing({ modality: 'presencial', location: 'Estudio jurídico' });
  calls = [];
  const r3 = await calendarSync.syncHearingToCalendar(db, { hearing: hCreate, mediation: mCreate, actorId: nanoid() });
  check('creación: syncHearingToCalendar llama a createSyncEvent (no update)', calls.length === 1 && calls[0].fn === 'create');
  check('creación: guarda el eventId devuelto', hCreate.calendarSyncEventId === 'evt-created-1');
  check('creación: status queda sincronizado', hCreate.calendarSyncStatus === 'sincronizado');
  check('creación: funciona para modalidad presencial (no solo videollamada)', r3.ok === true);

  // ==== actualización: ya tenía calendarSyncEventId -> llama a update, no a create ====
  googleMeet.updateSyncEvent = async (_db, { hearing }) => {
    calls.push({ fn: 'update', calendarSyncEventId: hearing.calendarSyncEventId });
    return { eventId: hearing.calendarSyncEventId };
  };
  calls = [];
  hCreate.date = '2027-03-15'; // se reprograma
  const r4 = await calendarSync.syncHearingToCalendar(db, { hearing: hCreate, mediation: mCreate, actorId: nanoid() });
  check('reprogramación: llama a updateSyncEvent (ya existía el evento)', calls.length === 1 && calls[0].fn === 'update');
  check('reprogramación: conserva el mismo eventId', hCreate.calendarSyncEventId === 'evt-created-1');
  check('reprogramación: ok', r4.ok === true);

  // ==== falla de la API externa: nunca lanza, marca error, no bloquea ====
  googleMeet.createSyncEvent = async () => { throw new Error('Google Calendar rechazó la sincronización'); };
  const mFail = makeMediation(db);
  const hFail = makeHearing();
  let threw = false;
  let r5;
  try { r5 = await calendarSync.syncHearingToCalendar(db, { hearing: hFail, mediation: mFail, actorId: nanoid() }); }
  catch (e) { threw = true; }
  check('falla externa: syncHearingToCalendar NUNCA lanza', threw === false);
  check('falla externa: result.ok === false', r5 && r5.ok === false);
  check('falla externa: calendarSyncStatus queda en error', hFail.calendarSyncStatus === 'error');
  const errEvent = db.mediationEvents.find((e) => e.entityId === hFail.id && e.type === 'CALENDAR_SYNC_ERROR');
  check('falla externa: queda registrado en el timeline de la mediación', !!errEvent);

  // ==== eliminación: cancela la audiencia -> borra el evento y limpia los campos ====
  googleMeet.deleteSyncEvent = async (_db, { hearing }) => { calls.push({ fn: 'delete', eventId: hearing.calendarSyncEventId }); };
  calls = [];
  const r6 = await calendarSync.removeHearingFromCalendar(db, { hearing: hCreate, mediation: mCreate, actorId: nanoid() });
  check('cancelación: llama a deleteSyncEvent', calls.length === 1 && calls[0].fn === 'delete' && calls[0].eventId === 'evt-created-1');
  check('cancelación: limpia calendarSyncEventId', hCreate.calendarSyncEventId === null);
  check('cancelación: limpia calendarSyncStatus', hCreate.calendarSyncStatus === null);
  check('cancelación: ok', r6.ok === true);

  // ==== eliminación sin evento sincronizado: se salta, nunca llama a deleteSyncEvent ====
  calls = [];
  const hNeverSynced = makeHearing();
  const r7 = await calendarSync.removeHearingFromCalendar(db, { hearing: hNeverSynced, mediation: mCreate, actorId: nanoid() });
  check('cancelación sin sync previo: se salta', r7.ok === true && r7.skipped === true && calls.length === 0);

  // ==== restaura el módulo real — nunca dejar el monkey-patch filtrado a otro test ====
  googleMeet.getAccount = originalGetAccount;
  googleMeet.createSyncEvent = originalCreateSyncEvent;
  googleMeet.updateSyncEvent = originalUpdateSyncEvent;
  googleMeet.deleteSyncEvent = originalDeleteSyncEvent;

  await commit();

  console.log(`\n${passed} OK, ${failed} FAIL de ${passed + failed}`);
  if (failed) { console.log('\nFallaron:'); failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
})().catch((e) => { console.error('Error ejecutando la regresión:', e); process.exit(1); });
